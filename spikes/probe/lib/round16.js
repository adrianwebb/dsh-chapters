/**
 * dsh-chapters Phase 0b, round 16 — compose a continuation with its preset realm.
 *
 * Rounds 14/15 established: `meta.agentPreset` alone records the id and
 * NOTHING more — no preset plugins mount (serviceForAgent undefined even
 * mid-step), and a `agents.create` child's first request cost 974 tokens,
 * i.e. no system header and no tool schemas. A tool-less child cannot
 * "reload chapters with `read`" — this round verifies the fix the
 * session-controller uses (api/session-controller/src/agent.ts:377-390):
 * `setup: async (agentCtx) => ctx.get('agentPresets').mount(agentCtx, id)`
 * passed to agents.create. Assertions:
 *
 *   1. creation succeeds with a setup-mount; realm engine resolvable via
 *      serviceForAgent IMMEDIATELY (setup completes pre-publication) and its
 *      instance is NOT the host probe (realm-vs-host coexistence, live).
 *   2. the child's first request carries the real header: requestHeader() has
 *      many tools; first-turn inputTokens materially above the bare child's
 *      974 — the production shape behind the "~header + TOC ≈ 8K" projection.
 *   3. manual compaction of a header-carrying session: our summarize receives
 *      the SYSTEM HEAD as messages[0] (region.ts:545 buildSummarizationInput)
 *      and the transaction still commits with zero usage.
 *
 * One tiny real turn (~10K incl. header). Zero summarization tokens by design.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { serviceForAgent } from '@deepseek-ai/dsh-agent-presets'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-16.json')
const report = { round: 16, startedAt: new Date().toISOString(), probes: [], notes: [], steps: [] }
const record = (name, ok, details = {}) => report.probes.push({ name, ok, ...details })

const SENTINEL = '<<CHAPTERS-PROBE-SUMMARY>>'
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten padding words follow so each seeded message carries a few dozen tokens of body text.'
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

export default class ChaptersProbeEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'agents', 'commands', 'sessionQuery', 'agentPresets']

  constructor(ctx, config) {
    super(ctx, config)
    this.p16Marker = 'p16-host-instance'
    this.summarizeCalls = []
    setTimeout(() => { this.runProbe().catch((error) => {
      report.fatal = String(error?.stack ?? error)
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(1)
    }) }, 4000)
  }

  async summarize(input, agent, signal) {
    const hasSystem = input.messages[0]?.role === 'system'
    const region = input.messages.filter((m) => m.role !== 'system')
    this.summarizeCalls.push({ hasSystem, total: input.messages.length, region: region.length, session: agent?.session?.id, tools: input.tools?.length ?? 0 })
    return {
      summary: [{ type: 'text', text: `${SENTINEL} # Chapters index\n1. Round 16 chapter over ${region.length} messages.` }],
      provider: 'dsh-chapters-probe',
      model: 'deterministic',
    }
  }

  async runProbe() {
    const ctx = this.ctx
    const cwd = process.cwd()
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}

    const sessionId = `p16-${randomUUID().slice(0, 8)}`
    let handle, createError = null
    try {
      handle = await ctx.agents.create({
        sessionId,
        seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
        inheritedEventCount: 0,
        meta: { cwd, isSeeded: false, agentPreset: 'standard' },
        ...(selection ? { agentOptions: selection } : {}),
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'standard') },
      })
      await workspace?.attachSession?.(sessionId)
    } catch (error) { createError = error }
    record('agents.create with presets.mount setup succeeds', createError === null, {
      message: createError ? String(createError?.message ?? createError).slice(0, 300) : null,
    })
    if (createError !== null) {
      report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0)
    }
    const agent = handle.agent

    // ---- 1. realm resolvable immediately (setup is pre-publication)
    const realm = serviceForAgent(ctx, agent, 'compaction')
    record('preset realm engine exists right after creation', realm !== undefined, {
      realm: realm === undefined ? { undef: true } : { ctor: realm.constructor?.name, hostMarker: realm.p16Marker ?? null },
      isHostSelf: realm === this,
    })
    record('realm engine is a distinct instance from the host-plane probe',
      realm !== undefined && realm !== this, {
      note: 'production consequence: with OUR row inside the preset, this would be our second realm instance',
    })

    // ---- 2. one tiny turn; the child request must carry the composed header
    const session = agent.session
    const turns = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
    const before = turns()
    agent.steer(userMsg('Reply with exactly: P16. No explanation.'))
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && turns() === before) await new Promise((r) => setTimeout(r, 400))
    const usage = (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean).at(-1) ?? null
    const header = session.requestHeader()
    const totalPrompt = usage ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) : null
    record('turn completed with the composed header', turns() > before && totalPrompt !== null, {
      totalPrompt,
      headerTools: header?.tools?.length ?? null,
      headerProvider: header?.config?.provider ?? null,
      headerModel: header?.config?.model ?? null,
      bareControl974: true,
    })
    record('first request materially larger than a bare child (real header present)',
      totalPrompt !== null && totalPrompt > 1600, { totalPrompt })

    // ---- 3. manual compaction of the header-carrying session through OUR
    // host engine (not the realm's): summarize must receive the system head
    // and still commit with zero usage.
    try {
      const seq0 = session.seq
      const result = await this.compactNow(agent, new AbortController().signal)
      const summaryEvent = session.eventAt(result.summarySeq)
      record('compaction of a composed session: system head present, zero usage',
        result !== null
        && this.summarizeCalls.some((c) => c.hasSystem && c.session === sessionId)
        && summaryEvent?.data?.usage === undefined
        && session.seq > seq0, {
        calls: this.summarizeCalls, shadowedSeqs: result?.shadowedSeqs, seq0, seq1: session.seq,
      })
      const sysHeadSeq = session.surface.nodes[0]
      record('surface node 0 is the system/message head', session.eventAt(sysHeadSeq)?.type === 'system/message', {
        node0Type: session.eventAt(sysHeadSeq)?.type ?? null,
      })
    } catch (error) {
      record('compaction of a composed session: system head present, zero usage', false, {
        message: String(error?.message ?? error).slice(0, 300), calls: this.summarizeCalls,
      })
    }

    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
}
