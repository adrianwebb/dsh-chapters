/**
 * Round 27 — the REAL target: Local qwen3.8-flash-next @ 32K, dev profile.
 *
 * Part A (always, free): configuration truth — agentDefaultModel resolves to
 * local/qwen3.8-flash-next, resolveModelInfo reports contextWindow 32768
 * (the ONLY live-config delta from the user's real settings), the roster's
 * default preset is 'chapters' (settings.yaml + row patch), and our plugin's
 * realm is what a default session composes.
 *
 * Part B (DSH_R27_TURNS=1, slow): the feature the user asked for, first
 * sentence. A session seeded ~24K tokens OVER the window drives turn 1; the
 * provider should reject with a context overflow; the base engine's
 * `agent/request-error` recovery must route into OUR deterministic summarize,
 * commit a chapter + TOC checkpoint with ZERO summarization tokens, and the
 * retry should complete. Wall-clock recorded — slow prefill is the enemy this
 * plugin exists to shorten. If the error does not map to the overflow code,
 * that is itself the finding (adapter mapping), and Part B degrades to
 * recording the raw failure verbatim.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-27.json')
const report = { round: 27, startedAt: new Date().toISOString(), probes: [], notes: [], timings: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const CHUNK = 'LOCAL-PAYLOAD alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${CHUNK.repeat(9)}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'llm', 'storageDomain', 'sessionQuery', 'tokenMeter']

export function apply(ctx, config) {
  const run = async () => {
    // ---- Part A: configuration truth
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('A1 default selection is the Local model', selection?.provider === 'local'
      && selection?.model === 'qwen3.8-flash-next', { selection })

    let info
    try { info = await ctx.get('llm').resolveModelInfo('local', 'qwen3.8-flash-next', new AbortController().signal) } catch (e) { info = { error: String(e?.message ?? e) } }
    const win = info?.context?.contextWindow ?? null
    record('A2 resolveModelInfo reports the 32K dev window', win === 32768, { context: info?.context, err: info?.error ?? null })

    let defaultId = null
    try { defaultId = (await ctx.agentPresets.resolve(undefined)).id } catch (e) { defaultId = `error:${String(e?.message ?? e)}` }
    record('A3 default preset is chapters', defaultId === 'chapters', { defaultId })

    const roster = (await ctx.agentPresets.list()).map((p) => `${p.id}:${p.trust ?? '?'}`)
    record('A4 roster carries chapters (user root) and no probe litter', roster.some((s) => s === 'chapters:user'), { roster })

    if (process.env.DSH_R27_TURNS !== '1') {
      report.notes.push('Part B skipped (DSH_R27_TURNS unset) — configuration-only run')
      finish()
      return
    }

    // ---- Part B: overflow -> deterministic recovery -> retry (slow local)
    const sessionId = `p27-${randomUUID().slice(0, 8)}`
    const t0 = Date.now()
    const handle = await ctx.agents.create({
      sessionId,
      // ~60 seeds x ~800 chars ~= 48K chars ~= 12K tokens of durable seed... plus the
      // header (~11-13K measured r16) we want CLEARLY over 32K to force provider rejection.
      seed: Array.from({ length: 60 }, (_, seq) => seedUser(seq)),
      inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      ...(selection ? { agentOptions: selection } : {}),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'chapters') },
    })
    try {
      const ws = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT)
      await ws?.attachSession?.(sessionId)
    } catch {}
    const agent = handle.agent
    const session = agent.session
    const evs = () => session.snapshotEvents?.() ?? []
    const compactions = () => evs().filter((e) => e.type === 'compaction/summary')
    const turns = () => evs().filter((e) => e.type === 'turn/end').length
    const usageOf = () => evs().filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    const reasonOf = () => JSON.stringify([...evs()].reverse().find((e) => e.type === 'turn/end')?.data?.reason ?? null)

    const seedTokens = Math.round(evs().filter((e) => e.type === 'user/message' && e.seq < 60)
      .reduce((n, e) => n + JSON.stringify(e.data).length, 0) / 4)
    report.notes.push(`seed content ~${seedTokens} est tokens on top of the header (window 32768)`)

    agent.steer(userMsg('Without reading anything or using tools: reply with exactly RECOVERED-27.'))
    const t1 = Date.now()
    while (Date.now() - t1 < 1_500_000 && turns() === 0) await new Promise((r) => setTimeout(r, 1000))
    const wallT1 = ((Date.now() - t1) / 1000).toFixed(0)
    const c = compactions()
    report.timings.push({ step: 'turn 1 (expected overflow + deterministic recovery)', wallSec: +wallT1, turnEnded: turns() > 0, reason: reasonOf(), compactions: c.length })

    record('B1 provider overflow triggered the automatic compaction path', c.length >= 1, {
      compactionProviders: c.map((e) => e.data?.provider),
      turnReason: reasonOf(), wallSec: +wallT1,
      note: c.length === 0 ? 'no compaction — provider error mapping or threshold question; raw reason recorded' : null,
    })
    record('B2 the recovery summary is OURS, with zero summarization tokens',
      c.length >= 1 && c.every((e) => e.data?.provider === 'dsh-chapters' && e.data?.usage === undefined), {
      providers: c.map((e) => e.data?.provider), hasUsage: c.map((e) => e.data?.usage !== undefined),
    })
    const files = c.length >= 1
      ? fs.existsSync(path.join(ROOT, `.dsh-chapters/${sessionId}`)) ? fs.readdirSync(path.join(ROOT, `.dsh-chapters/${sessionId}/chapters`)) : []
      : []
    record('B3 chapters were written to the workspace store', files.length > 0, { files })
    record('B4 the turn ultimately completed on the slow local model', turns() > 0 && /"kind":"completed"/.test(reasonOf()), {
      reason: reasonOf(), wallSec: +wallT1, usage: usageOf().at(-1) ?? null,
    })

    // turn 2: the compacted session keeps working with a small head
    const before2 = turns()
    agent.steer(userMsg('reply with exactly TWO-27'))
    const t2 = Date.now()
    while (Date.now() - t2 < 1_500_000 && turns() === before2) await new Promise((r) => setTimeout(r, 1000))
    const u2 = usageOf().at(-1) ?? null
    report.timings.push({
      step: 'turn 2 (post-compaction head)', wallSec: +(((Date.now() - t2) / 1000).toFixed(0)),
      input: u2?.inputTokens ?? null, cacheRead: u2?.cacheReadTokens ?? 0, total: u2 ? (u2.inputTokens ?? 0) + (u2.cacheReadTokens ?? 0) : null,
    })
    record('B5 post-compaction turn ran with a materially smaller head than 32K',
      turns() > before2 && u2 !== null && (u2.inputTokens ?? 0) + (u2.cacheReadTokens ?? 0) < 30000, { usage: u2 })

    report.notes.push(`total wall: ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    try { await handle.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
