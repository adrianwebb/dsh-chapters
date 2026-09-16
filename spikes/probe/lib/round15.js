/**
 * dsh-chapters Phase 0b, round 15 — where is the preset realm actually mounted,
 * and does an `agents.create` session get one at all?
 *
 * Round 14 (all-offline) found `serviceForAgent(ctx, agent, 'compaction')`
 * undefined for freshly created sessions carrying `meta.agentPreset` — either
 * the preset composition is lazy (mounted when the agent steps) or the
 * `agents.create` path skips it entirely (only the web session-controller
 * path composes preset realms). This round asks DURING a live step: the host
 * probe engine's own `compactIfNeeded` override (proven to fire at
 * `agent/pre-step` in round 13) calls `serviceForAgent` for the stepping
 * agent and reports what the realm holds at that moment.
 *
 * Three sessions, each with 1–2 tiny "Reply with exactly" turns (round-13
 * precedent; total a few thousand tokens):
 *   S-standard  meta.agentPreset 'standard'   — does the realm's basic exist?
 *   S-chapters  meta.agentPreset probe-chapters — can a PRESET ROW name a
 *               profile-installed package (module resolution from the preset
 *               tree), and does OUR class then exist per-realm?
 *   S-bare      no agentPreset meta           — control (round 13 behavior)
 *
 * Decision this feeds: whether Phase 1 mounts the engine host-plane only,
 * preset-realm only, or both — and whether `chapters_continue` children get
 * compaction at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { serviceForAgent } from '@deepseek-ai/dsh-agent-presets'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-15.json')
const report = { round: 15, startedAt: new Date().toISOString(), probes: [], notes: [], steps: [] }
const record = (name, ok, details = {}) => report.probes.push({ name, ok, ...details })

const SENTINEL = '<<CHAPTERS-PROBE-SUMMARY>>'
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten padding words follow so each seeded message carries a few dozen tokens of body text.'
const PRESET_DIR = 'probe-chapters-a' // written by round 14; same scratch home

const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

const describe = (svc) => svc === undefined ? { undef: true } : {
  ctor: svc.constructor?.name, marker: svc.p15Marker ?? null, auto: svc.config?.auto ?? null,
}

export default class ChaptersProbeEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'agents', 'commands', 'sessionQuery', 'agentPresets']

  constructor(ctx, config) {
    super(ctx, config)
    this.p15Marker = 'p15-host-instance'
    this.summarizeCalls = []
    this.realmSightings = []
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
      summary: [{ type: 'text', text: `${SENTINEL} # Chapters index\n1. Round 15 chapter over ${region.length} messages.` }],
      provider: 'dsh-chapters-probe',
      model: 'deterministic',
    }
  }

  async compactIfNeeded(agent, trigger, signal) {
    // THE measurement: mid-step, what does this agent's realm hold?
    let sighting
    try {
      const realm = serviceForAgent(this.ctx, agent, 'compaction')
      sighting = { session: agent?.session?.id, realm: describe(realm), isHostSelf: realm === this }
    } catch (error) { sighting = { session: agent?.session?.id, error: String(error?.message ?? error) } }
    this.realmSightings.push(sighting)
    report.notes.push(`pre-step sighting: ${JSON.stringify(sighting)}`)
    return await super.compactIfNeeded(agent, trigger, signal)
  }

  async runProbe() {
    const ctx = this.ctx
    const cwd = process.cwd()
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('model selection present', Boolean(selection), { selection: selection ? `${selection.provider}/${selection.model}` : null })

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}

    const turns = (session) => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
    const usages = (session) => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    const driveTurn = async (agent, text, label) => {
      const before = turns(agent.session)
      const u0 = usages(agent.session).length
      agent.steer(userMsg(text))
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline && turns(agent.session) === before) await new Promise((r) => setTimeout(r, 400))
      const last = usages(agent.session).slice(u0).at(-1) ?? null
      const entry = { label, ended: turns(agent.session) > before, totalPrompt: last ? (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) : null }
      report.steps.push(entry)
      return entry
    }

    const mk = async (agentPreset) => {
      const sessionId = `p15-${agentPreset ?? 'bare'}-${randomUUID().slice(0, 8)}`
      const handle = await ctx.agents.create({
        sessionId, seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
        inheritedEventCount: 0,
        meta: { cwd, isSeeded: false, ...(agentPreset ? { agentPreset } : {}) },
        ...(selection ? { agentOptions: selection } : {}),
      })
      await workspace?.attachSession?.(sessionId)
      return { handle, sessionId }
    }

    // Header/preset recorded at creation, before any step:
    const obsPreset = async (id) => {
      try { const obs = await ctx.sessionQuery.observeSession(id); return obs?.projections?.values?.agentPreset ?? null }
      catch { return 'observe-error' }
    }

    // ---- S-standard: create → one turn (establish route) → second turn's
    // pre-step compacts (thresholdRatio 0.001 row config) AND records the
    // realm sighting. Turn 1 also proves the web preset composition is even
    // attempted on this path (broken preset would error at steer).
    const sA = await mk('standard')
    record('standard meta accepted at creation', true, { sessionId: sA.sessionId, presetAtCreate: await obsPreset(sA.sessionId) })
    const a1 = await driveTurn(sA.handle.agent, 'Reply with exactly: P15A. No explanation.', 'S-standard turn 1')
    const a2 = await driveTurn(sA.handle.agent, 'Reply with exactly: P15B. No explanation.', 'S-standard turn 2 (pre-step compacts)')
    record('S-standard completed two turns', a1.ended && a2.ended, { a1, a2 })

    // ---- S-chapters: our user-root preset (probe row, auto:false there —
    // a SECOND instance of the class in a per-realm fiber). If this realm
    // exists, serviceForAgent shows an instance NOT equal to host self.
    const sB = await mk(PRESET_DIR)
    record('probe-chapters meta accepted at creation', true, { presetAtCreate: await obsPreset(sB.sessionId) })
    const b1 = await driveTurn(sB.handle.agent, 'Reply with exactly: P15C. No explanation.', 'S-chapters turn 1')
    const b2 = await driveTurn(sB.handle.agent, 'Reply with exactly: P15D. No explanation.', 'S-chapters turn 2')
    record('S-chapters completed two turns', b1.ended && b2.ended, { b1, b2 })

    // ---- S-bare control
    const sC = await mk(undefined)
    const c1 = await driveTurn(sC.handle.agent, 'Reply with exactly: P15E. No explanation.', 'S-bare turn 1')
    const c2 = await driveTurn(sC.handle.agent, 'Reply with exactly: P15F. No explanation.', 'S-bare turn 2')
    record('S-bare completed two turns', c1.ended && c2.ended, { c1, c2 })

    // ---- verdict assembly
    const bySession = {}
    for (const s of this.realmSightings) {
      const k = String(s.session ?? '?').slice(0, 14)
      bySession[k] = s
    }
    const sawStandardRealm = this.realmSightings.some((s) => String(s.session).includes('p15-standard') && s.realm && !s.realm.undef)
    const sawChaptersRealm = this.realmSightings.some((s) => String(s.session).includes('p15-probe') && s.realm && !s.realm.undef)
    record('realm engine observable mid-step for standard sessions', sawStandardRealm, { bySession })
    record('realm engine observable mid-step for probe-chapters sessions (preset row resolution)', sawChaptersRealm, {
      note: 'undefined here means EITHER preset composition skipped on agents.create OR our row failed to resolve; broken-preset errors would have shown in notes',
    })
    record('host engine fired for all three session kinds', this.realmSightings.length >= 4, {
      sightings: this.realmSightings.length, summarizeCalls: this.summarizeCalls.length,
    })

    report.notes.push(`total summarize invocations: ${this.summarizeCalls.length}`)
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
}
