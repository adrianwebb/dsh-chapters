/**
 * Round 27 — the gold test: automatic compaction on the REAL target (Local
 * Qwen, 64K window — the real regime — chapters preset by default). The v1 run proved the path
 * (session log p27-1a968185: pre-step compaction provider=dsh-chapters
 * usage=None at seq 117, then 9 continued steps) — this version asserts the
 * success criteria the v1 probe got wrong: the model does WORK (a coding
 * model given "reply P27" instead explores the repo), so the criteria are
 * "compaction fired deterministically + the turn continued from the
 * compacted surface + a chapter on disk", not "the turn ended with P27".
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
const CHUNK = WORDS.repeat(3)
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${CHUNK.repeat(6)}` }] },
})
const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('A1 default model selection is Local Qwen', selection?.provider === 'local' && selection?.model === 'qwen3.8-flash-next', { selection })

    let modelInfo = null, modelInfoErr = null
    try { modelInfo = await ctx.llm.resolveModelInfo(selection.provider, selection.model) } catch (e) { modelInfoErr = String(e?.message ?? e) }
    const window = modelInfo?.context?.contextWindow ?? null
    record('A2 model window is 64K (the real regime the user runs)', window === 64000, { window, model: modelInfo?.id, err: modelInfoErr })

    let defId = null, defErr = null
    try { defId = ctx.agentPresets.defaultId } catch (e) { defErr = String(e?.message ?? e) }
    let roster = []
    try { roster = (await ctx.agentPresets.list())?.map((p) => p.id) ?? [] } catch {}
    record('A3 chapters is the profile default preset (defaultId) and in the roster',
      defId === 'chapters' && roster.includes('chapters'), { defaultId: defId, err: defErr, roster })

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch {}
    // 100 seeds ≈ 90.6K tokens (measured on this box) + header ≈ 93K — far past
    // the 57,600 pressure line (0.9 × 64000), so the first pre-step compacts
    // BEFORE the first request (which would otherwise exceed the server's
    // real 65,536 n_ctx).
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

    parent.steer(userMsg('This is a compaction test. Do not call any tools and do not read any files. Reply with exactly the single word: PING.'))
    const dl = Date.now() + 20 * 60_000
    const poll = () => {
      const events = evs()
      const comp = events.find((e) => e.type === 'compaction/summary')
      const compSeq = comp?.seq ?? -1
      const after = events.filter((e) => e.type === 'assistant/message' || e.type === 'tool/call' || e.type === 'turn/end').filter((e) => e.seq > compSeq)
      return { events, comp, compSeq, after, ended: events.some((e) => e.type === 'turn/end') }
    }
    let state = poll()
    while (Date.now() < dl && !(state.comp && state.comp.data?.provider === 'dsh-chapters' && (state.after.length >= 3 || state.ended))) {
      await new Promise((r) => setTimeout(r, 1500))
      state = poll()
    }
    const { comp, compSeq, after, ended } = state

    record('B1 deterministic compaction fired (provider dsh-chapters, zero usage)',
      comp?.data?.provider === 'dsh-chapters' && comp?.data?.usage == null, {
      provider: comp?.data?.provider, usage: comp?.data?.usage, seq: comp?.seq,
      shadowedCount: Array.isArray(comp?.data?.shadowedSeqs) ? comp.data.shadowedSeqs.length : null,
      summary: (comp?.data?.summary ?? [])[0]?.text?.slice(0, 140),
    })
    record('B2 the turn CONTINUED from the compacted surface (≥3 post-compaction steps or turn end)',
      (after.length >= 3 || ended) && comp !== undefined, { afterCount: after.length, ended })
    const shadowed = comp?.data?.shadowedSeqs ?? []
    record('B3 the compacted span covers the seeded history (≥90 shadowed seqs)', Array.isArray(shadowed) && shadowed.length >= 90, { shadowedCount: shadowed.length, first: shadowed[0], last: shadowed[shadowed.length - 1] })

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
    const fresh = chapterFiles.filter((f) => fs.statSync(f).mtimeMs > Date.parse(report.startedAt) - 60_000)
    record('B4 a verbatim chapter landed on disk for this session', fresh.length >= 1, { fresh: fresh.map((f) => f.replace(ROOT + '/', '')), bytes: fresh[0] ? fs.statSync(fresh[0]).size : 0 })

    // Honest note: if the turn is still open it is at a tool/approval step the
    // probe cannot answer — the engine's job (B1-B4) is already done.
    if (!ended) report.notes.push('turn still open at finish (model at a tool/approval step) — engine criteria B1-B4 are independent of turn end')
    try { await ph.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => { report.fatal = String(e?.stack ?? e); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(1) }) }, 4000)
}
