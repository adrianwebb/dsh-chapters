/**
 * Round 27 — the gold test: the full loop on the REAL target (Local Qwen,
 * 32K window, chapters preset as the profile default). Asserts the dev
 * profile wiring, then drives a ~20K-token seeded session so the pre-step
 * pressure (0.9 × 32768 = 29,491) fires after turn 1: deterministic
 * compaction (zero tokens), a chapter on disk, and a second turn that
 * continues from the compacted surface.
 *
 * One turn's prefill is the whole cost — that is exactly the cost this
 * plugin removes at every later compaction.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-27.json')
const report = { round: 27, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten '
const CHUNK = WORDS.repeat(3) // ~150 chars, ~38 tokens
const seedUser = (seq, n = 6) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${CHUNK.repeat(n)}` }] },
})
const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    let presets = null, defPreset = null
    try { presets = await ctx.agentPresets.list(); defPreset = ctx.agentPresets.resolve(undefined) } catch {}
    record('A1 dev profile: default model selection is Local Qwen',
      selection?.provider === 'local' && selection?.model === 'qwen3.8-flash-next', { selection })
    let window = null
    try { window = (await ctx.llm.resolveModelInfo(selection)).modelWindow ?? null } catch {}
    record('A2 model window is 32K (the target regime)', window === 32768, { window })
    record('A3 chapters is the profile default preset', defPreset === 'chapters' && presets?.some((p) => p.id === 'chapters'), { defPreset, ids: presets?.map((p) => p.id) })

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch {}
    // 100 seeds × ~228 tokens ≈ 22.8K of content + ~12K header ≈ 35K routed
    // envelope — past the 29,491 pressure line (0.9 × 32768).
    const parentId = `p27-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: parentId,
      seed: Array.from({ length: 100 }, (_, i) => seedUser(i)),
      inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      agentOptions: selection ?? {},
      setup: async (agentCtx) => { try { await ctx.get('agentPresets').mount(agentCtx, 'chapters') } catch (e) { report.notes.push('setup: ' + String(e?.message ?? e)) } },
    })
    await workspace?.attachSession?.(parentId)
    const parent = ph.agent
    const evs = () => parent.session.snapshotEvents?.() ?? []
    const turnEnds = () => evs().filter((e) => e.type === 'turn/end')
    const usageOf = (turn) => {
      let usage = null
      for (const e of evs()) {
        if (e.type === 'model/usage' && e.data?.turn === turn) usage = e.data.usage
      }
      return usage
    }

    parent.steer(userMsg('Reply with exactly: P27. No explanation.'))
    const dl1 = Date.now() + 25 * 60_000
    while (Date.now() < dl1 && turnEnds().length < 1) await new Promise((r) => setTimeout(r, 1000))
    const t1 = usageOf(1)
    record('B1 turn 1 completed on Local Qwen (35K envelope prefill)', turnEnds().length >= 1, {
      usage1: t1 ? { in: t1.inputTokens, cacheRead: t1.cacheReadTokens, out: t1.outputTokens } : null,
    })

    const t2 = userMsg('Reply with exactly: TWO. No explanation.')
    parent.steer(t2)
    const dl2 = Date.now() + 25 * 60_000
    while (Date.now() < dl2 && turnEnds().length < 2) await new Promise((r) => setTimeout(r, 1000))
    record('B2 turn 2 completed (compaction fired between turns)', turnEnds().length >= 2, {
      usage2: usageOf(2) ? { in: usageOf(2).inputTokens, cacheRead: usageOf(2).cacheReadTokens, out: usageOf(2).outputTokens } : null,
    })

    const comps = evs().filter((e) => e.type === 'compaction/summary')
    const comp = comps[comps.length - 1]
    record('B3 deterministic compaction committed (provider dsh-chapters, zero usage)',
      comp?.data?.provider === 'dsh-chapters' && comp?.data?.usage == null, {
      provider: comp?.data?.provider, usage: comp?.data?.usage,
      summary: (comp?.data?.summary ?? '').slice(0, 120),
    })
    const chapterFiles = []
    const chaptersDir = path.join(ROOT, '.dsh-chapters')
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.md')) chapterFiles.push(p)
      }
    }
    walk(chaptersDir)
    record('B4 chapter file written to the workspace store', chapterFiles.length >= 1, { files: chapterFiles.map((f) => f.replace(ROOT + '/', '')) })

    // The compacted envelope: turn 2's routed size must be far below turn 1's.
    const u1 = usageOf(1), u2 = usageOf(2)
    const env1 = u1 ? u1.inputTokens + (u1.cacheReadTokens ?? 0) : null
    const env2 = u2 ? u2.inputTokens + (u2.cacheReadTokens ?? 0) : null
    record('B5 compaction shrank the routed envelope (turn 2 well below turn 1)',
      env1 !== null && env2 !== null && env2 < env1 * 0.8, { env1, env2 })

    try { await ph.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => { report.fatal = String(e?.stack ?? e); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(1) }) }, 4000)
}
