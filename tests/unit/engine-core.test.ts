/**
 * L0/L1 tests for engine-core: the TOC accumulation loop and the durable-log
 * citation rule — the two places where an engine-path bug would silently make
 * a chapter unreachable or archive the wrong text. Pure fakes, no harness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { CHAPTERS_PROVIDER, DETERMINISTIC_MODEL, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG, buildFinalizedChapter, chapterPathFor, deriveIdentity, engineRecord, extractCheckpointBlocks, findOpenCompactionId, parseTocState, planSummarize, resolveOriginalEvent, type EngineMessage, type EngineSession, type EngineSessionEvent, extractPlot } from '../../src/engine-core.ts'
import { reserve, freshSession } from '../../src/registry.ts'
import { ENGINE_CONFIG_DEFAULTS } from '../../src/engine-core.ts'

const cfg = ENGINE_CONFIG_DEFAULTS

const msg = (role: string, text: string): EngineMessage => ({ role, content: [{ type: 'text', text }] })
const block = (inner: string): string => `${SUMMARY_OPEN_TAG}${inner}${SUMMARY_CLOSE_TAG}`

const fakeSession = (events: EngineSessionEvent[]): EngineSession => {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  return {
    id: 's-1',
    seq: Math.max(-1, ...events.map((e) => e.seq)) + 1,
    eventAt: (seq) => bySeq.get(seq), }
}

const ev = (seq: number, type: string, data: Record<string, unknown> = {}, extra: Partial<EngineSessionEvent> = {}): EngineSessionEvent =>
  ({ seq, type, data, ...extra })

// ---------------------------------------------------------------- checkpoints

test('extractCheckpointBlocks finds nested tag regions across messages', () => {
  const msgs = [
    msg('user', `intro\n${block('1. [A](p/a.md) — s1')}\ntail`),
    msg('assistant', 'ok'),
    msg('user', block('2. [B](p/b.md) — s2')),
  ]
  assert.deepEqual(extractCheckpointBlocks(msgs), ['1. [A](p/a.md) — s1', '2. [B](p/b.md) — s2'])
})

test('parseTocState: bullets accumulate in order and dedup by path; prose carries, never drops', () => {
  const { bullets, carriedProse } = parseTocState([
    '1. [First](a.md) — one\n2. [Second](b.md) — two',
    '2. [Second dup](b.md) — two again\n3. [Third](c.md) — three',
    '## Primary Request\n- user asked things', // LLM-style checkpoint content from `basic`
  ])
  assert.deepEqual(bullets.map((b) => b.path), ['a.md', 'b.md', 'c.md'])
  assert.equal(bullets.length, 3)
  assert.equal(carriedProse.length, 1)
  assert.match(carriedProse[0]!, /Primary Request/)
})

// ---------------------------------------------------------------- transaction scan

test('findOpenCompactionId matches start/end by id across multiple transactions', () => {
  const closed = fakeSession([
    ev(0, 'compaction/start', { compactionId: 'A' }),
    ev(1, 'compaction/summary', { compactionId: 'A' }),
    ev(2, 'compaction/end', { compactionId: 'A' }),
    ev(3, 'compaction/start', { compactionId: 'B' }),
    ev(4, 'compaction/end', { compactionId: 'B' }),
  ])
  assert.equal(findOpenCompactionId(closed), null)

  const open = fakeSession([
    ev(0, 'compaction/start', { compactionId: 'A' }),
    ev(1, 'compaction/end', { compactionId: 'A' }),
    ev(2, 'compaction/start', { compactionId: 'B' }), // no end — this is the open transaction
  ])
  assert.equal(findOpenCompactionId(open), 'B')
})

// ---------------------------------------------------------------- citation chains

test('resolveOriginalEvent follows single-cited tool/result chains to the pre-prune original', () => {
  const s = fakeSession([
    ev(5, 'tool/result', { message: { content: [{ type: 'text', text: 'FULL OUTPUT' }] } }),
    ev(20, 'tool/result', { message: { content: [{ type: 'text', text: 'head…tail' }] } }, { sourceEventSeqs: [5] }),
  ])
  assert.equal(resolveOriginalEvent(s, 20)?.seq, 5)
  assert.equal(resolveOriginalEvent(s, 5)?.seq, 5) // no citation: itself
})

test('citation chains stop at non-tool events — checkpoints never drag lifecycle into bodies', () => {
  const s = fakeSession([
    ev(0, 'user/message', { content: [{ type: 'text', text: 'old' }] }),
    ev(1, 'compaction/start', { compactionId: 'A' }),
    ev(2, 'user/message', { content: [{ type: 'text', text: 'checkpoint' }] }, { sourceEventSeqs: [1, 2, 0] }),
  ])
  assert.equal(resolveOriginalEvent(s, 2)?.seq, 2) // user/message: chain rule doesn't apply
})

test('a citation cycle throws instead of hanging', () => {
  const s = fakeSession([
    ev(1, 'tool/result', {}, { sourceEventSeqs: [2] }),
    ev(2, 'tool/result', {}, { sourceEventSeqs: [1] }),
  ])
  assert.throws(() => resolveOriginalEvent(s, 1), /cycle/)
})

// ---------------------------------------------------------------- identity + planning

test('deriveIdentity: first non-checkpoint user line becomes the title, truncated with an ellipsis', () => {
  const long = 'x'.repeat(100)
  const { title } = deriveIdentity([msg('user', block('1. [a](a.md) — s')), msg('user', `${long}\nmore`)], true)
  assert.equal(title.length, 73) // 72 chars + ellipsis
  assert.ok(title.endsWith('…'))
})

test('planSummarize reserves by compactionId, cites a deterministic path, and merge-forwards prior bullets', async () => {
  let state = freshSession('child')
  state = { ...state, rootSession: 'root' }
  const input = {
    messages: [
      msg('user', block('1. [Earlier](.dsh-chapters/root/chapters/001-earlier.md) — was first')),
      msg('user', 'Fix the flaky migration test'),
      msg('assistant', 'on it'),
    ], }
  const { plan, state: next } = planSummarize(
    fakeSession([]), state, input, cfg,
    (s, attemptId, count) => reserve(s, attemptId, count), 'cid-9',
  )
  assert.deepEqual(plan.numbers, [1])
  assert.deepEqual(next.reservations['compaction:cid-9'], [1])
  assert.ok(plan.chapter.path.startsWith('.dsh-chapters/root/chapters/001-'))
  // accumulation: prior bullet first, new one second, both numbered by renderIndex
  const lines = plan.tocText.split('\n\n').at(-1)!.split('\n')
  assert.deepEqual(lines.map((l) => l.slice(0, 1)), ['1', '2'])
  assert.match(plan.tocText, /was first/)         // prior summary survived
  assert.match(plan.tocText, /Fix the flaky/)     // new identity present
  // retry-safe: same compactionId re-reserves the SAME numbers, TOC unchanged
  const again = planSummarize(fakeSession([]), next, input, cfg, reserve, 'cid-9')
  assert.deepEqual(again.plan.numbers, plan.numbers)
  assert.equal(again.plan.tocText, plan.tocText)
})

test('carried LLM prose appears in the TOC text rather than vanishing', () => {
  const state = freshSession('s')
  const input = { messages: [msg('user', block('## Primary Request\n- keep me exactly'))] }
  const { plan } = planSummarize(fakeSession([]), state, input, cfg, reserve, 'c1')
  assert.match(plan.tocText, /keep me exactly/)
})

// ---------------------------------------------------------------- finalization

test('buildFinalizedChapter renders citation-resolved originals, pruned text nowhere', () => {
  const surfaceEvents = [
    ev(0, 'user/message', { content: [{ type: 'text', text: 'do the migration' }] }),
    ev(5, 'tool/result', { message: { source: { kind: 'tool', callId: 'c4' }, content: [{ type: 'tool-result', toolCallId: 'c4', content: [{ type: 'text', text: 'THE COMPLETE OUTPUT that the pruner truncated on the surface'.repeat(30) }] }] } }),
    ev(6, 'tool/call', { callId: 'c4', name: 'bash', arguments: '{}' }),
    ev(20, 'tool/result', { message: { source: { kind: 'tool', callId: 'c4' }, content: [{ type: 'tool-result', toolCallId: 'c4', content: [{ type: 'text', text: 'THE … run' }] }] } }, { sourceEventSeqs: [5] }),
  ]
  const s = fakeSession(surfaceEvents)
  const plan = {
    tocText: '', numbers: [1],
    chapter: { title: 'do the migration', summary: '1 user / 0 assistant messages', path: 'x.md' }, }
  const rendered = buildFinalizedChapter(s, [0, 6, 20], plan, cfg)
  // The oversized original defers per the default rule (no model overrides on the
  // automatic path) — but "deferred" means a reference line + the artifact holds
  // EVERY BYTE: full text present in artifacts, never the pruned version anywhere.
  assert.ok(rendered.artifacts.length >= 1, 'oversized result should defer to an artifact')
  assert.ok(rendered.artifacts.some((a) => a.content.includes('COMPLETE OUTPUT')))
  assert.ok(rendered.markdown.includes('artifacts/'))                       // reference line
  assert.ok(!rendered.markdown.includes('THE … run'))                        // prune marker never in body
  assert.ok(!rendered.artifacts.some((a) => a.content.includes('THE … run'))) // nor in the artifact
  assert.ok(rendered.markdown.includes('bash'))                              // invocation always inline
  // the resolved original (seq 5) widens the recorded range below the surface bounds
  assert.ok(rendered.range.startSeq <= 0 && rendered.range.endSeq >= 20)
})

test('engineRecord keeps the authoritative shadowedSeqs', () => {
  const plan = { tocText: '', numbers: [7], chapter: { title: 't', summary: 's', path: 'p' } }
  const rendered = {
    range: { title: 't', summary: 's', startSeq: 3, endSeq: 9 },
    markdown: '', artifacts: [],
    stats: { estimatedTokens: 5, estimatedBytes: 3, events: 2, toolCalls: 0, toolResultsInlined: 0, toolResultsDeferred: 0, overTarget: false, unrenderedSeqs: [] }, }
  const rec = engineRecord(plan, [4, 9], rendered as never, '/abs/p.md', 'a'.repeat(64))
  assert.equal(rec.number, 7)
  assert.deepEqual(rec.shadowedSeqs, [4, 9])
})

// ---------------------------------------------------------------- vocabulary pins

test('provider/model tags stay distinct from message-source kinds', () => {
  assert.equal(CHAPTERS_PROVIDER, 'dsh-chapters')
  assert.equal(DETERMINISTIC_MODEL, 'deterministic')
})

test('checkpoint tags still match the installed host bundle (drift => re-anchor, never relax)', (t) => {
  const bundle = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
  if (!existsSync(bundle)) {
    t.skip(`installed host bundle not readable at ${bundle}; pin above still stands`)
    return
  }
  const src = readFileSync(bundle, 'utf8')
  assert.ok(src.includes(SUMMARY_OPEN_TAG), 'host SUMMARY_OPEN_TAG drifted')
  assert.ok(src.includes(SUMMARY_CLOSE_TAG), 'host SUMMARY_CLOSE_TAG drifted')
})

test('chapterPathFor: number-padded, slug-stable, under the configured root', () => {
  assert.equal(
    chapterPathFor(cfg, 'root-1', 3, 'Fix: the migration?!'),
    '.dsh-chapters/root-1/chapters/003-fix-the-migration.md',
  )
})

test('deriveIdentity ignores harness-injected user messages when titling', async () => {
  const mod = await import('../../src/engine-core.ts')
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier ones.\n\nWorkspace: /tmp' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>be careful</system-reminder>' }] },
    { role: 'user', content: [{ type: 'text', text: 'Refactor the auth middleware for session rotation' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Plan: split token issuance…' }] },
  ] as never
  const id = mod.deriveIdentity(msgs, false)
  assert.match(id.title, /Refactor the auth middleware/)
})

// ------------------------------------------- r29: topic composition in compaction

import { reconstructShadowedSeqs, buildFinalizedChapters } from '../../src/engine-core.ts'
import type { ChapterRange } from '../../src/types.ts'

/** A session that behaves like the real host class for the region mapping:
 * surface nodes + deriveEventMessage (events with string data.text derive;
 * others are invisible to the surface, like turn/end). */
