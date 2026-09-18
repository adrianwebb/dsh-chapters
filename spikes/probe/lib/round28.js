/**
 * Round 28 — the topic-mapping live test: use the harness like a human on
 * THIS project (real research questions, real answers), accumulate turn
 * signatures (paths/terms), then fork and watch the composer merge adjacent
 * same-topic collections into one chapter and split on topic changes or the
 * size limit. Every decision is monitored: per-turn signatures, pairwise
 * overlap scores vs τ, the resulting chapter ranges/titles.
 *
 * The questions deliberately hit DIFFERENT areas of the repo; Q1/Q2 share
 * src/render.ts so a merge must happen there, while every switch (render→
 * sync→docs→client) must split.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { acquireChapterStore } from '../../../lib/store.js'
import { composeChapters, signatureScore } from '../../../lib/compose.js'
import { turnSpanOf, extractSignature } from '../../../lib/signature.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-28.json')
const report = { round: 28, startedAt: new Date().toISOString(), probes: [], turns: [], trace: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })
const READ_ONLY = ' Use ONLY file-read tools (read, grep, glob) — do not run shell commands, do not edit anything. Then give me a short answer with file:line citations.'

const QUESTIONS = [
  { topic: 'render', q: 'In src/render.ts: how does the chapter renderer decide which tool results get deferred to artifact files and which stay inline in the chapter body? Where exactly is the threshold and where is the redaction applied?' },
  { topic: 'render', q: 'Still in src/render.ts (and src/archive.ts): what exactly does the sha256 in a chapter file\u2019s frontmatter cover, how is the file name chosen from the title, and who re-verifies that hash later?' },
  { topic: 'sync', q: 'In src/sync.ts and src/gitops.ts: list the exact order of operations a single sync pass performs, and where is the rule that sync must NEVER throw into the conversation path enforced? What makes it fast-forward only?' },
  { topic: 'docs', q: 'In docs/knowledge-repo.md: what are the seven invariants of section 1? One line each. Then in section 4, what is the overlap-score formula for merging collections and what does the size limit guard do?' },
  { topic: 'client', q: 'In src/client/: how does the fork button know which session row is current, what does it send, and which host command does it trigger? Cite the lines.' },
]

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    const store = (await acquireChapterStore(ctx.storageDomain)).store
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch {}

    const parentId = `p28-${randomUUID().slice(0, 8)}`
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
      let st = await store.get(parentId)
      const sig = st.collections[st.collections.length - 1]
      const comps = evs().filter((e) => e.type === 'compaction/summary').length
      report.turns.push({
        turn: i + 1, topic: q.topic, ended,
        compactionsSoFar: comps,
        collectionCount: st.collections.length,
        sig: sig ? { seqs: sig.seqs, paths: sig.paths.slice(0, 6), commands: sig.commands.slice(0, 4), terms: sig.terms.slice(0, 8), size: sig.size } : null,
      })
      try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
      record(`T${i + 1} (${q.topic}) turn completed + signature collected`, ended && st.collections.length >= i + 1 && sig !== undefined, {
        seqs: sig?.seqs, paths: sig?.paths?.slice(0, 4), size: sig?.size,
      })
      if (!ended) { report.notes.push(`turn ${i + 1} timed out at 22min; continuing with what we have`); break }
    }

    // --- fork: the composer runs over the accumulated collections (S4).
    const stFinal = await store.get(parentId)
    const anchor = Math.max(...evs().filter((e) => e.type === 'turn/end').map((e) => e.seq))
    const events = evs()

    // Offline decision trace FIRST — mirrors the composer exactly: the merge
    // test is max(score(c, first), score(c, last)) against the MEMBER
    // collections (not the union), plus the running size limit. Same
    // watermark expression as the fork handler.
    const TAU = 0.3, LIMIT = 8000
    const lastArchived = stFinal.chapters.reduce((m, c) => Math.max(m, c.endSeq), 0)
    const spanStart = lastArchived > 0 ? lastArchived + 1 : 0
    const cols = [...stFinal.collections]
      .filter((c) => c.seqs.length > 0 && c.seqs[0] >= spanStart && c.seqs[c.seqs.length - 1] <= anchor)
      .sort((a, b) => a.seqs[0] - b.seqs[0])
    let run = null
    for (const c of cols) {
      if (run === null) { run = { first: c, last: c, size: c.size, start: c.seqs[0], end: c.seqs[c.seqs.length - 1] }; report.trace.push({ opens: [c.seqs[0], c.seqs[c.seqs.length - 1]], size: c.size }); continue }
      const raw = Math.max(signatureScore(c, run.first), signatureScore(c, run.last))
      const wouldFit = run.size + c.size <= LIMIT
      const merges = raw >= TAU && wouldFit
      report.trace.push({
        pair: [run.start, run.end, '->', c.seqs[0], c.seqs[c.seqs.length - 1]],
        score: Number(raw.toFixed(3)), tau: TAU, runningSize: run.size, nextSize: c.size, limit: LIMIT,
        merges, reason: raw < TAU ? 'score<tau (topic change)' : !wouldFit ? 'size limit' : 'merge',
      })
      if (merges) { run = { first: run.first, last: c, size: run.size + c.size, start: run.start, end: c.seqs[c.seqs.length - 1] } }
      else { run = { first: c, last: c, size: c.size, start: c.seqs[0], end: c.seqs[c.seqs.length - 1] } }
    }

    const composed = composeChapters(events, spanStart, anchor, stFinal.collections, { mergeThreshold: TAU, chapterLimit: LIMIT })
    record('F1 composer produced >1 chapter from 5 real turns (splits happened)', composed.chapters.length >= 2, {
      chapters: composed.chapters.map((ch) => ({ title: ch.title.slice(0, 40), range: [ch.startSeq, ch.endSeq], summary: (ch.summary ?? '').slice(0, 80) })),
      notes: composed.notes, unarchived: composed.unarchivedSeqs,
    })
    const mergedOne = composed.chapters.find((ch) => {
      const covering = cols.filter((c) => c.seqs.every((s) => s >= ch.startSeq && s <= ch.endSeq))
      return covering.length >= 2
    })
    record('F2 at least one chapter MERGED multiple adjacent collections (the render pair)', mergedOne !== undefined, {
      title: mergedOne?.title?.slice(0, 60), range: mergedOne ? [mergedOne.startSeq, mergedOne.endSeq] : null,
      collectionsInIt: mergedOne ? cols.filter((c) => c.seqs.every((s) => s >= mergedOne.startSeq && s <= mergedOne.endSeq)).length : 0,
    })

    const fr = await ctx.commands.execute(parent, '/chapters-fork', [], new AbortController().signal)
    const frText = String(fr?.text ?? JSON.stringify(fr)).slice(0, 300)
    const stAfter = await store.get(parentId)
    record('F3 /chapters-fork archived + created a continuation child', fr?.kind === 'success' && stAfter.chapters.length >= 2, {
      text: frText, chapters: stAfter.chapters.map((c) => ({ n: c.number, title: c.title.slice(0, 36), range: [c.startSeq, c.endSeq], topics: c.topics.slice(0, 5) })),
    })

    const childId = (frText.match(/ch-[0-9a-f-]+/)?.[0]) ?? null
    if (childId !== null) {
      try {
        const obs = await ctx.sessionQuery.observeSession(childId)
        const notice = (obs?.events ?? []).find((e) => e.seq === 0)
        const noticeText = JSON.stringify(notice?.data?.content ?? '')
        record('F4 child TOC notice lists the composed chapters', noticeText.includes('render') || (notice?.data != null && /chapters/i.test(noticeText)), { chaptersInNotice: (noticeText.match(/\.dsh-chapters/g) ?? []).length, sample: noticeText.slice(0, 160) })
      } catch (e) { report.notes.push('child observe: ' + String(e?.message ?? e)) }
    }
    try { await ph.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => { report.fatal = String(e?.stack ?? e); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(1) }) }, 4000)
}
