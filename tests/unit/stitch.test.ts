import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stitchFragments, type IndexEntry } from '../../src/indexing.ts'

const e = (path: string, title: string, topics: string[] = []): IndexEntry =>
  ({ path, title, topics, kind: 'chapter' })

test('adjacent fragments in one session tree cohere into one entry citing all members', () => {
  const out = stitchFragments([
    e('chapters/k1/sess-a/003-earlier-history.md', 'Earlier history (seqs 12-20)', ['auth']),
    e('chapters/k1/sess-a/004-earlier-history.md', 'Earlier history (seqs 21-30)', ['testing']),
    e('chapters/k1/sess-a/005-real-chapter.md', 'Enriched: real topic work', ['ci']),
  ])
  const stitched = out.find((x) => x.paths !== undefined)!
  assert.ok(stitched.title.includes('2 consecutive parts'), stitched.title)
  assert.deepEqual(stitched.paths, [
    'chapters/k1/sess-a/003-earlier-history.md',
    'chapters/k1/sess-a/004-earlier-history.md',
  ])
  assert.deepEqual([...stitched.topics].sort(), ['auth', 'testing'])
  assert.equal(out.find((x) => x.title.startsWith('Enriched'))?.paths, undefined, 'non-fragment untouched')
})

test('a non-fragment breaks the run; number gaps break it too; sessions never mix', () => {
  const out = stitchFragments([
    e('chapters/k/a/001-x.md', 'Earlier history p1'),
    e('chapters/k/a/002-y.md', 'Enriched title'),
    e('chapters/k/a/003-z.md', 'Earlier history p3'),
    e('chapters/k/b/004-w.md', 'Conversation span q1'),
    e('chapters/k/b/006-v.md', 'Conversation span q3'),
  ])
  assert.equal(out.every((x) => x.paths === undefined), true, JSON.stringify(out.map((x) => x.title)))
})

test('idempotent: stitching stitched output is stable (members fold to canonical path)', () => {
  const once = stitchFragments([
    e('chapters/k/a/001-x.md', 'Earlier history p1'),
    e('chapters/k/a/002-y.md', 'Earlier history p2'),
  ])
  const twice = stitchFragments(once)
  assert.deepEqual(twice, once)
})
