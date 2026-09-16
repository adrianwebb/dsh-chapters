/**
 * Round 23 — E3: does the header stay cached across a compaction?
 *
 * The claim AGENTS.md forbids until measured: in-place compaction keeps the
 * warm ~13K header (system prompt + 27 tool schemas) cached and refills only
 * the replaced span, while a continuation pays a full cold prefill. This boots
 * a COMPOSED child (full chapters-preset realm, engine row switched to
 * thresholdRatio 0.001 + retainTokens 0 so a real deterministic compaction
 * lands at a pre-step), then drives three tiny turns and records per-turn
 * usage through the pinned formula: totalPrompt = inputTokens + cacheReadTokens.
 *
 * PASS shape: a compaction commits between two turns (provider 'dsh-chapters',
 * no usage), AND the turn(s) AFTER the surface replacement still show
 * cacheReadTokens >= 6000 (block-granularity-forgiving; header is ~13K). If
 * instead cacheReadTokens collapses to ~0 after the replacement, the plugin's
 * cache story flips: continuations would be the cache-cheap option and the
 * framing everywhere must change. Also recorded either way: whether turn 1
 * itself hits cache written by a SIBLING session's identical header (a
 * cross-session prefix-sharing datapoint r10/11 could not show on bare
 * sessions) — ~4K prompt tokens of spend, all on tiny replies.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-23.json')
const report = { round: 23, startedAt: new Date().toISOString(), probes: [], notes: [], steps: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

// ---- author the E3 preset: shipped chapters preset with the engine row tuned
const DSHOME = process.env.DSH_HOME ?? path.join(ROOT, '.dshdev')
const PRESET = 'e3-chapters'
const presetRoot = path.join(DSHOME, '.agent-presets', PRESET)
fs.mkdirSync(presetRoot, { recursive: true })
fs.writeFileSync(path.join(presetRoot, 'preset.yml'),
  `name: E3 Chapters\ndescription: Round 23 - chapters preset with a pressure threshold that guarantees one deterministic compaction.\norder: 95\n`)
const shipped = fs.readFileSync(path.join(ROOT, 'presets', 'chapters', 'agent.cordis.yml'), 'utf8')
const tuned = shipped.replace(
  `    - id: chapters-engine
      name: dsh-chapters/engine
      config:
        thresholdRatio: 0.9
`,
  `    - id: chapters-engine
      name: dsh-chapters/engine
      config:
        thresholdRatio: 0.001
        retainTokens: 0
`,
)
if (tuned === shipped) { report.notes.push('FATAL: engine row not found in shipped preset — E3 preset unauthored'); finish(); }
fs.writeFileSync(path.join(presetRoot, 'agent.cordis.yml'), tuned)

const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten padding words so each seeded message carries a few dozen tokens. '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = ROOT
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('selection', Boolean(selection), { selection: selection && `${selection.provider}/${selection.model}` })
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}

    const sessionId = `p23-${randomUUID().slice(0, 8)}`
    const handle = await ctx.agents.create({
      sessionId,
      seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
      inheritedEventCount: 0,
      meta: { cwd, isSeeded: false, agentPreset: PRESET },
      ...(selection ? { agentOptions: selection } : {}),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, PRESET) },
    })
    await workspace?.attachSession?.(sessionId)
    const agent = handle.agent
    const session = agent.session

    const turns = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
    const compactions = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'compaction/summary')
    const drive = async (label) => {
      const before = turns()
      const u0 = usageCount()
      agent.steer(userMsg(`Reply with exactly: P23${label.slice(-1)}. No explanation.`))
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline && turns() === before) await new Promise((r) => setTimeout(r, 400))
      const usage = usageOf().slice(u0).at(-1) ?? null
      const totalPrompt = usage ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) : null
      const hit = usage && totalPrompt ? +((100 * (usage.cacheReadTokens ?? 0)) / totalPrompt).toFixed(1) : null
      const entry = { label, ended: turns() > before, inputTokens: usage?.inputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? 0, totalPrompt, hitPct: hit,
        compactionsAfter: compactions().length }
      report.steps.push(entry)
      return entry
    }
    const usageOf = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    const usageCount = () => usageOf().length

    // turn 1: establishes route + writes the header cache (nothing compacts: no target yet)
    const a = await drive('turn 1 (cold header, no target)')
    // turn 2: pre-step pressure -> ONE deterministic compaction replaces the seed span
    const b = await drive('turn 2 (post-compaction, header cache check)')
    // turn 3: steady state after churn
    const c = await drive('turn 3 (still warm?)')

    record('all three turns completed', a.ended && b.ended && c.ended, { steps: report.steps })
    record('a deterministic compaction landed between turn 1 and turn 2',
      b.compactionsAfter >= 1 && a.compactionsAfter === 0, {
      afterT1: a.compactionsAfter, afterT2: b.compactionsAfter, afterT3: c.compactionsAfter,
    })
    const summary = compactions()[0]
    record('the compaction used OUR summarize (provider tag, zero usage)',
      summary?.data?.provider === 'dsh-chapters' && summary?.data?.usage === undefined, {
      provider: summary?.data?.provider, hasUsage: summary?.data?.usage !== undefined,
    })

    // THE E3 VERDICT: header survives the surface replacement.
    const survives = (b.cacheReadTokens ?? 0) >= 6000 || (c.cacheReadTokens ?? 0) >= 6000
    record('E3: header stays cached across a compaction (cacheReadTokens >= 6000 post-replacement)',
      survives, {
      turn1: { totalPrompt: a.totalPrompt, cacheRead: a.cacheReadTokens },
      turn2: { totalPrompt: b.totalPrompt, cacheRead: b.cacheReadTokens },
      turn3: { totalPrompt: c.totalPrompt, cacheRead: c.cacheReadTokens },
      note: 'survives => in-place compaction is the cache-cheap relief; collapses => every doc must say continuations are cheaper instead',
    })
    report.notes.push(`cross-session header cache on turn 1 (cold start, siblings existed): cacheRead=${a.cacheReadTokens} — a provider prefix-sharing datapoint`)

    try { await handle.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
