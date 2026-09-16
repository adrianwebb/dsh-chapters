/**
 * dsh-chapters Phase 0b, round 12 — can a plugin replace the compaction engine?
 *
 * This round's probe IS a class plugin: `export default class ChaptersProbeEngine
 * extends BasicCompactionEngine`, mounted at HOST plane by the spike's
 * cordis.patch.yml while the web bundle's host rows for compaction-basic /
 * command-compact / tool-result-pruner are (discovered this round) disabled by
 * default. The profile patch additionally RE-ENABLES `command-compact`, so a
 * clean boot is itself evidence that the consumer's strict inject
 * (`['commands', 'compaction']`) resolved against OUR service registration.
 *
 * The engine overrides only `summarize()`, returning a deterministic, zero-LLM
 * SummaryResult through the documented "unmarked template/remote/other
 * summarizer" branch (no `llmStreamCall`). Then, on a created session with a
 * six-event user seed and NO preset and NO model (a provider call is
 * structurally impossible — zero tokens spent), it calls `compactNow` through
 * the very seam `/compact` uses and asserts the durable outcome:
 *
 *   - compaction/start, compaction/summary (our sentinel text, no `usage`
 *     field = zero summarization tokens — verify.md check (d)), compaction/end
 *   - a replacement user/message with source {kind:'plugin', plugin:'compact',
 *     compactionId} and surfaceOp replace — checkpoint provenance as defined in
 *     compaction/src/checkpoint.ts
 *   - shadowed nodes REMAIN in the durable log (invariant 1; verify.md (b))
 *   - surface node count and token measurement both fall after commit
 *
 * Known-new context this round discovered: the shipped web profile mounts
 * compaction in the STANDARD PRESET's cordis group realm (`isolate:
 * { compaction: true }`), not the host plane. Whether a host-plane engine and a
 * realm engine double-fire on the same agent is NOT settled here (needs a
 * stepping agent); compactIfNeeded call count is recorded as the witness.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-12.json')
const report = { round: 12, startedAt: new Date().toISOString(), probes: [], notes: [] }
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

const textOf = (message) => (message?.content ?? [])
  .filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 80)

export default class ChaptersProbeEngine extends BasicCompactionEngine {
  // The base declares ['llm','tokenMeter','sessions']; the property proxy
  // refuses anything undeclared ("cannot get property X without inject"), so
  // the probe's own needs are appended here — an inherited-statics check too.
  static inject = ['llm', 'tokenMeter', 'sessions', 'agents', 'commands', 'sessionQuery']

  constructor(ctx, config) {
    super(ctx, config)
    this.p12Marker = 'p12-instance'
    this.calls = []
    this.compactIfNeededCalls = 0
    this.llmStreamCalls = 0
    this.ctx = ctx
    const watchdog = setTimeout(() => {
      report.notes.push('watchdog fired before completion')
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(1)
    }, 75_000)
    watchdog.unref?.()
    setTimeout(() => { this.runProbe().catch((error) => {
      report.fatal = String(error?.stack ?? error)
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(1)
    }) }, 4000)
  }

  /** Deterministic, zero-LLM summary through the documented unmarked branch. */
  async summarize(input, agent, signal) {
    const region = input.messages.filter((m) => m.role !== 'system')
    this.calls.push({
      total: input.messages.length,
      region: region.length,
      roles: [...new Set(region.map((m) => m.role))].sort(),
      hasTools: input.tools !== undefined,
      headText: textOf(input.messages[0]),
      regionHeadText: textOf(region[0]),
      lastText: textOf(region.at(-1)),
      agentId: agent?.session?.id,
    })
    const toc = `${SENTINEL} # Chapters index\n1. Probe chapter over ${region.length} messages.`
    return {
      summary: [{ type: 'text', text: toc }],
      provider: 'dsh-chapters-probe',
      model: 'deterministic',
    }
  }

  async compactIfNeeded(agent, trigger, signal) {
    this.compactIfNeededCalls += 1
    report.notes.push(`compactIfNeeded fired: trigger=${trigger} session=${agent?.session?.id}`)
    return await super.compactIfNeeded(agent, trigger, signal)
  }

  async runProbe() {
    const ctx = this.ctx

    // ---- A. what did the plugin's own module graph resolve?
    try {
      const require = createRequire(import.meta.url)
      const basicPath = require.resolve('@deepseek-ai/dsh-compaction-basic')
      const cordisPath = require.resolve('@deepseek-ai/cordis')
      const readVersion = (specifier) => JSON.parse(fs.readFileSync(
        require.resolve(`${specifier}/package.json`), 'utf8')).version
      record('host packages importable from the plugin', true, {
        basicPath, cordisPath,
        versions: {
          basic: readVersion('@deepseek-ai/dsh-compaction-basic'),
          compaction: readVersion('@deepseek-ai/dsh-compaction'),
          cordis: readVersion('@deepseek-ai/cordis'),
        },
      })
      record('subclass chain resolves', Object.getPrototypeOf(BasicCompactionEngine) === CompactionEngine, {
        note: 'class identity WITHIN the plugin copy; the host has its own copy',
      })
    } catch (error) {
      record('host packages importable from the plugin', false, { message: String(error?.message ?? error) })
      report.notes.push('imports failed; aborting probe')
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(0)
    }

    // ---- B. service identity on the host plane. Property access may hand
    // back a receiver-wrapped proxy, so identity is asserted through the
    // marker property as well as raw ===.
    const describe = (svc) => svc === undefined ? { undef: true }
      : { ctor: svc.constructor?.name, marker: svc.p12Marker ?? null, rawEq: svc === this }
    let propAccess = null
    try { propAccess = describe(ctx.compaction) } catch (error) { propAccess = { threw: String(error?.message ?? error) } }
    const got = describe(ctx.get('compaction'))
    record('compaction service resolves to OUR instance',
      (got.rawEq || got.marker === 'p12-instance'), { get: got, propAccess })
    // A spy so "zero tokens" is measured, not assumed.
    try {
      const orig = ctx.llm.stream.bind(ctx.llm)
      ctx.llm.stream = (options) => {
        this.llmStreamCalls += 1
        report.notes.push(`llm.stream called purpose=${options?.purpose}`)
        return orig(options)
      }
    } catch (error) { report.notes.push(`llm spy failed: ${error?.message}`) }

    // ---- C. create a session with a six-event seed (no preset, no model —
    // provider use is structurally impossible, and every turn would error
    // before the provider, as round 10 proved).
    const cwd = process.cwd()
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}
    const sessionId = `p12-${randomUUID()}`
    const seed = Array.from({ length: 6 }, (_, seq) => seedUser(seq))
    const handle = await ctx.agents.create({
      sessionId, seed, inheritedEventCount: 0, meta: { cwd, isSeeded: false },
    })
    await workspace?.attachSession?.(sessionId)
    const agent = handle.agent
    const session = agent.session
    record('six-event seed accepted', true, { sessionId, seq: session.seq })

    // ---- D. /compact still resolves, through OUR service
    try {
      const list = ctx.commands.list(agent)
      const names = list.map((c) => c.name)
      record('command-compact mounted and lists /compact', names.includes('compact'), {
        count: names.length, sample: names.filter((n) => n.startsWith('c')),
      })
    } catch (error) {
      record('command-compact mounted and lists /compact', false, { message: String(error?.message ?? error) })
    }

    // ---- E. pre-state
    const nodes0 = [...session.surface.nodes]
    const seq0 = session.seq
    const total0 = ctx.tokenMeter.measure(session).totalTokens

    // ---- F. manual compaction through the seam — the same call command-compact makes
    let result = null
    let compactError = null
    for (let attempt = 0; attempt < 4 && result === null; attempt += 1) {
      try {
        result = await this.compactNow(agent, new AbortController().signal)
      } catch (error) {
        compactError = error
        report.notes.push(`compactNow attempt ${attempt + 1}: ${error?.name} ${error?.message}`)
        if (error?.name !== 'ManualCompactionError' || !String(error?.message).includes('idle')) break
        await new Promise((r) => setTimeout(r, 2500))
      }
    }
    record('compactNow committed with our deterministic summarize', result !== null, {
      error: compactError ? `${compactError.name}: ${compactError.message}` : null,
      result: result === null ? null : {
        compactionId: String(result.compactionId),
        startSeq: result.startSeq, summarySeq: result.summarySeq, endSeq: result.endSeq,
        shadowedSeqs: result.shadowedSeqs, shadowedRange: result.shadowedRange,
        shadowedTokenCount: result.shadowedTokenCount,
        summaryText: (result.summary ?? []).map((b) => b.text).join('').slice(0, 120),
      },
    })

    // ---- G. summarize() saw the region
    record('summarize called exactly once', this.calls.length === 1, { calls: this.calls })
    record('summarize got verbatim region messages, no tools (no header yet)', this.calls[0]?.region >= 4 && this.calls[0]?.hasTools === false, {
      note: 'region = nodes0 minus retained tail; probe session has no system head',
    })

    // ---- H. durable outcomes
    if (result !== null) {
      const bySeq = (seq) => session.eventAt(seq)
      const summaryEvent = bySeq(result.summarySeq)
      record('compaction/summary event: sentinel, unmarked, zero usage', summaryEvent?.type === 'compaction/summary'
        && String(summaryEvent?.data?.summary?.[0]?.text ?? '').includes(SENTINEL)
        && summaryEvent?.data?.usage === undefined
        && summaryEvent?.data?.llmStreamCall === undefined
        && summaryEvent?.data?.provider === 'dsh-chapters-probe', {
        provider: summaryEvent?.data?.provider, model: summaryEvent?.data?.model,
        maxTokens: summaryEvent?.data?.maxTokens, hasUsage: summaryEvent?.data?.usage !== undefined,
        hasRawOutput: summaryEvent?.data?.rawOutput !== undefined,
        shadowedSeqsMatch: JSON.stringify(summaryEvent?.data?.shadowedSeqs) === JSON.stringify(result.shadowedSeqs),
      })
      const checkpointEvent = bySeq(result.summarySeq + 1)
      record('replacement user/message: compact checkpoint provenance + replace op',
        checkpointEvent?.type === 'user/message'
        && checkpointEvent?.data?.source?.kind === 'plugin'
        && checkpointEvent?.data?.source?.plugin === 'compact'
        && String(checkpointEvent?.data?.source?.compactionId) === String(result.compactionId)
        && checkpointEvent?.surfaceOp?.op === 'replace', {
        source: checkpointEvent?.data?.source, surfaceOp: checkpointEvent?.surfaceOp,
        hasCheckpointTag: String(checkpointEvent?.data?.content?.map?.((b) => b.text).join('') ?? '').includes('<compacted-summary>'),
      })
      const survivors = result.shadowedSeqs.map((seq) => ({ seq, type: bySeq(seq)?.type ?? null }))
      record('invariant 1: durable log never shrank; shadowed nodes still readable',
        session.seq > seq0 && survivors.every((s) => s.type === 'user/message'), {
        seq0, seq1: session.seq, survivors: survivors.slice(0, 3),
      })
      const nodes1 = [...session.surface.nodes]
      const total1 = ctx.tokenMeter.measure(session).totalTokens
      record('surface shrank; measurement fell', nodes1.length < nodes0.length && total1 < total0, {
        nodes0: nodes0.length, nodes1: nodes1.length, total0, total1,
        shadowedStillOnSurface: result.shadowedSeqs.some((seq) => nodes1.includes(seq)),
      })
      record('zero provider calls during the whole transaction', this.llmStreamCalls === 0, {
        llmStreamCalls: this.llmStreamCalls,
      })
      try {
        const obs = await ctx.sessionQuery.observeSession(sessionId)
        const cold = obs?.events ?? []
        record('cold read sees the compaction records', cold.some((e) => e.type === 'compaction/summary'), {
          eventCount: cold.length, types: [...new Set(cold.map((e) => e.type))].sort(),
        })
      } catch (error) { record('cold read sees the compaction records', false, { message: String(error?.message ?? error) }) }

      // ---- I. behavior on a second request (shrink floor: framed TOC vs the
      // two-node remainder). Just record what the kernel does.
      try {
        const again = await this.compactNow(agent, new AbortController().signal)
        record('second compactNow', true, { outcome: again === null ? 'null (nothing compactable)' : 'second compaction committed', again: again === null ? null : String(again.compactionId) })
      } catch (error) {
        record('second compactNow refused cleanly', true, { name: error?.name, code: error?.code, message: String(error?.message).slice(0, 200) })
      }

      // ---- J. THE SAME FAILURE THROUGH /COMPACT: the command's catch is
      // `error instanceof ManualCompactionError` against ITS OWN module copy;
      // our engine throws the class from the plugin's copy. Curated text =>
      // classification survived the realm boundary; generic/raised => degraded.
      try {
        const execution = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
        record('/compact end-to-end through our engine', true, {
          resolved: execution !== undefined,
          kind: execution?.result?.kind ?? null,
          text: String(execution?.result?.text ?? '').slice(0, 160),
        })
      } catch (error) {
        record('/compact end-to-end through our engine', false, {
          threw: error?.name, message: String(error?.message).slice(0, 200),
        })
      }
    }

    report.notes.push(`compactIfNeeded automatic-trigger invocations during probe: ${this.compactIfNeededCalls}`)
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
}
