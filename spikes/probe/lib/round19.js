/**
 * dsh-chapters Phase 1, round 18 — the REAL engine in a REAL preset realm.
 *
 * Everything before this used the probe's own stub class. This round boots the
 * shipped plugin's compiled engine (`dsh-chapters/engine` as a preset-realm
 * row — the resolution question FINDINGS left open) and drives a live agent
 * through it, asserting the end-to-end accumulation loop that no offline
 * test can reach:
 *
 *   turn 1-2: pre-step pressure (row thresholdRatio 0.001) compacts the seed
 *             span -> chapter 001 written under meta.cwd, TOC bullet #1 cited,
 *             compaction/summary provider 'dsh-chapters', NO usage field.
 *   turn 3-4: the SECOND compaction's region includes the first checkpoint ->
 *             its TOC must merge-forward: bullet 1 = chapter 001's real path,
 *             bullet 2 = the new chapter. This is the make-or-break of
 *             "reachable after compaction without inference".
 *   registry: .dshdev2/storages/dsh_chapters.json holds plans/finalized/
 *             chapters keyed by author session; chapter file exists on disk
 *             with verbatim seed text (SEED-0 …), no PRUNE text needed here
 *             (pruner not mounted in this realm — r17 lesson: composition
 *             rule is tested offline).
 *
 * Four tiny turns (~6K tokens). Probe is mounted in .dshdev2 alongside the
 * real plugin; preset authored under .dshdev2/.agent-presets/.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..') // repo root
const OUT = path.join(HERE, '..', 'results-19.json')
const report = { round: 19, startedAt: new Date().toISOString(), probes: [], notes: [], steps: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}

const RUN = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const STORE_ROOT = `.dsh-chapters-run-${RUN}`
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten padding words follow so each seeded message carries a few dozen tokens of body text.'
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

// ---- author the preset BEFORE boot composition needs it (discovery is unmemoized)
const PRESET = 'chapters-live-19'
const DSHOME = process.env.DSH_HOME ?? path.join(ROOT, '.dshdev')
const presetRoot = path.join(DSHOME, '.agent-presets', PRESET)
fs.mkdirSync(presetRoot, { recursive: true })
fs.writeFileSync(path.join(presetRoot, 'preset.yml'),
  `name: Chapters Live\ndescription: Round 18: real compiled engine via preset realm row.\norder: 97\n`)
fs.writeFileSync(path.join(presetRoot, 'agent.cordis.yml'), [
  `- id: compaction`,
  `  name: cordis:group`,
  `  group: true`,
  `  isolate:`,
  `    compaction: true`,
  `    toolResultPruner: true`,
  `  config:`,
  `    - id: chapters-engine`,
  `      name: dsh-chapters/engine`,
  `      config:`,
  `        auto: true`,
  `        thresholdRatio: 0.0003`,
  `        retainTokens: 0`,
  `        artifactStoreRoot: ${STORE_ROOT}`,
  '',
].join('\n'))

try { fs.writeFileSync(path.join(ROOT, 'var', 'probe-import.txt'), String(Date.now())) } catch {}
export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'sessionQuery', 'tokenMeter']

export function apply(ctx, config) {
  try { fs.writeFileSync(OUT, JSON.stringify({ startedAt: new Date().toISOString(), note: 'apply ran' }, null, 2)) } catch (e) { console.error('PROBE APPLY WRITE FAILED', e) }
  console.error('PROBE APPLY RAN')
  try { fs.writeFileSync(path.join(ROOT, 'var', 'probe-paths.txt'), JSON.stringify({ here: HERE, out: OUT, importUrl: import.meta.url, cwdNow: process.cwd(), existsRepo: fs.existsSync(path.join(ROOT,'spikes','probe','lib','round19.js')) }, null, 2)) } catch {}
  const run = async () => {
    const cwd = ROOT // unique per-run store root: an overlapping probe process can never delete this run's chapters
    report.notes.push(`storeRoot=${STORE_ROOT}`)

    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('model selection present', Boolean(selection), { selection: selection ? `${selection.provider}/${selection.model}` : null })

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}

    const sessionId = `p19-${randomUUID().slice(0, 8)}`
    let agent
    try {
      const handle = await ctx.agents.create({
        sessionId, seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
        inheritedEventCount: 0,
        meta: { cwd, isSeeded: false, agentPreset: PRESET },
        ...(selection ? { agentOptions: selection } : {}),
        setup: async (agentCtx) => {
          const presets = ctx.get('agentPresets')
          await presets.mount(agentCtx, PRESET)
        },
      })
      await workspace?.attachSession?.(sessionId)
      agent = handle.agent
      record('agents.create + presets.mount(chapters-live) succeeds (subpath row resolution)', true, { sessionId })
    } catch (error) {
      record('agents.create + presets.mount(chapters-live) succeeds (subpath row resolution)', false, {
        message: String(error?.message ?? error).slice(0, 400),
      })
      finish()
      return
    }

    const session = agent.session
    const events = () => session.snapshotEvents?.() ?? []
    const turns = () => events().filter((e) => e.type === 'turn/end').length
    const usages = () => events().filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    const compactions = () => events().filter((e) => e.type === 'compaction/summary')
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

    // ---- compaction #1 across turns 1-2 (turn 1 establishes the route)
    await drive('Reply with exactly: P18A. No explanation.', 'turn 1')
    await drive('Reply with exactly: P18B. No explanation.', 'turn 2 (pressure compact #1)')
    const c1 = compactions()[0]
    record('compaction #1 committed by the REAL engine', c1 !== undefined, {
      providers: compactions().map((e) => e.data?.provider),
    })

    // ---- chapter 001 on disk with verbatim seed text + registry manifest
    const storeDir = path.join(cwd, STORE_ROOT, sessionId, 'chapters')
    const files = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : []
    const body = files.length > 0 ? fs.readFileSync(path.join(storeDir, files[0]), 'utf8') : ''
    record('chapter file written under meta.cwd with verbatim content', files.length === 1 && body.includes('SEED-0') && body.includes('SEED-4'), {
      files, bytes: body.length,
    })
    record('compaction #1 summary cites that chapter path', c1 !== undefined
      && String(c1.data?.summary?.[0]?.text ?? '').includes(`/${sessionId}/chapters/`), {
      text: String(c1?.data?.summary?.[0]?.text ?? '').slice(0, 300),
    })
    record('compaction #1 zero usage, provider tagged', c1?.data?.usage === undefined && c1?.data?.provider === 'dsh-chapters', {
      provider: c1?.data?.provider, model: c1?.data?.model,
    })

    // ---- compaction #2+: the compacted remainder still exceeds threshold 0.0003,
    // so the SECOND compaction's region includes checkpoint #1 -> merge-forward must fire.
    const compactsBefore = compactions().length
    const all = compactions()
    let c2 = all.length > compactsBefore ? compactions()[compactsBefore] : undefined
    for (let extra = 0; extra < 3 && c2 === undefined; extra += 1) {
      await drive(`Reply with exactly: P19X${extra}. No explanation. ${PAD.slice(0, 120)}`, `turn extra ${extra} (await compaction #2)`)
      const now = compactions()
      if (now.length > compactsBefore) c2 = now[compactsBefore]
    }
    const all2 = compactions()
    record('a SECOND engine compaction happened (cascade past the first checkpoint)', c2 !== undefined, { count: all2.length })
    if (c2 !== undefined) {
      const toc2 = String(c2.data?.summary?.[0]?.text ?? '')
      const bullet1 = /^\s*1\.\s+\[(.*?)\]\((.*?)\)\s+\u2014\s+(.*)$/m.exec(toc2)
      const bullet2 = /^\s*2\.\s+\[(.*?)\]\((.*?)\)\s+\u2014\s+(.*)$/m.exec(toc2)
      const chapter1Path = bullet1?.[2] ?? null
      const pointsAtRealFile = chapter1Path !== null && fs.existsSync(path.join(cwd, chapter1Path))
      record('TOC #2 merge-forwards bullet 1 -> existing chapter file', bullet1 !== null && pointsAtRealFile, {
        bullet1: bullet1?.slice(0, 3), pathResolves: pointsAtRealFile,
      })
      record('TOC #2 adds a second bullet', bullet2 !== null, { bullet2Path: bullet2?.[2] ?? null })
      const secondFile = bullet2?.[2] ?? null
      record('chapter #2 body exists on disk', secondFile !== null && fs.existsSync(path.join(cwd, secondFile)), { path: secondFile })
    }

    const u = usages()
    record('every provider usage is a conversation turn; both summaries carry NO usage (zero summarization tokens)',
      u.length >= 3 && u.every((x) => (x?.outputTokens ?? 0) > 0 && (x?.outputTokens ?? 0) < 300)
      && compactions().every((e) => e.data?.usage === undefined), {
      usageCount: u.length, totals: u.map((x) => `${(x.inputTokens ?? 0) + (x.cacheReadTokens ?? 0)}->${x.outputTokens ?? 0}`),
      summariesWithUsage: compactions().filter((e) => e.data?.usage !== undefined).length,
    })

    finish()
  }
  const finish = () => {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
