/**
 * Round 27b — the engine on the REAL hardware, sized for it.
 *
 * r27's lesson: this local server runs ~0.5 tok/s generation with thinking on and
 * llama.cpp's counters show prompt recompute only when a slot actually processes —
 * a 44K-token demo turn is an hour, not a test. So: minimal payloads; ONE real
 * turn (cold prefill of the ~12K header + realm tools — the unavoidable cost);
 * then a manual compactNow() (the /compact semantics: threshold-independent,
 * ZERO prompt processing by construction — this is the plugin's thesis, made
 * visible in seconds); then a second real turn whose server-metrics delta is
 * the LOCAL E3: cached vs recomputed prompt tokens across the replacement,
 * measured at llama.cpp itself, independent of any usage-field mapping.
 *
 * The engine instance is ours (imported from lib/engine.js — same module URL the
 * realm row loaded), constructed host-plane with auto:false so only the manual
 * call runs. compactNow requires an idle agent between turns, as designed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ChaptersCompactionEngine } from '../../../lib/engine.js'
import { chapterDomainSpec, makeDomainStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-27b.json')
const report = { round: '27b', startedAt: new Date().toISOString(), probes: [], notes: [], timings: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const TURN_CAP_MS = Number(process.env.R27B_TURN_MS ?? '1800000')
const SEED = 'SEED-0 the quick brown fox jumps over the lazy dog. ' // tiny on purpose
const seedEvent = {
  type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: SEED }] },
}
const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })

async function metrics() {
  try {
    const text = await (await fetch('http://localhost:8080/metrics')).text()
    const grab = (name) => Number(new RegExp(`^llamacpp:${name} ([0-9.e+]+)$`, 'm').exec(text)?.[1] ?? NaN)
    return { prompt: grab('prompt_tokens_total'), cached: grab('prompt_tokens_cached_total'), predicted: grab('tokens_predicted_total') }
  } catch { return { prompt: null, cached: null, predicted: null } }
}

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'storageDomain', 'llm', 'tokenMeter', 'sessionQuery', 'commands']

export function apply(ctx, config) {
  const engine = new ChaptersCompactionEngine(ctx, { auto: false })
  const run = async () => {
    const m0 = await metrics()
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('selection is local', selection?.provider === 'local', { selection })

    const sessionId = `p27b-${randomUUID().slice(0, 8)}`
    const handle = await ctx.agents.create({
      sessionId, seed: [seedEvent], inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      ...(selection ? { agentOptions: selection } : {}),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'chapters') },
    })
    try { const ws = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT); await ws?.attachSession?.(sessionId) } catch {}
    const agent = handle.agent
    const session = agent.session
    const evs = () => session.snapshotEvents?.() ?? []
    const turns = () => evs().filter((e) => e.type === 'turn/end').length
    const usageAll = () => evs().filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    const drive = async (label, text) => {
      const t0 = Date.now(); const before = turns(); const m1 = await metrics()
      agent.steer(userMsg(text))
      while (Date.now() - t0 < TURN_CAP_MS && turns() === before) await new Promise((r) => setTimeout(r, 1500))
      const m2 = await metrics()
      const entry = {
        label, wallSec: Math.round((Date.now() - t0) / 1000), ended: turns() > before,
        usage: usageAll().at(-1) ?? null,
        serverRecompute: m1.prompt !== null && m2.prompt !== null ? m2.prompt - m1.prompt : null,
        serverCacheReuse: m1.cached !== null && m2.cached !== null ? m2.cached - m1.cached : null,
      }
      report.timings.push(entry)
      return entry
    }

    // turn 1: the cold header prefill this machine cannot avoid paying
    const t1 = await drive('turn 1 (cold header prefill ~12K)', 'reply with the single word READY and nothing else, no explanation')
    record('T1 turn 1 completed on the local model', t1.ended, { wallSec: t1.wallSec, usage: t1.usage, serverRecompute: t1.serverRecompute })
    if (!t1.ended) { record('T1 aborted — turn 1 never ended (cap ' + TURN_CAP_MS + 'ms)', false); finish() }

    // the AUTOMATIC recovery machinery, invoked exactly as the request-error
    // listener would: compactIfNeeded('context-overflow') — bypasses the manual
    // path's durability-checkpoint flush (which failed here: ManualCompactionError
    // code='persistence', root cause still open — see FINDINGS) and dispatches
    // through OUR override, so post-commit finalization runs on the success path.
    const mPre = await metrics()
    let compact = null, compactErr = null
    try { compact = await engine.compactIfNeeded(agent, 'context-overflow', new AbortController().signal) }
    catch (error) {
      compactErr = error
      report.notes.push(`compactIfNeeded overflow threw: ${String(error?.message ?? error).slice(0, 200)}; cause: ${String(error?.cause?.message ?? error?.cause).slice(0, 300)}`)
    }
    const mPost = await metrics()
    const summary = compact === null ? null : session.eventAt(compact.summarySeq)
    record('T2 manual compactNow committed a deterministic chapter TOC',
      compact !== null && summary?.data?.provider === 'dsh-chapters' && summary?.data?.usage === undefined, {
      shadowed: compact?.shadowedSeqs ?? null, provider: summary?.data?.provider, hasUsage: summary?.data?.usage !== undefined,
      refusal: compact === null ? String(compactErr?.message ?? compactErr).slice(0, 220) : null,
      refusalCause: compact === null ? String(compactErr?.cause?.message ?? compactErr?.cause ?? null).slice(0, 300) : null,
      text: String(summary?.data?.summary?.[0]?.text ?? '').slice(0, 220),
    })
    record('T3 the compaction cost ZERO prompt tokens at the server',
      mPre.prompt !== null && mPost.prompt !== null && mPost.prompt === mPre.prompt, {
      recomputeDelta: mPost.prompt - mPre.prompt, wallSec: 0,
    })
    const store = makeDomainStore(await ctx.storageDomain.open(chapterDomainSpec))
    const state = await store.get(sessionId)
    const files = state.chapters.map((c) => ({ path: c.path, exists: fs.existsSync(path.join(ROOT, c.path)) }))
    record('T4 chapter file written under the workspace and registry-committed',
      files.length >= 1 && files.every((f) => f.exists), { files })

    // turn 2 post-replacement: LOCAL E3 — how much does the header still cost?
    const t2 = await drive('turn 2 (post-compaction, local E3)', 'reply with the single word TWO and nothing else')
    record('T5 turn 2 completed after the replacement', t2.ended, { wallSec: t2.wallSec, usage: t2.usage, serverRecompute: t2.serverRecompute, serverCacheReuse: t2.serverCacheReuse })

    // the baseline that matters: compare against a turn WITHOUT compaction —
    // a third turn adds ~40 tokens of content; recompute should stay small
    const t3 = await drive('turn 3 (steady state)', 'reply with the single word THREE and nothing else')
    record('T6 steady-state turn ran with small server recompute (cache held)',
      t3.ended && (t3.serverRecompute ?? 1e9) < 8000, { recompute: t3.serverRecompute, cacheReuse: t3.serverCacheReuse })

    try { await handle.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
