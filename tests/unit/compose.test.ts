/**
 * compose.ts — topic-sequential composition (record §4.2–4.4). The scenario
 * the user specified: two adjacent collections on the same task → one
 * chapter; a new task → split; size and τ both force splits; incomplete
 * content stays live and is noted, never silently included.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeChapters, signatureScore, type ComposeConfig } from '../../src/compose.ts'
import type { CollectionSignature } from '../../src/signature.ts'
import type { SessionEventLike } from '../../src/types.ts'

const CONFIG: ComposeConfig = { mergeThreshold: 0.3, chapterLimit: 8000 }

const user = (seq: number, text: string): SessionEventLike => ({
  type: 'user/message', seq, data: { id: `u${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const assistant = (seq: number, text: string): SessionEventLike => ({
  type: 'assistant/message', seq, data: { id: `a${seq}`, role: 'assistant', source: { kind: 'model' }, message: { content: [{ type: 'text', text }] } },
})
const turnEnd = (seq: number): SessionEventLike => ({ type: 'turn/end', seq, data: { turn: seq } })

const sig = (seqs: number[], paths: string[], commands: string[], terms: string[], size = 200): CollectionSignature =>
  ({ seqs, paths, commands, terms, size, by: 'deterministic' })

// Task A: auth work (turns 1-2 share src/auth/*), Task B: tests (turn 3),
// Task A resumes (turn 4 touches the same files).
const events: SessionEventLike[] = [
  user(0, 'Fix the auth middleware in src/auth/middleware.ts'), assistant(1, 'Patching src/auth/middleware.ts'), turnEnd(2),
  user(3, 'Also update src/auth/token.ts for the new expiry'), assistant(4, 'Done, src/auth/token.ts updated'), turnEnd(5),
  user(6, 'Write integration tests for the billing module'), assistant(7, 'Added tests/billing.test.ts'), turnEnd(8),
  user(9, 'Back to auth: the middleware still drops the refresh header'), assistant(10, 'Fixed in src/auth/middleware.ts'), turnEnd(11),
]
const collections: CollectionSignature[] = [
  sig([0, 1, 2], ['src/auth/middleware.ts'], ['edit'], ['auth', 'middleware']),
  sig([3, 4, 5], ['src/auth/middleware.ts', 'src/auth/token.ts'], ['edit'], ['auth', 'middleware', 'token', 'expiry']),
  sig([6, 7, 8], ['tests/billing.test.ts'], ['write'], ['billing', 'tests', 'integration']),
  sig([9, 10, 11], ['src/auth/middleware.ts'], ['edit'], ['auth', 'middleware', 'refresh']),
]

test('adjacent same-task collections merge; a new task splits; the task resuming splits again', () => {
  const { chapters } = composeChapters(events, 0, 11, collections, CONFIG)
  assert.equal(chapters.length, 3)
  assert.deepEqual([chapters[0]!.startSeq, chapters[0]!.endSeq], [0, 5])   // turns 1-2 (auth task)
  assert.deepEqual([chapters[1]!.startSeq, chapters[1]!.endSeq], [6, 8])    // turn 3 (billing)
  assert.deepEqual([chapters[2]!.startSeq, chapters[2]!.endSeq], [9, 11])   // turn 4 (auth again)
  // the merge is what produced the wide first chapter
  assert.ok(chapters[0]!.summary.length > 0)
})

test('τ boundary: high overlap merges, disjoint signals do not (score-based, not vibes)', () => {
  const a = sig([0], ['src/x.ts'], ['read'], ['alpha'])
  const a2 = sig([1], ['src/x.ts'], ['read'], ['alpha', 'beta'])
  const b = sig([2], ['src/zzz.ts'], ['grep'], ['omega'])
  assert.ok(signatureScore(a, a2) >= CONFIG.mergeThreshold)
  assert.ok(signatureScore(a, b) < CONFIG.mergeThreshold)
  const merged = composeChapters(events, 0, 1, [a, a2], { mergeThreshold: 0.3, chapterLimit: 8000 })
  assert.equal(merged.chapters.length, 1)
  const split = composeChapters(events, 0, 2, [a, b], { mergeThreshold: 0.3, chapterLimit: 8000 })
  assert.equal(split.chapters.length, 2)
})

test('size limit forces a split even for identical signals', () => {
  const a = sig([0], ['src/x.ts'], ['read'], ['alpha'], 6000)
  const a2 = sig([1], ['src/x.ts'], ['read'], ['alpha'], 6000)
  const r = composeChapters(events, 0, 1, [a, a2], { mergeThreshold: 0.3, chapterLimit: 8000 })
  assert.equal(r.chapters.length, 2) // 6000+6000 > 8000
})

test('completeness guard: span cutting a turn leaves it live and noted, never archived', () => {
  // span ends at seq 7 — mid-turn (the turn ends at 8)
  const r = composeChapters(events, 0, 7, collections, CONFIG)
  const covered = r.chapters.flatMap((c) => Array.from({ length: c.endSeq - c.startSeq + 1 }, (_, i) => c.startSeq + i))
  assert.ok(covered.every((s) => s <= 7), 'no archived seq past the span end')
  // the incomplete turn's IN-SPAN events (6,7) are unarchived; its turn-end (8) is outside the span entirely
  assert.ok(r.unarchivedSeqs.includes(6) && r.unarchivedSeqs.includes(7), 'incomplete turn content stays live')
  assert.ok(!r.unarchivedSeqs.includes(8), 'seqs outside the span are not the span\'s concern')
  assert.ok(r.notes.some((n) => n.includes('stays live')))
  // and the chapter that would have included turn 3 ends at the last COMPLETED turn inside the span
  const mid = r.chapters.find((c) => c.startSeq === 0)
  assert.equal(mid?.endSeq, 5)
})

test('no completed collections → no chapters (caller falls back to legacy segmentation)', () => {
  const r = composeChapters(events, 0, 11, [], CONFIG)
  assert.equal(r.chapters.length, 0)
  assert.ok(r.notes.some((n) => n.includes('legacy')))
  assert.equal(r.unarchivedSeqs.length, 12)
})

test('deterministic: same input, byte-identical output', () => {
  const a = JSON.stringify(composeChapters(events, 0, 11, collections, CONFIG))
  const b = JSON.stringify(composeChapters(events, 0, 11, collections, CONFIG))
  assert.equal(a, b)
})

test('collections outside the span are ignored (fork watermark semantics)', () => {
  const r = composeChapters(events, 6, 11, collections, CONFIG)
  assert.deepEqual(r.chapters.map((c) => [c.startSeq, c.endSeq]), [[6, 8], [9, 11]])
})

// r28: primary-path merge — real research turns have many paths each, so the
// union dilutes the Jaccard below tau even for one topic (measured 0.077).
test('primary-path rule: same first path merges despite low overlap score; different first paths do not', () => {
  const wide = (n: number, first: string): CollectionSignature => ({
    seqs: [n * 10, n * 10 + 1], paths: [first, ...Array.from({ length: 5 }, (_, i) => `src/mod${n}${i}/x.ts`)],
    commands: [], terms: [`alpha${n}`, `beta${n}`, `gamma${n}`], size: 500, by: 'deterministic',
  })
  const events = [{ type: 'user/message', seq: 0, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] } }] as never as import('../../src/types.ts').SessionEventLike[]
  // same topic: both primary src/render.ts
  const pair = [wide(0, 'src/render.ts'), wide(1, 'src/render.ts')]
  const CFG: ComposeConfig = { mergeThreshold: 0.3, chapterLimit: 8000 }
  const merged = composeChapters(events, 0, 999, pair, CFG)
  assert.equal(merged.chapters.length, 1, 'primary match merges the pair')
  // different topics: different primaries
  const split = [wide(0, 'src/render.ts'), wide(1, 'src/sync.ts')]
  const splitRes = composeChapters(events, 0, 999, split, CFG)
  assert.equal(splitRes.chapters.length, 2, 'different primary splits')
  // prefix tolerance: prose dir vs file spelling
  const tol = composeChapters(events, 0, 999, [wide(0, 'src/render'), wide(1, 'src/render.ts')], CFG)
  assert.equal(tol.chapters.length, 1, "'src/render' and 'src/render.ts' are one file")
})
