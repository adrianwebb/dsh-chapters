/**
 * dsh-chapters Phase 0b, round 14 — coexistence and the two mount surfaces.
 *
 * Rounds 12/13 proved a host-plane substitution works when `compaction-basic`
 * stays disabled (its shipped default on the web profile). The seam doc's
 * "disable basic + insert ours" assumed a host-plane mount; this round
 * discovered the web profile actually mounts compaction inside the STANDARD
 * PRESET's cordis group realm (`isolate: { compaction: true }`), one engine
 * per preset realm. So the production questions are:
 *
 *   1. Two providers on the SAME plane (basic re-enabled + our probe): does
 *      boot survive, and which instance do consumers see? ("last/only wins")
 *   2. Realm vs host: a `standard`-preset session gets the realm's
 *      BasicCompactionEngine even while our probe owns the host plane —
 *      proving engines COEXIST across planes and would double-fire if both
 *      had live thresholds. Therefore Phase 1's mount must REPLACE the row
 *      inside the preset realm, not merely add a host one.
 *   3. Preset realm with OUR package: author a user-root preset
 *      (.agent-presets/probe-chapters) whose compaction group names
 *      dsh-chapters-probe, create a session with meta.agentPreset, and check
 *      serviceForAgent resolves OUR engine inside that realm — then run the
 *      whole manual compaction through the REALM instance. This is the
 *      deployment story: plugin install + user preset, no harness edits.
 *
 * Everything here is offline: both host rows run `auto: false`, and the realm
 * engine is driven through `compactNow` on seeded sessions — no provider
 * turn, zero tokens.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { serviceForAgent } from '@deepseek-ai/dsh-agent-presets'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-14.json')
const report = { round: 14, startedAt: new Date().toISOString(), probes: [], notes: [] }
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

const describe = (svc) => svc === undefined ? { undef: true } : {
  ctor: svc.constructor?.name, marker: svc.p14Marker ?? null, isBasic: svc instanceof BasicCompactionEngine,
}

const PRESET_DIR = `probe-chapters-${process.env.PROBE_NS ?? 'a'}`

export default class ChaptersProbeEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'agents', 'commands', 'sessionQuery', 'agentPresets']

  constructor(ctx, config) {
    super(ctx, config)
    this.p14Marker = 'p14-probe-instance'
    this.summarizeCalls = []
    setTimeout(() => { this.runProbe().catch((error) => {
      report.fatal = String(error?.stack ?? error)
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(1)
    }) }, 4000)
  }

  async summarize(input, agent, signal) {
    const region = input.messages.filter((m) => m.role !== 'system')
    this.summarizeCalls.push({ region: region.length, session: agent?.session?.id })
    return {
      summary: [{ type: 'text', text: `${SENTINEL} # Chapters index\n1. Round 14 chapter over ${region.length} messages.` }],
      provider: 'dsh-chapters-probe',
      model: 'deterministic',
    }
  }

  async compactNow(agent, signal, sourceCommandId) {
    report.notes.push(`compactNow on instance ${this.p14Marker ?? 'HOST-BASIC'} session=${agent?.session?.id}`)
    return await super.compactNow(agent, signal, sourceCommandId)
  }

  async runProbe() {
    const ctx = this.ctx
    const cwd = process.cwd()

    // ---- 1. sole host-plane provider (the duplicate-provider experiment
    // crashed boot with `service "compaction" has been registered at
    // <BasicCompactionEngine>` — see FINDINGS; kernel refuses double-provision
    // on one plane). Confirm our lone registration owns the plane.
    const svc = ctx.get('compaction')
    record('probe owns the host-plane compaction service',
      svc?.p14Marker === 'p14-probe-instance', {
      winner: describe(svc),
    })

    // ---- 2. author a user-root preset whose compaction group mounts OURS.
    const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
    const presetRoot = path.join(dshHome, '.agent-presets', PRESET_DIR)
    fs.mkdirSync(presetRoot, { recursive: true })
    fs.writeFileSync(path.join(presetRoot, 'preset.yml'), [
      `name: Probe Chapters Realm`,
      `description: Round 14 preset: compaction group with dsh-chapters-probe only.`,
      `order: 99`,
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(presetRoot, 'agent.cordis.yml'), [
      `- id: compaction`,
      `  name: cordis:group`,
      `  group: true`,
      `  isolate:`,
      `    compaction: true`,
      `    toolResultPruner: true`,
      `  config:`,
      `    - id: dsh-chapters-probe-realm`,
      `      name: dsh-chapters-probe`,
      `      config:`,
      `        auto: false`,
      '',
    ].join('\n'))
    report.notes.push(`wrote preset to ${presetRoot}`)

    // ---- 3. roster sees it (user trust, own id — no shadowing of shipped standard)
    try {
      const roster = ctx.agentPresets
      const listed = await roster.list()
      const ids = (Array.isArray(listed) ? listed : []).map((p) => `${p.id}:${p.trust ?? '?'}`)
      record('user-root preset discovered', ids.some((s) => s.startsWith(PRESET_DIR)), { ids })
    } catch (error) {
      record('user-root preset discovered', false, { message: String(error?.message ?? error) })
    }

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}

    const mkHandle = async (sessionId, agentPreset) => ctx.agents.create({
      sessionId, seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
      inheritedEventCount: 0,
      meta: { cwd, isSeeded: false, agentPreset },
    })

    // ---- 4. a standard-preset session: whose engine owns ITS realm?
    const stdId = `p14-std-${randomUUID()}`
    try {
      const h = await mkHandle(stdId, 'standard')
      await workspace?.attachSession?.(stdId)
      const realm = serviceForAgent(ctx, h.agent, 'compaction')
      const d = describe(realm)
      record('standard preset carries a realm engine distinct from host plane',
        realm !== undefined && d.marker !== 'p14-probe-instance', {
        realm: d, hostWinner: describe(ctx.get('compaction')),
        note: 'coexisting engines: host-plane ours + realm basic; both would fire their own pre-step listeners',
      })
    } catch (error) {
      record('standard preset carries a realm engine distinct from host plane', false, { message: String(error?.message ?? error) })
    }

    // ---- 5. OUR realm: probe-chapters preset → serviceForAgent must be ours;
    // then drive the FULL manual transaction through that realm instance.
    const chId = `p14-ch-${randomUUID()}`
    try {
      const h = await mkHandle(chId, PRESET_DIR)
      const agent = h.agent
      const realmEngine = serviceForAgent(ctx, agent, 'compaction')
      const ours = realmEngine?.p14Marker === 'p14-probe-instance'
      record('preset realm mounts OUR package by name (resolution from preset tree)', ours, {
        realm: describe(realmEngine), preset: PRESET_DIR,
      })
      if (ours && realmEngine !== undefined) {
        const session = agent.session
        const nodes0 = [...session.surface.nodes]
        const seq0 = session.seq
        const total0 = ctx.tokenMeter.measure(session).totalTokens
        const result = await realmEngine.compactNow(agent, new AbortController().signal)
        record('manual transaction through the REALM instance commits', result !== null, {
          shadowedSeqs: result?.shadowedSeqs, summarySeq: result?.summarySeq,
        })
        const summaryEvent = session.eventAt(result.summarySeq)
        const checkpoint = session.eventAt(result.summarySeq + 1)
        record('realm transaction: sentinel summary, zero usage, checkpoint provenance',
          String(summaryEvent?.data?.summary?.[0]?.text ?? '').includes(SENTINEL)
          && summaryEvent?.data?.usage === undefined
          && checkpoint?.data?.source?.plugin === 'compact'
          && session.seq > seq0
          && nodes0.every((seq) => session.eventAt(seq) !== undefined), {
          seq0, seq1: session.seq,
        })
        record('realm summarize() invoked exactly once', realmEngine.summarizeCalls?.length === 1, {
          realmCalls: realmEngine.summarizeCalls ?? null, hostCalls: this.summarizeCalls.length,
        })
      }
    } catch (error) {
      record('preset realm mounts OUR package by name (resolution from preset tree)', false, { message: String(error?.message ?? error) })
    }

    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
}
