/**
 * indexing.ts pure-helper branch sweep: the stitch planner (adjacent-numbered
 * legacy fragments cohere), the shard builder's manifest fast path, the
 * empty-canonical-topic skip, the mtime-absent sort/date arms, pins and
 * weights, and frontmatter parsing. These are pure functions; every arm is a
 * decision the incremental-index code can take, so every arm gets a witness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stitchFragments, buildIndexShards, parseFrontmatter, hashEntry, type IndexEntry, type CurationFact } from '../../src/indexing.ts'

const e = (over: Partial<IndexEntry>): IndexEntry => ({ path: 'chapters/K/s/x.md', title: 'T', topics: ['t'], kind: 'chapter', ...over })

// ------------------------------------------------------------------ stitch

test('stitchFragments coheres adjacent-numbered legacy fragments and leaves the rest alone', () => {
  const entries = [
    e({ path: 'chapters/K/s/003-earlier-history-part-2.md', title: 'Earlier history — 3 consecutive parts (stitched)' }),
    e({ path: 'chapters/K/s/001-earlier-history-part-0.md', title: 'Earlier history' }),
    e({ path: 'chapters/K/s/002-earlier-history-part-1.md', title: 'Earlier history' }),
    e({ path: 'chapters/K/s/010-real.md', title: 'A real chapter' }), // loose (not a fragment title)
    e({ path: 'chapters/K/s/no-number.md', title: 'Earlier history' }), // fragment title but no number → loose
  ]
  const out = stitchFragments(entries)
  const stitched = out.find((x) => /stitched/.test(x.title))
  assert.ok(stitched !== undefined, 'the run of three was stitched')
  assert.equal(stitched?.paths?.length, 3, 'all three members recorded')
  assert.equal(stitched?.path.split('/').pop(), '001-earlier-history-part-0.md', 'head is the lowest number')
  assert.ok(out.some((x) => x.path.endsWith('010-real.md')), 'real chapter passes through')
  assert.ok(out.some((x) => x.path.endsWith('no-number.md')), 'fragment-titled but unnumbered stays loose')
})

test('stitchFragments: a lone fragment (no adjacent run) is emitted unchanged', () => {
  const out = stitchFragments([e({ path: 'chapters/K/s/007-earlier-history-part-0.md', title: 'Earlier history' })])
  assert.equal(out[0].paths, undefined, 'single fragment is not stitched')
})

// ------------------------------------------------------------------ shards

test('buildIndexShards: manifest changed/unchanged, empty-topic skip, mtime sort both arms, pins+weights', () => {
  const entries: IndexEntry[] = [
    e({ path: 'chapters/K/s/001-a.md', title: 'A', topics: ['auth', '  '], mtime: 100 }), // blank topic → skip (212)
    e({ path: 'chapters/K/s/002-b.md', title: 'B', topics: ['auth'], mtime: undefined }), // no mtime → '----' (232) + ?? 0 sort (229)
    e({ path: 'chapters/K/s/003-c.md', title: 'C', topics: ['auth'], mtime: 300 }),
    e({ path: 'rules/K/h/004-r.md', title: 'R', topics: ['security'], kind: 'rule', category: 'sec', mtime: 50 }),
  ]
  const curation: CurationFact[] = [
    { type: 'topic-pin', topic: 'auth' },
    { type: 'topic-weight', topic: 'auth', weight: 3 },
    { type: 'topic-alias', from: 'sec', to: 'security' },
  ]
  const build = buildIndexShards(entries, curation, {})
  assert.equal(build.changed, true, 'full build from empty manifest')
  assert.ok(build.topics.includes('auth') && build.topics.includes('security'))
  const auth = build.shards.get('auth')!
  assert.match(auth, /# topic: auth\n\(pinned\)\n/, 'pin annotation present')
  assert.match(auth, /weight 3/, 'weight present')
  // mtime-descending: C (300) before A (100) before B (----), and B uses '----'
  const lines = auth.split('\n').slice(1).filter((l) => l.includes('|'))
  assert.ok(lines.findIndex((l) => l.includes('003-c')) < lines.findIndex((l) => l.includes('001-a')), 'newest first')
  assert.ok(lines.some((l) => l.startsWith('---- |')), 'no-mtime entry shows the ---- date')
  // manifest fast path: feeding the SAME entries + the SAME manifest = unchanged
  const build2 = buildIndexShards(entries, curation, build.manifest)
  assert.equal(build2.changed, false, 'idempotent rebuild reports nothing changed')
})

test('hashEntry is stable per content and differs across fields', () => {
  const a = hashEntry(e({ path: 'x', title: 'T', topics: ['p'] }))
  assert.equal(a, hashEntry(e({ path: 'x', title: 'T', topics: ['p'] })), 'same input → same hash')
  assert.notEqual(a, hashEntry(e({ path: 'x', title: 'T2', topics: ['p'] })), 'changed field → different hash')
})

// ------------------------------------------------------------------ frontmatter

test('parseFrontmatter reads lists, scalars, and tolerates absence', () => {
  const list = parseFrontmatter('---\ntitle: "T"\ntopics: ["a","b","c"]\n---\nbody')
  assert.deepEqual(list.topics, ['a', 'b', 'c'])
  assert.equal(list.title, 'T')
  const single = parseFrontmatter('---\ntitle: T\nnumber: 5\n---\nb')
  assert.equal(single.title, 'T')
  assert.equal(single.number, '5')
  const none = parseFrontmatter('no frontmatter')
  assert.deepEqual(none, {}, 'no fenced block → empty record')
})
