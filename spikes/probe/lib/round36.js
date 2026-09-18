/**
 * Round 36 — the topic-mapping test at the moments it actually applies.
 *
 * r29 measured the ground truth: the host's pressure compaction does minimal
 * repairs that slice turns mid-collection, so composition (which treats a
 * collection as atomic) correctly declines there. Composition governs the
 * TURN-ALIGNED archive moments — and this probe drives exactly that human
 * flow on the real model:
 *
 *   parent: two real render questions → /chapters-fork
 *       expect ONE chapter holding BOTH collections (live merge #1)
 *   child: sync question ×2 + docs question → /compact
 *       expect the ENGINE's compaction chapter to merge the sync pair
 *       (live merge #2 through the compaction path itself)
 *   child: /chapters-fork → docs lands in its own chapter (live split);
 *       the grandchild TOC cites the accumulated chapters.
 *
 * Real research questions on this repo (read-only), real answers, local
 * model. Monitoring: every turn's signature, every archive's ranges, the
 * pairwise scores that decided them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { acquireChapterStore } from '../../../lib/store.js'
import { signatureScore } from '../../../lib/compose.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-36.json')
const report = { round: 36, startedAt: new Date().toISOString(), probes: [], log: [], trace: [], notes: [] }
const write = () => { try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch { /* monitor */ } }
const record = (name, ok, details = {}) => { report.probes.push({ name, ok, ...details }); write() }
const finish = () => { report.finishedAt = new Date().toISOString(); write(); process.exit(0) }

