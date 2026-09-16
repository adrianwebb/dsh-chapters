/**
 * Round 28 — the honest local-hardware run, with the acquire fix in place.
 *
 * Sequence (NO side traffic to the shared slot; /metrics reads are out-of-band):
 *   turn 1: ~11K tokens of seeded conversation -> cold full prefill (the pain)
 *   manual compactNow through OUR engine (product instance semantics: acquire store,
 *     sessions injected, idle-retry for the title race): expect 0 server tokens
 *   turn 2 + turn 3: the LOCAL E3 — after a head-position replacement, how much of
 *     the ~14K header does llama.cpp actually reuse, and what does one turn cost?
 * Every turn's recompute/cacheReuse is measured at the server's own counters.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ChaptersCompactionEngine } from '../../../lib/engine.js'
import { acquireChapterStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-28.json')
const report = { round: 28, startedAt: new Date().toISOString(), probes: [], notes: [], timings: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const TURN_CAP_MS = Number(process.env.R28_TURN_MS ?? '2400000') // 40 min: this machine is the slow one
const PARA = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PARA.repeat(3)}` }] },
})
const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })

async function metrics() {
  try {
    const text = await (await fetch('http://localhost:8080/metrics')).text()
    const grab = (n) => Number(new RegExp(`^llamacpp:${n} ([0-9.e+]+)$`, 'm').exec(text)?.[1] ?? NaN)
    return { prompt: grab('prompt_tokens_total'), cached: grab('prompt_tokens_cached_total'), predicted: grab('tokens_predicted_total') }
  } catch { return { prompt: null, cached: null, predicted: null } }
}

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'storageDomain', 'llm', 'tokenMeter', 'sessionQuery', 'commands', 'sessions']

export function apply(ctx, config) {
  const engine = new ChaptersCompactionEngine(ctx, { auto: false, thresholdRatio: 0.9 })
  const run = async () => {
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('selection local', selection?.provider === 'local')
    const handle = await ctx.agents.create({
      sessionId: `p28`, seed: Array.from({ length: 12 }, (_, i) => seedUser(i)),
      inheritedEventCount: 0, meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      ...(selection ? { agentOptions: selection } : {}),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'chapters') },
    })
    try { const ws = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT); await ws?.attachSession?.('p28') } catch {}
    const agent = handle.agent
    const session = agent.session
    const evs = () => session.snapshotEvents?.() ?? []
    const turns = () => evs().filter((e) => e.type === 'turn/end').length
    const usageAll = () => evs().filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    const drive = async (label, text) => {
      const t0 = Date.now(); const before = turns(); const m1 = await metrics()
      agent.steer(userMsg(text))
      while (Date.now() - t0 < TURN_CAP_MS && turns() === before) await new Promise((r) => setTimeout(r, 2000))
      const m2 = await metrics()
      const entry = { label, wallSec: Math.round((Date.now() - t0) / 1000), ended: turns() > before,
        usage: usageAll().at(-1) ?? null,
        recompute: m1.prompt !== null && m2.prompt !== null ? m2.prompt - m1.prompt : null,
        cacheReuse: m1.cached !== null && m2.cached !== null ? m2.cached - m1.cached : null }
      report.timings.push(entry)
      return entry
    }

    const t1 = await drive('turn 1 (cold: header + 11K of content)', 'read the seeds and reply with exactly ONE-28, no analysis')
    record('T1 turn 1 completed', t1.ended && t1.recompute !== null && t1.recompute > 5000, { ...t1 })
    if (!t1.ended) { record('T1 aborted mid-turn', false, t1); finish() }

    // manual compaction — product semantics: idle agent, acquire store, our summarize.
    const mPre = await metrics()
    let compact = null, compactErr = null
    for (let attempt = 0; attempt < 6 && compact === null; attempt += 1) {
      try { compact = await engine.compactNow(agent, new AbortController().signal); break }
      catch (error) {
        compactErr = error
        report.notes.push(`compactNow attempt ${attempt + 1}: ${String(error?.message ?? error).slice(0, 150)}`)
        if (!/idle|busy/.test(String(error?.message ?? error))) break
        await new Promise((r) => setTimeout(r, 25000))
      }
    }
    const mPost = await metrics()
    const summary = compact === null ? null : session.eventAt(compact.summarySeq)
    record('T2 manual compactNow committed with OUR deterministic summarize',
      compact !== null && summary?.data?.provider === 'dsh-chapters' && summary?.data?.usage === undefined, {
      shadowed: compact?.shadowedSeqs ?? null, refusal: compact === null ? String(compactErr?.message ?? compactErr) : null,
      tocHead: String(summary?.data?.summary?.[0]?.text ?? '').slice(0, 200),
    })
    record('T3 the compaction cost ZERO prompt tokens at llama.cpp', compact !== null
      && mPre.prompt !== null && mPost.prompt !== null && mPost.prompt === mPre.prompt, {
      recomputeDelta: mPost.prompt !== null && mPre.prompt !== null ? mPost.prompt - mPre.prompt : null,
    })
    const { store } = await acquireChapterStore(ctx.storageDomain)
    const state = await store.get('p28')
    const files = state.chapters.map((c) => ({ path: c.path, hasSeeds: String(fs.readFileSync(path.join(ROOT, c.path), 'utf8') ?? '').includes('SEED-0') }))
    record('T4 chapters on disk, verbatim (SEED-0 inside), registry committed', state.chapters.length >= 1 && files.every((f) => f.hasSeeds), { files })

    const t2 = await drive('turn 2 (first turn AFTER the replacement)', 'reply with exactly TWO-28')
    record('T5 turn 2 completed post-replacement', t2.ended, { ...t2 })
    const t3 = await drive('turn 3 (steady state after compaction)', 'reply with exactly THREE-28')
    record('T6 turn 3 recompute is small (window now has room)', t3.ended && (t3.recompute ?? 1e9) < 5000, { ...t3 })

    report.notes.push(`configured window 32768; turn1 recompute ${t1.recompute}; post-compact turn3 recompute ${t3.recompute}`)
    try { await handle.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