const mapSession = (events: EngineSessionEvent[]): EngineSession => ({
  ...fakeSession(events),
  surface: { nodes: events.map((e) => ({ seq: e.seq })) },
  deriveEventMessage: (e) => typeof e.data?.text === 'string'
    ? { role: String(e.data.role ?? 'user'), content: [{ type: 'text', text: String(e.data.text) }] }
    : null, })
const dmsg = (seq: number, text: string, role = 'user'): EngineSessionEvent =>
  ev(seq, role === 'user' ? 'user/message' : 'assistant/message', { text, role })
const derived = (s: EngineSession, seqs: number[]): EngineMessage[] =>
  seqs.map((q) => s.deriveEventMessage!(s.eventAt(q)!)).filter((m): m is EngineMessage => m !== null)

test('reconstructShadowedSeqs: unique contiguous run maps back exactly; head system message tolerated', () => {
  const s = mapSession([dmsg(1, 'a'), dmsg(2, 'b'), dmsg(3, 'c'), dmsg(4, 'd'), ev(5, 'turn/end')])
  assert.deepEqual(reconstructShadowedSeqs(s, { messages: derived(s, [2, 3]) }), [2, 3])
  // system head prepended (buildSummarizationInput): still matches the region
  const withHead = { messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, ...derived(s, [1, 2])] }
  assert.deepEqual(reconstructShadowedSeqs(s, withHead), [1, 2])
})

