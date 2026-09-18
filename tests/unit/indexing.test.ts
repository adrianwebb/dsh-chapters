/**
 * indexing.ts — the pure Layer-2 index (record §10.2): deterministic shards,
 * alias canonicalization, the incremental manifest, and the rebuild == full
 * recovery identity.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIndexShards, entryFromChapter, parseFrontmatter, parseCuration, type IndexEntry } from '../../src/indexing.ts'

const entry = (path: string, topics: string[], title = path, mtime = 1_700_000_000_000): IndexEntry =>
  ({ path, title, topics, kind: 'chapter', mtime })

test('parseFrontmatter reads the render.ts layout (list + scalar + absent)', () => {
  const text = '---\ntitle: "A Title"\nseqRange: [3, 7]\ntopics: ["auth", "src/auth/x.ts"]\n---\nbody\n'
  const fm = parseFrontmatter(text)
  assert.equal(fm.title, 'A Title')
  assert.deepEqual(fm.topics, ['auth', 'src/auth/x.ts'])
  assert.equal(parseFrontmatter('no frontmatter').title, undefined)
})

test('entryFromChapter: topics from frontmatter, kind defaulting to chapter', () => {
  const e = entryFromChapter('chapters/K/s/001-a.md', '---\ntitle: "Auth"\ntopics: ["auth"]\n---\nbody\n')
  assert.equal(e.path, 'chapters/K/s/001-a.md')
  assert.equal(e.title, 'Auth')
  assert.deepEqual(e.topics, ['auth'])
  assert.equal(e.kind, 'chapter')
  assert.equal(e.mtime, undefined)
})

test('shards are deterministic: same inputs → byte-identical shards', () => {
  const entries = [entry('chapters/K/s/a.md', ['auth', 'tokens']), entry('chapters/K/s/b.md', ['auth'], 'x', 1_700_000_000_001)]
  const a = buildIndexShards(entries, [])
  const b = buildIndexShards(entries, [])
  assert.deepEqual([...a.shards], [...b.shards])
  assert.equal(a.manifest['chapters/K/s/a.md']!.hash, b.manifest['chapters/K/s/a.md']!.hash)
})

test('aliases canonicalize topics transitively; pins and weights appear in the shard', () => {
  const entries = [entry('chapters/K/s/a.md', ['auth']), entry('chapters/K/s/b.md', ['authentication'])]
  const curation = parseCuration(
    ['{"type":"topic-alias","from":"auth","to":"authentication","at":"t"}',
     '{"type":"topic-alias","from":"authentication","to":"authn","at":"t"}',
     '{"type":"topic-pin","topic":"authn","at":"t"}'].join('\n'))
  const { shards, topics } = buildIndexShards(entries, curation)
  assert.deepEqual(topics, ['authn'])
  const shard = shards.get('authn')!
  assert.match(shard, /pinned/)
  assert.match(shard, /entries: 2/)
})

test('the manifest gates the commit: unchanged input → changed=false, new entry → changed=true', () => {
  const entries = [entry('chapters/K/s/a.md', ['auth'])]
  const first = buildIndexShards(entries, [])
  assert.equal(first.changed, true)
  const second = buildIndexShards(entries, [], first.manifest)
  assert.equal(second.changed, false)
  const third = buildIndexShards([...entries, entry('chapters/K/s/b.md', ['other'])], [], second.manifest)
  assert.equal(third.changed, true)
})

test('rebuild from an empty manifest equals the incremental build (recovery identity)', () => {
  const entries = [entry('chapters/K/s/a.md', ['auth']), entry('chapters/K/s/b.md', ['billing'])]
  const incremental = buildIndexShards(entries, [], buildIndexShards(entries, []).manifest)
  const recovery = buildIndexShards(entries, [])
  assert.deepEqual([...incremental.shards], [...recovery.shards])
})

test('entries dropped from the input drop out of shards AND the manifest', () => {
  const two = [entry('chapters/K/s/a.md', ['auth']), entry('chapters/K/s/b.md', ['billing'])]
  const first = buildIndexShards(two, [])
  const second = buildIndexShards([two[0]!], [], first.manifest)
  assert.equal(second.shards.has('billing'), false)
  assert.equal(second.manifest['chapters/K/s/b.md'], undefined)
})
