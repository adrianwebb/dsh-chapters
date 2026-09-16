/**
 * L0 tests for the pure registry. No harness, no zod, no I/O — the failures
 * these catch are the ones that corrupt a chain: a retry that re-reserves
 * (duplicate archive), a walk that spins on a cycle (hung plugin), an index
 * that pulls in a sibling's chapters (wrong memory), an ancestry rewrite that
 * silently re-homes a subtree.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ancestorPath, appendChapters, buildIndex, freshSession, isFinalized, linkChild, markFinalized, reserve } from '../src/registry.ts'
import type { ChapterRecord } from '../src/archive.ts'

const chapter = (number: number, over: Partial<ChapterRecord> = {}): ChapterRecord => ({
  number,
  path: `.dsh-chapters/root/chapters/${String(number).padStart(3, '0')}-x.md`,
  title: `Chapter ${number}`,
  summary: `summary ${number}`,
  startSeq: number * 10,
  endSeq: number * 10 + 5,
  sha256: 'a'.repeat(64),
  estimatedTokens: 100,
  artifacts: [],
  ...over,
})

// ------------------------------------------------------------------ reservation

test('reserve hands out ascending numbers and advances the counter', () => {
  let s = freshSession('A')
  const r1 = reserve(s, 'A@100', 2)
  assert.deepEqual(r1.numbers, [1, 2])
  const r2 = reserve(r1.state, 'A@200', 1)
  assert.deepEqual(r2.numbers, [3])
  assert.equal(r2.state.nextChapterNumber, 4)
})

test('retrying the same attempt reuses its numbers — idempotent, no duplicate archive', () => {
  const first = reserve(freshSession('A'), 'A@100', 3)
  const retry = reserve(first.state, 'A@100', 3)
  assert.deepEqual(retry.numbers, first.numbers)
  assert.equal(retry.state.nextChapterNumber, 4) // did NOT advance again
})

test('same attempt, different count is refused, not clipped or grown', () => {
  const first = reserve(freshSession('A'), 'A@100', 3)
  assert.throws(() => reserve(first.state, 'A@100', 2), /already holds 3 numbers, requested 2/)
})

test('reserve refuses nonsense counts', () => {
  assert.throws(() => reserve(freshSession('A'), 'k', 0), /positive integer/)
  assert.throws(() => reserve(freshSession('A'), 'k', 1.5), /positive integer/)
})

// ------------------------------------------------------------------ append + link

test('append is idempotent by number; records for OTHER numbers accumulate', () => {
  let s = appendChapters(freshSession('A'), [chapter(1), chapter(2)])
  s = appendChapters(s, [chapter(2)])
  s = appendChapters(s, [chapter(1), chapter(3)])
  assert.deepEqual(s.chapters.map((c) => c.number), [1, 2, 3])
})

test('linkChild sets root+parent once; same link is a no-op; a different link throws', () => {
  const child = freshSession('B')
  const linked = linkChild(child, 'A', 'A')
  assert.equal(linked.parentSession, 'A')
  assert.equal(linked.rootSession, 'A')
  assert.equal(linkChild(linked, 'A', 'A'), linked) // identical: no-op
  assert.throws(() => linkChild(linked, 'C', 'C'), /refusing rewrite/)
})

// ------------------------------------------------------------------ ancestry walk

const table = (rows: Record<string, ReturnType<typeof freshSession>>) => (id: string) => rows[id]

test('ancestorPath returns root-first chronological ids', () => {
  const a = freshSession('A')
  const b = linkChild(freshSession('B'), 'A', 'A')
  const c = linkChild(freshSession('C'), 'B', 'A')
  const get = table({ A: a, B: b, C: c })
  assert.deepEqual(ancestorPath(get, 'C'), ['A', 'B', 'C'])
  assert.deepEqual(ancestorPath(get, 'A'), ['A'])
})

test('a cycle in the links throws instead of hanging', () => {
  const a = linkChild(freshSession('A'), 'B', '?')
  const b = linkChild(freshSession('B'), 'A', '?')
  assert.throws(() => ancestorPath(table({ A: a, B: b }), 'A'), /cycle through A/)
})

test('a missing parent throws — registry corruption, not a silently short path', () => {
  const b = linkChild(freshSession('B'), 'gone', 'gone')
  assert.throws(() => ancestorPath(table({ B: b }), 'B'), /missing state for parent gone/)
})

test('an unknown session is its own path (unregistered root)', () => {
  assert.deepEqual(ancestorPath(table({}), 'Z'), ['Z'])
})

// ------------------------------------------------------------------ the flat index

test('buildIndex: ancestors first, siblings excluded, numbers ordered within a session', () => {
  const a = appendChapters(freshSession('A'), [chapter(2, { number: 2 }), chapter(1)])
  const b = appendChapters(linkChild(freshSession('B'), 'A', 'A'), [chapter(1)])
  // sibling of B, must never appear in B's index:
  const c = appendChapters(linkChild(freshSession('C'), 'A', 'A'), [chapter(1)])
  const get = table({ A: a, B: b, C: c })
  const entries = buildIndex(ancestorPath(get, 'B'), get, () => 'ok')
  assert.deepEqual(entries.map((e) => `${e.authorSession}:${e.number}`), ['A:1', 'A:2', 'B:1'])
  assert.equal(entries.every((e) => e.authorSession !== 'C'), true)
})

test('buildIndex carries the integrity verdict through — tamper is visible in the index, not swallowed', () => {
  const a = appendChapters(freshSession('A'), [chapter(1, { sha256: 'deadbeef' }), chapter(2)])
  const get = table({ A: a })
  const entries = buildIndex(['A'], get, (rec) => (rec.sha256 === 'deadbeef' ? 'modified' : 'ok'))
  assert.deepEqual(entries.map((e) => e.status), ['modified', 'ok'])
})

test('appendChapters with zero records returns the identical state object (no fake write on a no-op)', () => {
  const s = freshSession('A')
  assert.equal(appendChapters(s, []), s)
})

// ------------------------------------------------------------------ finalization manifest

test('markFinalized records the compaction manifest; a second write is a no-op', () => {
  const s = markFinalized(freshSession('A'), 'cid-1', [1, 2])
  assert.deepEqual(s.finalized['cid-1'], [1, 2])
  assert.equal(isFinalized(s, 'cid-1'), true)
  assert.equal(isFinalized(s, 'cid-2'), false)
  assert.equal(markFinalized(s, 'cid-1', [9]), s) // identical object: never re-point a manifest
})