test('reconstructShadowedSeqs: ambiguous duplicate run ⇒ null (legacy is the honest fallback)', () => {
  const s = mapSession([dmsg(1, 'x'), dmsg(2, 'y'), dmsg(3, 'y'), dmsg(4, 'z')])
  assert.equal(reconstructShadowedSeqs(s, { messages: derived(s, [2]) }), null)
  // and without the host class members, never guesses:
  assert.equal(reconstructShadowedSeqs(fakeSession([]), { messages: [] }), null)
})

test('planSummarize with composition: reserves N, cites N bullets, manifest holds ranges; retry reuses', () => {
  const s0 = freshSession('root-x')
  const composition: ChapterRange[] = [
    { title: 'Render A', summary: 's1', startSeq: 0, endSeq: 2 },
    { title: 'Sync B', summary: 's2', startSeq: 3, endSeq: 5 },
  ]
  const r1 = planSummarize(fakeSession([]), s0, { messages: [] }, cfg,
    (st, aid, n) => reserve(st, aid, n), 'cid-c', composition)
  assert.equal(r1.plan.numbers.length, 2)
  assert.equal(r1.plan.chapters?.length, 2)
  assert.ok(r1.plan.tocText.includes('2 chapter(s)'), r1.plan.tocText.slice(0, 120))
  for (const ch of r1.plan.chapters!) assert.ok(r1.plan.tocText.includes(ch.path), `TOC must cite ${ch.path}`)
  // idempotent retry of the same transaction reuses numbers (never duplicates)
  const r2 = planSummarize(fakeSession([]), r1.state, { messages: [] }, cfg,
    (st, aid, n) => reserve(st, aid, n), 'cid-c', composition)
  assert.deepEqual(r2.plan.numbers, r1.plan.numbers)
  // no composition ⇒ legacy single plan (unchanged behavior)
  const leg = planSummarize(fakeSession([]), s0, { messages: [msg('user', 'hello there about src/render.ts work')] }, cfg,
    (st, aid, n) => reserve(st, aid, n), 'cid-l', null)
  assert.equal(leg.plan.numbers.length, 1)
  assert.equal(leg.plan.chapters, undefined)
})