const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })
const READ_ONLY = ' Use ONLY file-read tools (read, grep, glob) — no shell commands, no edits. Answer briefly with file:line citations.'

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch { /* diagnostics */ }
    const store = (await acquireChapterStore(ctx.storageDomain)).store
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch { /* optional */ }
    const mountSetup = async (agentCtx) => {
      try { await ctx.get('agentPresets').mount(agentCtx, 'chapters') } catch (e) { report.notes.push('setup: ' + String(e?.message ?? e)) }
    }
    const fullyIn = (coll, ch) => coll.seqs.every((sq) => sq >= ch.startSeq && sq <= ch.endSeq)

    const pId = `p36-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: pId, seed: [], inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      agentOptions: selection ?? {}, setup: mountSetup,
    })
    await workspace?.attachSession?.(pId)

    const drive = async (agent, where, question) => {
      const evs = () => agent.session.snapshotEvents?.() ?? []
      const before = evs().filter((e) => e.type === 'turn/end').length
      agent.steer(userMsg(question + READ_ONLY))
      const dl = Date.now() + 22 * 60_000
      while (Date.now() < dl && evs().filter((e) => e.type === 'turn/end').length <= before) await new Promise((r) => setTimeout(r, 2000))
      const ended = evs().filter((e) => e.type === 'turn/end').length > before
      const st = await store.get(agent.session.id)
      const sig = st.collections[st.collections.length - 1]
      report.log.push({
        where, turn: st.collections.length, ended,
        primary: sig?.paths?.[0], size: sig?.size,
        seqs: sig?.seqs ? [sig.seqs[0], sig.seqs[sig.seqs.length - 1]] : null,
        chapters: st.chapters.length,
      })
      write()
      return ended
    }

    // ---------- parent: render pair → FORK
    for (const q of [
      'In src/render.ts: how does the chapter renderer decide which tool results get deferred to artifact files and which stay inline? Where is the threshold and where is redaction applied?',
      'Still src/render.ts (and src/archive.ts): what exactly does the sha256 in a chapter file frontmatter cover, how is the file name chosen from the title, and who re-verifies it?',
    ]) await drive(ph.agent, 'parent', q)
    const parent = ph.agent
    const pBefore = await store.get(pId)
    const fr1 = await ctx.commands.execute(parent, '/chapters-fork', [], new AbortController().signal)
    const res1 = fr1?.result ?? fr1
    const text1 = String(res1?.text ?? JSON.stringify(fr1))
    const childId = text1.match(/ch-[0-9a-f-]+/)?.[0] ?? null
    const pAfter = await store.get(pId)
    const pcolls = [...pAfter.collections].sort((a, b) => a.seqs[0] - b.seqs[0])
    const mergedRender = pAfter.chapters.find((c) => pcolls.filter((k) => fullyIn(k, c)).length >= 2)
    report.trace.push({ pairs: pcolls.slice(1).map((c, i) => ({ score: Number(signatureScore(pcolls[i], c).toFixed(3)), samePrimary: pcolls[i].paths?.[0] === c.paths?.[0] })) })
    record('R1 parent fork merged BOTH render collections into ONE chapter (live merge #1)',
      res1?.kind === 'success' && mergedRender !== undefined && pAfter.chapters.length === 1, {
      chapters: pAfter.chapters.map((c) => ({ n: c.number, range: [c.startSeq, c.endSeq], title: c.title.slice(0, 34) })),
      collections: pcolls.map((k) => ({ seqs: [k.seqs[0], k.seqs[k.seqs.length - 1]], primary: k.paths?.[0], size: k.size })),
      text: text1.slice(0, 140),
    })
    record('R2 fork created the child session', childId !== null, { child: childId })
    if (childId === null) { try { await ph.dispose?.() } catch { /* */ } finish(); return }

    // ---------- child: sync pair + docs → /compact (engine merge) → fork (split)
    const rh = await ctx.agents.resume({ resumeSessionId: childId, agentOptions: selection ?? {}, setup: mountSetup })
    const child = rh.agent
    for (const q of [
      'In src/sync.ts: what is the exact order of operations of runSync, and where is the rule that sync must never throw into the conversation enforced?',
      'Back in src/sync.ts: what do acquireLock and the status file do, and how does runSync decide to ff-and-retry after a rejected push?',
      'In docs/knowledge-repo.md section 1: list the seven invariants, one line each.',
    ]) await drive(child, 'child', q)
    const cBefore = await store.get(childId)
    const ccolls = [...cBefore.collections].sort((a, b) => a.seqs[0] - b.seqs[0])
    report.notes.push(`child collections: ${ccolls.map((k) => `${k.paths?.[0]}@${k.seqs[0]}..${k.seqs[k.seqs.length - 1]}`).join(' | ')}`)
    report.trace.push({ pairs: ccolls.slice(1).map((c, i) => ({ score: Number(signatureScore(ccolls[i], c).toFixed(3)), samePrimary: ccolls[i].paths?.[0] === c.paths?.[0] })) })

    // Merge #2 rides WHATEVER archive transaction catches the sync pair —
    // the engine's own pressure compaction (in-realm compactIfNeeded) or the
    // child's fork below. r36 measured: /compact via host-plane
    // commands.execute crosses the typert boundary and its super-call fails
    // the receiver check — the real user path (browser command bar) runs
    // in-realm; the probe must not fake it from outside.
    const cMid = await store.get(childId)
    const engineMerged = cMid.chapters.find((c) => c.shadowedSeqs !== undefined && ccolls.filter((k) => fullyIn(k, c)).length >= 2)
    record('R3 the sync pair merged into ONE chapter in the child (live merge #2; via=compaction if shadowedSeqs present)',
      engineMerged !== undefined, {
      via: 'compaction (pre-fork)',
      chapters: cMid.chapters.map((c) => ({ n: c.number, range: [c.startSeq, c.endSeq], engine: c.shadowedSeqs !== undefined, title: c.title.slice(0, 30) })),
      collections: ccolls.map((k) => ({ seqs: [k.seqs[0], k.seqs[k.seqs.length - 1]], primary: k.paths?.[0], size: k.size })),
    })

    const fr2 = await ctx.commands.execute(child, '/chapters-fork', [], new AbortController().signal)
    const res2 = fr2?.result ?? fr2
    const text2 = String(res2?.text ?? JSON.stringify(fr2))
    const gId = text2.match(/ch-[0-9a-f-]+/)?.[0] ?? null
    const cEnd = await store.get(childId)
    const docsColl = ccolls[ccolls.length - 1]
    const syncColl = ccolls[0]
    const docsHome = cEnd.chapters.find((c) => docsColl && fullyIn(docsColl, c))
    const syncHome = cEnd.chapters.find((c) => syncColl && fullyIn(syncColl, c))
    record('R4 docs archived SEPARATE from the sync chapter (live split, engine or fork)',
      docsHome !== undefined && (syncHome === undefined || docsHome.number !== syncHome.number), {
      text: text2.slice(0, 140),
      chapters: cEnd.chapters.map((c) => ({ n: c.number, range: [c.startSeq, c.endSeq], title: c.title.slice(0, 30) })),
    })
    if (gId !== null) {
      try {
        const obs = await ctx.sessionQuery.observeSession(gId)
        const notice = JSON.stringify((obs?.events ?? []).find((e) => e.seq === 0)?.data ?? {})
        const cites = (notice.match(/\.dsh-chapters/g) ?? []).length
        record('R5 grandchild TOC cites >=3 accumulated chapters (ancestry across both sessions)', cites >= 3, { cites })
      } catch (e) { report.notes.push('observe: ' + String(e?.message ?? e)) }
    }
    const cFinal = await store.get(childId)
    const mergedSyncFinal = cFinal.chapters.find((c) => ccolls.filter((k) => fullyIn(k, c)).length >= 2)
    report.notes.push(`sync-merge transaction: ${mergedSyncFinal ? (cFinal.chapters.find((c) => ccolls.filter((k) => fullyIn(k, c)).length >= 2).shadowedSeqs !== undefined ? 'compaction' : 'fork') : 'none'}`)
    record('R7 final state: the sync pair ended merged in one chapter regardless of which transaction caught it', mergedSyncFinal !== undefined, {
      chapters: cFinal.chapters.map((c) => ({ n: c.number, range: [c.startSeq, c.endSeq], engine: c.shadowedSeqs !== undefined })),
    })
    record('R6 archive integrity: every chapter record carries sha256 + topics + sane ranges',
      cEnd.chapters.every((c) => /^[0-9a-f]{64}$/.test(c.sha256) && Array.isArray(c.topics) && c.startSeq <= c.endSeq)
      && pAfter.chapters.every((c) => /^[0-9a-f]{64}$/.test(c.sha256)), {
      parentChapters: pAfter.chapters.length, childChapters: cEnd.chapters.length,
    })
    try { await ph.dispose?.() } catch { /* */ }
    try { await rh.dispose?.() } catch { /* */ }
    finish()
  }
  setTimeout(() => {
    run().catch((e) => {
      report.fatal = String(e?.stack ?? e)
      try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch { /* last resort */ }
      process.exit(1)
    })
  }, 4000)
}
