/**
 * L0/L1 tests for the store adapters. The domain here is a Map — the point is
 * the ADAPTER behavior (fresh-state defaulting, allocator read-modify-write,
 * gitignore add-once, ENOENT-vs-error) with zero harness. The real backend's
 * durability is the boot witness (docs/development.md § L2), not this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chapterDomainSpec, ensureStoreGitignore, makeAllocator, makeArchiveFs, makeDomainStore, commitChapters, type DomainLike } from '../../src/store.ts'
import { freshSession, linkChild } from '../../src/registry.ts'
import type { ChapterRecord } from '../../src/archive.ts'

const record = (number: number): ChapterRecord => ({
  number, path: `.dsh-chapters/A/chapters/${number}-x.md`, title: `T${number}`, summary: 's',
  startSeq: 0, endSeq: 1, sha256: 'f'.repeat(64), estimatedTokens: 10, artifacts: [],
})

/** In-memory stand-in for the opened domain table (shape-compatible). */
const fakeDomain = (): { domain: DomainLike; map: Map<string, any> } => {
  const map = new Map<string, any>()
  const domain: DomainLike = {
    table() {
      return {
        get: (k) => map.get(k),
        put: async (k, v) => { map.set(k, structuredClone(v)) },
        entries: () => map.entries(),
        get size() { return map.size },
      }
    },
    close: async () => {},
  }
  return { domain, map }
}

test('domain spec declares the dsh_chapters name and sessions table', () => {
  assert.equal(chapterDomainSpec.name, 'dsh_chapters')
  assert.ok('sessions' in (chapterDomainSpec as any).tables)
})

test('store.get on an unknown session yields fresh state, not undefined', async () => {
  const { domain } = fakeDomain()
  const store = makeDomainStore(domain)
  const s = await store.get('new-one')
  assert.deepEqual(s, freshSession('new-one'))
})

test('makeAllocator reserves through the port and is idempotent per attempt', async () => {
  const { domain, map } = fakeDomain()
  const store = makeDomainStore(domain)
  const allocator = makeAllocator(store, 'A')
  assert.deepEqual(await allocator.reserve('A@100', 2), [1, 2])
  assert.deepEqual(await allocator.reserve('A@100', 2), [1, 2])   // retry: SAME numbers
  assert.deepEqual(await allocator.reserve('A@200', 1), [3])      // new attempt advances
  assert.equal(map.get('A').nextChapterNumber, 4)
})

test('commitChapters accumulates and skips a no-op write when nothing changed', async () => {
  const { domain, map } = fakeDomain()
  const store = makeDomainStore(domain)
  await commitChapters(store, 'A', [record(1)])
  const before = map.get('A')
  await commitChapters(store, 'A', [record(1)]) // duplicate number: state identical
  assert.equal(map.get('A'), before)            // untouched Map entry: no fake write
  await commitChapters(store, 'A', [record(2)])
  assert.deepEqual(map.get('A').chapters.map((c: ChapterRecord) => c.number), [1, 2])
})

test('ancestry links survive a store round-trip', async () => {
  const { domain, map } = fakeDomain()
  const store = makeDomainStore(domain)
  const b = linkChild(freshSession('B'), 'A', 'A')
  await store.put('B', b)
  assert.deepEqual(map.get('B').parentSession, 'A')
})

// ---------------------------------------------------------------- fs port

test('makeArchiveFs: nested mkdir on write, ENOENT reads undefined, other errors throw', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-ch-test-'))
  try {
    const fs = makeArchiveFs(base)
    assert.equal(await fs.read('nope/deep.txt'), undefined)
    await fs.write('a/b/c.md', 'body')
    assert.equal(await fs.read('a/b/c.md'), 'body')
    assert.equal(await fs.exists('a/b/c.md'), true)
    assert.equal(await fs.exists('a/b/missing.md'), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('ensureStoreGitignore adds once, no-ops when present, creates when absent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-ch-test-'))
  try {
    const fs = makeArchiveFs(base)
    const first = await ensureStoreGitignore(fs, '.dsh-chapters')
    assert.match(first, /added \.dsh-chapters\/ to \.gitignore/)
    const text = await fs.read('.gitignore')
    assert.ok(text !== undefined && text.includes('.dsh-chapters/'))
    const second = await ensureStoreGitignore(fs, '.dsh-chapters')
    assert.match(second, /already in \.gitignore/)
    const after = await fs.read('.gitignore')
    assert.equal(after, text) // byte-stable on the second call
    // trailing-slash equivalence on the configured root
    assert.match(await ensureStoreGitignore(fs, '.dsh-chapters/'), /already in/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