test('buildFinalizedChapters renders manifest ranges; coverage drift throws loudly', () => {
  const events = [
    dmsg(0, 'work on src/render.ts'), ev(1, 'turn/end'),
    dmsg(2, 'work on src/sync.ts'), ev(3, 'turn/end'),
  ]
  const s = mapSession(events)
  const mkPlan = (ch: { title: string; startSeq: number; endSeq: number }[]): import('../../src/engine-core.ts').SummarizePlan => ({
    tocText: '', numbers: ch.map((_, i) => i + 1),
    chapter: { title: ch[0]!.title, summary: '', path: 'p' },
    chapters: ch.map((c, i) => ({ number: i + 1, path: `${i + 1}.md`, title: c.title, summary: '', startSeq: c.startSeq, endSeq: c.endSeq })), })
  const ok = buildFinalizedChapters(s, [0, 1, 2, 3], mkPlan([
    { title: 'Render', startSeq: 0, endSeq: 1 }, { title: 'Sync', startSeq: 2, endSeq: 3 },
  ]), cfg)
  assert.equal(ok.length, 2)
  assert.deepEqual([ok[0]!.range.startSeq, ok[0]!.range.endSeq], [0, 1])
  assert.deepEqual([ok[1]!.range.startSeq, ok[1]!.range.endSeq], [2, 3])
  // drift: manifest starts after the shadowed span begins ⇒ throw (defers, never mis-archives)
  assert.throws(() => buildFinalizedChapters(s, [0, 1, 2, 3], mkPlan([
    { title: 'Late', startSeq: 2, endSeq: 3 },
  ]), cfg), /does not cover shadowed/)
  // legacy plan (no chapters) ⇒ exactly today's single render
  const legacy = buildFinalizedChapters(s, [0, 1, 2, 3], {
    tocText: '', numbers: [1], chapter: { title: 'All', summary: 'whole span', path: 'a.md' }, }, cfg)
  assert.equal(legacy.length, 1)
})

