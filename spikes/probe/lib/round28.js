/**
 * Round 28/29 — the topic-mapping live test, compaction edition.
 *
 * A dev session pointed at THIS project (Local Qwen, 64K, chapters preset),
 * asked five real research questions across four topics (render, render,
 * sync, docs, client — the render pair is the merge candidate: same primary
 * path, small sizes). With the dev profile's thresholdRatio 0.33 the
 * automatic compaction fires mid-session — and since r29 it runs the
 * COMPOSER over the collected per-turn signatures. The probe monitors:
 * per-turn signatures, when compaction archived, which chapters merged vs
 * split, coverage (nothing shadowed unarchived), and the final fork + child.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { acquireChapterStore } from '../../../lib/store.js'
import { composeChapters, signatureScore } from '../../../lib/compose.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-28.json')
const report = { round: 29, startedAt: new Date().toISOString(), probes: [], turns: [], trace: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch { /* monitor only */ }
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })
const READ_ONLY = ' Use ONLY file-read tools (read, grep, glob) — do not run shell commands, do not edit anything. Then give me a short answer with file:line citations.'

const QUESTIONS = [
  { topic: 'render', q: 'In src/render.ts: how does the chapter renderer decide which tool results get deferred to artifact files and which stay inline in the chapter body? Where exactly is the threshold and where is the redaction applied?' },
  { topic: 'render', q: 'Still in src/render.ts (and src/archive.ts): what exactly does the sha256 in a chapter file’s frontmatter cover, how is the file name chosen from the title, and who re-verifies that hash later?' },
  { topic: 'sync', q: 'In src/sync.ts and src/gitops.ts: list the exact order of operations a single sync pass performs, and where is the rule that sync must NEVER throw into the conversation path enforced? What makes it fast-forward only?' },
  { topic: 'docs', q: 'In docs/knowledge-repo.md: what are the seven invariants of section 1? One line each. Then in section 4, what is the overlap-score formula for merging collections and what does the size limit guard do?' },
  { topic: 'client', q: 'In src/client/: how does the fork button know which session row is current, what does it send, and which host command does it trigger? Cite the lines.' },
]

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch { /* probe diagnostics only */ }
    const store = (await acquireChapterStore(ctx.storageDomain)).store
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch { /* optional */ }

    const parentId = `p29-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: parentId, seed: [], inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      agentOptions: selection ?? {},
      setup: async (agentCtx) => { try { await ctx.get('agentPresets').mount(agentCtx, 'chapters') } catch (e) { report.notes.push('setup: ' + String(e?.message ?? e)) } },
    })
    await workspace?.attachSession?.(parentId)
    const parent = ph.agent
    const evs = () => parent.session.snapshotEvents?.() ?? []
    const turnEnds = () => evs().filter((e) => e.type === 'turn/end').length

    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i]
      const before = turnEnds()
      parent.steer(userMsg(q.q + READ_ONLY))
      const dl = Date.now() + 22 * 60_000
      while (Date.now() < dl && turnEnds() <= before) await new Promise((r) => setTimeout(r, 2000))
      const ended = turnEnds() > before
      const st = await store.get(parentId)
      const sig = st.collections[st.collections.length - 1]
      report.turns.push({
        turn: i + 1, topic: q.topic, ended,
        compactionsSoFar: evs().filter((e) => e.type === 'compaction/summary').length,
        collectionCount: st.collections.length,
        chaptersAfter: st.chapters.map((c) => ({ n: c.number, range: [c.startSeq, c.endSeq], title: c.title.slice(0, 30) })),
        sig: sig ? { seqs: sig.seqs, paths: sig.paths.slice(0, 6), commands: sig.commands.slice(0, 4), terms: sig.terms.slice(0, 8), size: sig.size } : null,
      })
      try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch { /* monitor only */ }
      record(`T${i + 1} (${q.topic}) turn completed + signature collected`, ended && sig !== undefined, {
        seqs: sig?.seqs, primary: sig?.paths?.[0], size: sig?.size,
      })
      if (!ended) { report.notes.push(`turn ${i + 1} timed out; continuing with what we have`); break }
    }

    const stFinal = await store.get(parentId)
    const anchor = Math.max(...evs().filter((e) => e.type === 'turn/end').map((e) => e.seq))
    const events = evs()

    // Offline decision trace with the real signatures (mirror of the
    // composer incl. the r28 primary-path rule) — explains live outcomes.
    const TAU = 0.3, LIMIT = 8000
    const lastArchived = stFinal.chapters.reduce((m, c) => Math.max(m, c.endSeq), 0)
    const spanStart = lastArchived > 0 ? lastArchived + 1 : 0
    const cols = [...stFinal.collections]
      .filter((c) => c.seqs.length > 0 && c.seqs[0] >= spanStart && c.seqs[c.seqs.length - 1] <= anchor)
      .sort((a, b) => a.seqs[0] - b.seqs[0])
    let run_ = null
    const pEq = (x, y) => !!x && !!y && (x === y || x.startsWith(y + '.') || y.startsWith(x + '.'))
    for (const c of cols) {
      if (run_ === null) { run_ = { first: c, last: c, size: c.size, start: c.seqs[0], end: c.seqs[c.seqs.length - 1] }; report.trace.push({ opens: [c.seqs[0], c.seqs[c.seqs.length - 1]], size: c.size }); continue }
      const raw = Math.max(signatureScore(c, run_.first), signatureScore(c, run_.last))
      const primary = pEq(run_.first.paths?.[0], c.paths?.[0]) || pEq(run_.last.paths?.[0], c.paths?.[0])
      const wouldFit = run_.size + c.size <= LIMIT
      const merges = (raw >= TAU || primary) && wouldFit
      report.trace.push({
        pair: [run_.start, run_.end, '->', c.seqs[0], c.seqs[c.seqs.length - 1]],
        score: Number(raw.toFixed(3)), primary, tau: TAU, runningSize: run_.size, nextSize: c.size, limit: LIMIT,
        merges, reason: merges ? (raw < TAU ? 'primary-path merge' : 'score merge') : !wouldFit ? 'size limit' : 'split (score<tau, primary differs)',
      })
      run_ = merges
        ? { first: run_.first, last: c, size: run_.size + c.size, start: run_.start, end: c.seqs[c.seqs.length - 1] }
        : { first: c, last: c, size: c.size, start: c.seqs[0], end: c.seqs[c.seqs.length - 1] }
    }
    const recomposed = composeChapters(events, spanStart, anchor, stFinal.collections, { mergeThreshold: TAU, chapterLimit: LIMIT })
    report.notes.push(`offline recomposition over ${spanStart}..${anchor}: ${recomposed.chapters.length} chapter(s)`)

    // --- M-criteria on the LIVE archives (r29 compaction chapters + the fork)
    const allChapters = stFinal.chapters
    const sorted = [...stFinal.collections].sort((a, b) => a.seqs[0] - b.seqs[0])
    const fullyIn = (coll, ch) => coll.seqs.every((sq) => sq >= ch.startSeq && sq <= ch.endSeq)
    const mergedCh = allChapters.find((c) => sorted.filter((k) => fullyIn(k, c)).length >= 2)
    const compactionArchivedEarly = report.turns.some((t, idx) => idx < QUESTIONS.length - 1 && (t.chaptersAfter || []).length > 0)
    record('M1 an automatic compaction archived chapters mid-session (composer in the engine path)', compactionArchivedEarly, {
      when: report.turns.filter((t) => (t.chaptersAfter || []).length > 0).map((t) => t.turn),
    })
    record('M2 a chapter MERGED two adjacent collections (primary-path rule, live data)', mergedCh !== undefined, {
      title: mergedCh?.title?.slice(0, 40), range: mergedCh ? [mergedCh.startSeq, mergedCh.endSeq] : null,
      collectionsInIt: mergedCh ? sorted.filter((k) => fullyIn(k, mergedCh)).length : 0,
    })
    // topic-switch integrity: no chapter spans a primary-path change
    const switches = []
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i]
      const pp = (prev.paths || [])[0], cp = (cur.paths || [])[0]
      if (pp && cp && !pEq(pp, cp)) switches.push({ after: prev.seqs[prev.seqs.length - 1], from: pp, to: cp })
    }
    const badSpan = []
    for (const sp of switches) {
      for (const c of allChapters) {
        const beforeColl = sorted.find((k) => k.seqs[k.seqs.length - 1] === sp.after)
        const afterColl = sorted.find((k) => k.seqs[0] > sp.after)
        if (beforeColl && afterColl && c.startSeq <= beforeColl.seqs[0] && c.endSeq >= afterColl.seqs[afterColl.seqs.length - 1]) {
          badSpan.push({ chapter: c.number, from: sp.from, to: sp.to })
        }
      }
    }
    record('M3 topic changes never share a chapter (split integrity on live archives)', switches.length >= 2 && badSpan.length === 0, {
      switches: switches.map((sp) => `${sp.from}->${sp.to}`), badSpan,
    })
    const gaps = sorted.filter((k) => !allChapters.some((c) => fullyIn(k, c))).map((k) => k.seqs)
    record('M4 every completed collection is archived (compaction or fork) — nothing lost', gaps.length === 0, {
      collections: sorted.length, gaps,
    })

    const fr = await ctx.commands.execute(parent, '/chapters-fork', [], new AbortController().signal)
    const res = fr?.result ?? fr
    const frText = String(res?.text ?? JSON.stringify(fr)).slice(0, 300)
    record('F3 /chapters-fork completed cleanly (remainder or honest nothing-new)', res?.kind === 'success', {
      text: frText,
      finalChapters: (await store.get(parentId)).chapters.map((c) => ({ n: c.number, title: c.title.slice(0, 30), range: [c.startSeq, c.endSeq] })),
    })
    const childId = frText.match(/ch-[0-9a-f-]+/)?.[0] ?? null
    if (childId !== null) {
      try {
        const obs = await ctx.sessionQuery.observeSession(childId)
        const notice = (obs?.events ?? []).find((e) => e.seq === 0)
        const noticeText = JSON.stringify(notice?.data?.content ?? '')
        record('F4 child TOC notice exists and cites chapters', /Continuation:/.test(noticeText), {
          child: childId, cites: (noticeText.match(/\.dsh-chapters/g) ?? []).length,
        })
      } catch (e) { report.notes.push('child observe: ' + String(e?.message ?? e)) }
    }
    const stEnd = await store.get(parentId)
    const gapsEnd = sorted.filter((k) => !stEnd.chapters.some((c) => fullyIn(k, c)))
    record('M5 final coverage: all collections archived after fork', gapsEnd.length === 0, { gaps: gapsEnd.map((k) => k.seqs) })

    try { await ph.dispose?.() } catch { /* teardown best-effort */ }
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
