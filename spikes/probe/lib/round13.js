/**
 * dsh-chapters Phase 0b, round 13 — does the host's AUTOMATIC path dispatch
 * through a plugin subclass, on the real trigger?
 *
 * Round 12 proved the seam (manual compactNow, durable events, /compact
 * mounting). This round exercises the part the MVP rides on: the base engine's
 * `_registerAutomaticCompaction()` listener at `agent/pre-step` calling
 * `this.compactIfNeeded` → `compactRegion` → `summarize()` — dynamically
 * dispatched into OUR override — for an agent whose fiber the plugin fiber
 * merely observes (events bubbling from a deeper fiber to a host-plane
 * listener).
 *
 * Setup facts established this round:
 *  - `compactIfNeeded` no-ops until `session.requestHeader()` exists
 *    (index.ts:260 routedTarget undefined → null): a fresh session's FIRST
 *    pre-step cannot compact. So turn 1 only establishes a routed request;
 *    turn 2's pre-step is where pressure fires — before any provider call for
 *    that step, with zero summarization tokens (our deterministic summarize).
 *  - Row config `thresholdRatio: 0.001, retainRatio: 0` makes ~500-token probe
 *    sessions qualify. validateRatioRetention only requires retainRatio <
 *    thresholdRatio; the retry loop (compactionRetries default 1) will then
 *    attempt once more and fail the shrink floor — the same path a real
 *    over-threshold-but-incompressible session takes, so watching it degrade
 *    gracefully (warn + `next()`, turn continues) is itself the measurement.
 *
 * Zero-summarization proof is architectural (our summarize imports no llm),
 * plus: the `compaction/summary` event must carry no `usage`, and the total
 * provider usage for the round must equal 2 conversation turns and nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-13.json')
const report = { round: 13, startedAt: new Date().toISOString(), probes: [], notes: [], steps: [] }
const record = (name, ok, details = {}) => report.probes.push({ name, ok, ...details })

const SENTINEL = '<<CHAPTERS-PROBE-SUMMARY>>'
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten padding words follow so each seeded message carries a few dozen tokens of body text.'

const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: {
    id: randomUUID(), role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }],
  },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

const usageOf = (agent) => (agent.session.snapshotEvents?.() ?? [])
  .filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)

async function driveTurn(agent, text, label) {
  const session = agent.session
  const turns = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
  const before = turns()
  const usages = usageOf(agent)
  const beforeUsage = usages.length
  agent.steer(userMsg(text))
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline && turns() === before) await new Promise((r) => setTimeout(r, 400))
  const added = usageOf(agent).slice(beforeUsage)
  const last = added.at(-1) ?? null
  const total = last ? (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) : null
  const entry = { label, turnEnded: turns() > before, lastUsage: last, totalPrompt: total, ended: Date.now() }
  report.steps.push(entry)
  return entry
}

export default class ChaptersProbeEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'agents', 'commands', 'sessionQuery']

  constructor(ctx, config) {
    super(ctx, config)
    this.summarizeCalls = []
    this.pressureCalls = []
    setTimeout(() => { this.runProbe().catch((error) => {
      report.fatal = String(error?.stack ?? error)
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(1)
    }) }, 4000)
  }

  async summarize(input, agent, signal) {
    const region = input.messages.filter((m) => m.role !== 'system')
    this.summarizeCalls.push({ at: Date.now(), region: region.length, session: agent?.session?.id })
    return {
      summary: [{ type: 'text', text: `${SENTINEL} # Chapters index\n1. Auto-path probe chapter over ${region.length} messages.` }],
      provider: 'dsh-chapters-probe',
      model: 'deterministic',
    }
  }

  async compactIfNeeded(agent, trigger, signal) {
    this.pressureCalls.push({ at: Date.now(), trigger, session: agent?.session?.id })
    return await super.compactIfNeeded(agent, trigger, signal)
  }

  async runProbe() {
    const ctx = this.ctx
    const cwd = process.cwd()

    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('agentDefaultModel selection present', Boolean(selection), { selection })

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}
    const sessionId = `p13-${randomUUID()}`
    const seed = Array.from({ length: 6 }, (_, seq) => seedUser(seq))
    const handle = await ctx.agents.create({
      sessionId, seed, inheritedEventCount: 0,
      meta: { cwd, isSeeded: false },
      ...(selection ? { agentOptions: selection } : {}),
    })
    await workspace?.attachSession?.(sessionId)
    const agent = handle.agent
    const session = agent.session

    // Snapshot helper: durable events of compaction interest.
    const compactionEvents = () => (session.snapshotEvents?.() ?? [])
      .filter((e) => e.type.startsWith('compaction/'))
      .map((e) => ({ seq: e.seq, type: e.type, turn: e.data?.turn ?? null, hasUsage: e.data?.usage !== undefined }))

    // ---- turn 1: establishes the routed request; pre-step must NOT compact
    const t1 = await driveTurn(agent, 'Reply with exactly: P13A. No explanation.', 'turn 1 (establish route)')
    record('turn 1 completed', t1.turnEnded, { totalPrompt: t1.totalPrompt })
    record('no compaction attempted on turn 1 pre-step (no routed target yet)',
      compactionEvents().length === 0, { events: compactionEvents(), pressureCalls: this.pressureCalls.length })

    const eventsBefore = session.seq
    const nodesBefore = [...session.surface.nodes]
    const pressureBefore = this.pressureCalls.length
    const summarizeBefore = this.summarizeCalls.length

    // ---- turn 2: pre-step pressure now qualifies; our override must run
    const t2 = await driveTurn(agent, 'Reply with exactly: P13B. No explanation.', 'turn 2 (pressure pre-step)')
    record('turn 2 completed despite compaction churn', t2.turnEnded, {
      totalPrompt: t2.totalPrompt, ended: t2.ended, lastUsage: t2.lastUsage,
    })
    record('automatic pre-step reached OUR compactIfNeeded',
      this.pressureCalls.length > pressureBefore, { calls: this.pressureCalls })
    record('automatic path dispatched into OUR summarize()',
      this.summarizeCalls.length > summarizeBefore, { calls: this.summarizeCalls })

    const events = compactionEvents()
    record('durable compaction records landed mid-turn from the automatic path',
      events.some((e) => e.type === 'compaction/start' && e.turn !== null && e.seq > 6)
      && events.some((e) => e.type === 'compaction/summary')
      && events.some((e) => e.type === 'compaction/end'), { events })
    const summaryEvent = (session.snapshotEvents?.() ?? []).find((e) => e.type === 'compaction/summary')
    record('automatic summary event carries no usage (zero tokens)',
      summaryEvent?.data?.usage === undefined, {
        provider: summaryEvent?.data?.provider, model: summaryEvent?.data?.model,
        shadowedSeqs: summaryEvent?.data?.shadowedSeqs,
      })
    record('durable log grew; pre-compaction surface nodes still in log',
      session.seq > eventsBefore && nodesBefore.every((seq) => session.eventAt(seq) !== undefined), {
        eventsBefore, eventsAfter: session.seq, surfaceNodes: session.surface.nodes.length,
      })
    record('turn 2 request ran against the COMPACTED surface (prompt shrank mid-session)',
      t2.totalPrompt !== null && t1.totalPrompt !== null && t2.totalPrompt < t1.totalPrompt, {
        turn1Prompt: t1.totalPrompt, turn2Prompt: t2.totalPrompt,
        note: 'without the pre-step compaction, turn 2’s prompt strictly contains turn 1’s',
      })

    // ---- was a second (realm) engine composed for this session?
    try {
      const inv = ctx.get('pluginInventory') ?? ctx.get('plugin-inventory')
      const rows = inv?.entries?.() ?? inv?.list?.() ?? null
      const compaction = rows ? rows.filter((r) => String(r?.name ?? '').includes('compaction')) : null
      record('plugin inventory of compaction mounts', compaction !== null, {
        methods: inv ? Object.getOwnPropertyNames(Object.getPrototypeOf(inv)).sort() : null,
        compaction: compaction?.map((r) => ({ id: r?.id, name: r?.name, disabled: r?.disabled })) ?? null,
      })
    } catch (error) {
      record('plugin inventory of compaction mounts', false, { message: String(error?.message ?? error) })
    }

    report.notes.push(`total provider usages recorded: ${usageOf(agent).length}`)
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
}