// ---------------------------------------------------------------- plot carriage (architecture amendment 2026-09-19)

test('carried plot survives the checkpoint round-trip (render→extract)', () => {
  const base = () => { const st = freshSession('child'); return { ...st, rootSession: 'root' } }
  const input = { messages: [msg('user', 'do the thing'), msg('assistant', 'PLOT: phase one')] }
  const { plan } = planSummarize(fakeSession([]), base(), input, cfg, (s, id, c) => reserve(s, id, c), 'cid-c1', null, 'phase one; next: two')
  // the NEXT compaction shadows this checkpoint's user message: extraction must find the carried plot
  const carried = [msg('user', plan.tocText), msg('assistant', 'continuing without a plot line')]
  assert.equal(extractPlot(carried), 'phase one; next: two')
})

test('extractPlot: latest assistant PLOT wins, checkpoint-carried falls back, cap applies', () => {
  const messages = [
    msg('assistant', 'early\nPLOT:\nObjective A.\nNext: B.'),
    msg('user', 'noise'),
    msg('assistant', 'PLOT: Objective newer hypothesis X; next Y.'),
  ]
  assert.equal(extractPlot(messages), 'Objective newer hypothesis X; next Y.')
  const carried = [msg('user', 'checkpoint text\nPLOT: carried thread'), msg('assistant', 'no plot here')]
  assert.equal(extractPlot(carried), 'carried thread')
  assert.equal(extractPlot([msg('assistant', 'nothing')]), null)
  const huge = msg('assistant', 'PLOT: ' + 'z'.repeat(2000))
  assert.ok((extractPlot([huge]) ?? '').length <= 901, 'capped with ellipsis')
})

test('planSummarize prepends the plot section when given one (and only then)', () => {
  const base = () => { const st = freshSession('child'); return { ...st, rootSession: 'root' } }
  const input = { messages: [msg('user', 'do the thing'), msg('assistant', 'on it')] }
  const { plan } = planSummarize(fakeSession([]), base(), input, cfg, (s, id, c) => reserve(s, id, c), 'cid-p', null, 'Objective X; next Y')
  assert.match(plan.tocText, /Working plot \(model-authored/)
  assert.match(plan.tocText, /Objective X; next Y/)
  const none = planSummarize(fakeSession([]), base(), input, cfg, (s, id, c) => reserve(s, id, c), 'cid-q')
  assert.doesNotMatch(none.plan.tocText, /Working plot/)
})

test('extractPlot: the persona instruction never becomes the plot (2026-09-25 corrupted-plot incident)', () => {
  // Verbatim suffix from presets/chapters/agent.cordis.yml (the line that
  // quotes the marker) — the first real-world run extracted this text as the
  // plot of ALL EIGHT checkpoints across four sessions, and because the
  // result was non-null it also suppressed the bounded elicited fallback.
  const SUFFIX = "Your working directory is /w. When a task spans multiple turns, end each reply with one line beginning 'PLOT:' (max 60 words — objective, current hypothesis, immediate next step). A checkpoint carries this plot forward; if it looks stale, revise it on your next plot line."
  assert.equal(extractPlot([msg('system', SUFFIX), msg('assistant', 'working on it')]), null,
    'system-role instructions are not conversation and can never yield a plot')
  assert.equal(extractPlot([msg('assistant', "per the rules, end each reply with one line beginning 'PLOT:' (max 60 words)")]), null,
    'a marker quoted mid-sentence is an instruction, not a line beginning with it')
  assert.equal(extractPlot([msg('user', "Working plot (model-authored, carried across this checkpoint):\n\nPLOT: ' (max 60 words — objective, current hypothesis, immediate next step). A checkpoint carries this plot forward; if it looks stale, revise it on your next plot line.")]), null,
    'the exact corrupted frame observed in the wild: template echo, rejected — null now correctly triggers elicitation')
  assert.equal(extractPlot([msg('system', SUFFIX), msg('assistant', 'PLOT: fix extraction; next: re-run treeseed')]), 'fix extraction; next: re-run treeseed',
    'a genuine one-line plot wins regardless of instructions present')
})
