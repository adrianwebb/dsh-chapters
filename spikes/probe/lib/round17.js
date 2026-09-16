/**
 * dsh-chapters Phase 0b, round 17 — the production mount proof.
 *
 * Assembled picture from rounds 12-16:
 *  - host plane: our subclass registers as `compaction`, `/compact` resolves
 *    it, and the base's automatic pre-step listener dispatches into our
 *    override (r12/r13). Double-provision on one plane fails boot loudly (r14).
 *  - web profile default: host rows are disabled; the real engines live in
 *    the STANDARD PRESET's cordis group realm (`isolate: compaction true`,
 *    one engine per mounted session — which is why two sessions never collide).
 *  - agents.create does NOT compose a preset; `meta.agentPreset` is a label.
 *    `setup: agentCtx => agentPresets.mount(agentCtx, id)` does (r16: child
 *    first request 13,315 tokens with 27 header tools vs 974 bare).
 *
 * So the deployment question is the ONE question: can a preset realm row name
 * OUR package and have the realm's automatic path run OUR engine? This round:
 *  - host row mounts with auto:false — silent witness only (instance count).
 *  - a fresh user-root preset probe-chapters-b whose compaction group names
 *    dsh-chapters-probe with auto:true + thresholdRatio 0.001 + retainTokens 0.
 *  - create a child with setup mounting probe-chapters-b; two tiny turns.
 *  - PROOF: a SECOND instance of our class is constructed during setup
 *    (module-level instance list is OUR copy, so realms built from our row
 *    are visible even though serviceForAgent cannot see across the module
 *    boundary), and its per-instance summarizeCalls fill while the HOST
 *    instance's stay empty during the child's steps.
 * Zero host-plane compaction activity expected; if the host instance also
 * compacts the child, isolation is a lie and we need to know.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-17.json')
const report = { round: 17, startedAt: new Date().toISOString(), probes: [], notes: [], steps: [] }
const record = (name, ok, details = {}) => report.probes.push({ name, ok, ...details })

const SENTINEL = '<<CHAPTERS-PROBE-SUMMARY>>'
const instances = [] // every ChaptersProbeEngine instance constructed in THIS process, from OUR module copy
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
    this.tag = `instance#${instances.length} auto=${config?.auto ?? 'default'} threshold=${config?.thresholdRatio ?? 'default'}`
    this.summarizeCalls = []
    instances.push(this)
    report.notes.push(`constructed ${this.tag}`)
    if (instances.length === 1) {
      setTimeout(() => { this.runProbe().catch((error) => {
        report.fatal = String(error?.stack ?? error)
        fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
        process.exit(1)
      }) }, 4000)
    }
  }

  async summarize(input, agent, signal) {
    const region = input.messages.filter((m) => m.role !== 'system')
    this.summarizeCalls.push({ at: Date.now(), region: region.length, session: agent?.session?.id, tools: input.tools?.length ?? 0 })
    return {
      summary: [{ type: 'text', text: `${SENTINEL} # Chapters index\n1. Round 17 ${this.tag} chapter over ${region.length} messages.` }],
      provider: 'dsh-chapters-probe',
      model: 'deterministic',
    }
  }

  async runProbe() {
    const ctx = this.ctx
    const host = this
    const cwd = process.cwd()
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}

    // ---- author the realm preset (fresh dir; user root is live-discovered)
    const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
    const preset = 'probe-chapters-b'
    const presetRoot = path.join(dshHome, '.agent-presets', preset)
    fs.mkdirSync(presetRoot, { recursive: true })
    fs.writeFileSync(path.join(presetRoot, 'preset.yml'),
      `name: Probe Chapters Realm B\ndescription: Round 17: compaction group naming our package.\norder: 98\n`)
    fs.writeFileSync(path.join(presetRoot, 'agent.cordis.yml'), [
      `- id: compaction`,
      `  name: cordis:group`,
      `  group: true`,
      `  isolate:`,
      `    compaction: true`,
      `    toolResultPruner: true`,
      `  config:`,
      `    - id: chapters-realm`,
      `      name: dsh-chapters-probe`,
      `      config:`,
      `        auto: true`,
      `        thresholdRatio: 0.001`,
      `        retainTokens: 0`,
      '',
    ].join('\n'))

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}

    const sessionId = `p17-${randomUUID().slice(0, 8)}`
    const before = instances.length
    const handle = await ctx.agents.create({
      sessionId,
      seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
      inheritedEventCount: 0,
      meta: { cwd, isSeeded: false, agentPreset: preset },
      ...(selection ? { agentOptions: selection } : {}),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) },
    })
    await workspace?.attachSession?.(sessionId)
    const agent = handle.agent
    const realm = instances[before]
    record('setup-mount constructed OUR class as a realm instance', instances.length > before, {
      instances: instances.map((i) => i.tag), realmTag: realm?.tag ?? null,
    })

    const session = agent.session
    const turns = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
    const usages = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    const drive = async (text, label) => {
      const t0 = turns(); const u0 = usages().length
      agent.steer(userMsg(text))
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline && turns() === t0) await new Promise((r) => setTimeout(r, 400))
      const last = usages().slice(u0).at(-1) ?? null
      const entry = { label, ended: turns() > t0, totalPrompt: last ? (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) : null }
      report.steps.push(entry)
      return entry
    }

    await drive('Reply with exactly: P17A. No explanation.', 'turn 1 (establish route)')
    const hostBefore = host.summarizeCalls.length
    const realmBefore = realm ? realm.summarizeCalls.length : 0
    await drive('Reply with exactly: P17B. No explanation.', 'turn 2 (realm pre-step should compact)')

    record('the REALM instance performed our deterministic summarize',
      realm !== undefined && realm.summarizeCalls.length > realmBefore, { realmCalls: realm?.summarizeCalls ?? null })
    record('the HOST instance did NOT touch this realm session (isolation holds)',
      host.summarizeCalls.length === hostBefore, { hostCalls: host.summarizeCalls })
    const compactionEvents = (session.snapshotEvents?.() ?? [])
      .filter((e) => e.type.startsWith('compaction/'))
      .map((e) => ({ seq: e.seq, type: e.type, turn: e.data?.turn ?? null }))
    record('durable compaction records from the realm engine', compactionEvents.some((e) => e.type === 'compaction/summary'), {
      events: compactionEvents.slice(0, 8),
    })
    record('both turns completed', report.steps.every((s) => s.ended), { steps: report.steps })

    // Cleanup the scratch preset so later rounds don't see stale ids.
    try { fs.rmSync(presetRoot, { recursive: true, force: true }) } catch {}

    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
}
