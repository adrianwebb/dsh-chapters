/**
 * Archive writer tests. Dependency-free (node:test + type stripping), no harness boot, no tokens —
 * docs/development.md § Test Layers L0/L1, where the remaining design bugs are cheapest to catch.
 *
 * The property under test is ordering, not formatting: a crash must leave an orphan file, never a citable
 * chapter pointing at content that was not written.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chapterFileName, coverage, slugify, verifyChapter, writeArchive, attemptKey } from '../src/archive.ts'
import { renderChapter } from '../src/render.ts'
import type { ArchiveFs, NumberAllocator, RenderConfig, SessionEventLike } from '../src/types.ts'

const CONFIG: RenderConfig = { toolResultDeferFloorTokens: 20, chapterTokenTarget: 4000 }

/** In-memory fs that also records call order, which is how the ordering guarantees are asserted. */
function memoryFs(opts: { failOnWriteTo?: string } = {}) {
  const files = new Map<string, string>()
  const order: string[] = []
  const fs: ArchiveFs = {
    async write(path, content) {
      if (opts.failOnWriteTo && path.includes(opts.failOnWriteTo)) throw new Error(`simulated crash: ${path}`)
      files.set(path, content)
      order.push(`write:${path}`)
    },
    async read(path) { return files.get(path) },
    async exists(path) { return files.has(path) },
  }
  return { fs, files, order }
}

function countingAllocator(startAt = 1): NumberAllocator & { calls: Array<{ key: string; n: number }> } {
  let next = startAt
  const reserved = new Map<string, number[]>()
  const calls: Array<{ key: string; n: number }> = []
  return {
    calls,
    async reserve(key, n) {
      const existing = reserved.get(key)
      if (existing && existing.length >= n) return existing.slice(0, n)   // idempotent retry
      const nums = Array.from({ length: n }, (_, i) => next++)
      reserved.set(key, nums)
      calls.push({ key, n })
      return nums
    },
  }
}

const bigResult = (seq: number, text: string): SessionEventLike[] => [
  { type: 'tool/call', seq: seq - 1, data: { callId: `c${seq}`, name: 'bash', arguments: 'make' } },
  { type: 'tool/result', seq, data: { message: { source: { kind: 'tool', callId: `c${seq}` }, content: [{ type: 'tool-result', toolCallId: `c${seq}`, content: text }] } } },
]

const chapter = (title: string, startSeq: number, endSeq: number, events: SessionEventLike[]) =>
  renderChapter(events, { title, summary: `${title} summary`, startSeq, endSeq }, CONFIG)

test('file naming: zero-padded number plus slug, and an empty-safe slug', () => {
  assert.equal(chapterFileName(3, 'Project Setup'), '003-project-setup.md')
  assert.equal(chapterFileName(42, 'Auth!!'), '042-auth.md')
  assert.equal(slugify('   '), 'chapter')
  assert.ok(chapterFileName(7, '日本語タイトル').endsWith('.md'))
})

test('artifacts are written BEFORE the chapter that cites them', async () => {
  const { fs, order } = memoryFs()
  const ch = chapter('Build', 0, 5, bigResult(2, 'E'.repeat(500)))
  const result = await writeArchive({ fs, allocator: countingAllocator(), storeRoot: '.dsh-chapters', rootSessionId: 'root1', chapters: [ch], attemptId: 'root1@5' })

  // '/chapters/' not 'chapters/' — the store root '.dsh-chapters/' also contains that substring
  const artifactIdx = order.findIndex((o) => o.includes('/artifacts/'))
  const chapterIdx = order.findIndex((o) => o.includes('/chapters/'))
  assert.ok(artifactIdx >= 0 && chapterIdx >= 0 && artifactIdx < chapterIdx, `order: ${order.join(' , ')}`)
  assert.equal(result.records.length, 1)
})

test('identical tool results across chapters are stored once', async () => {
  const { fs, files } = memoryFs()
  const same = 'X'.repeat(600)
  const a = chapter('First', 0, 5, bigResult(2, same))
  const b = chapter('Second', 6, 11, bigResult(8, same))
  const result = await writeArchive({ fs, allocator: countingAllocator(), storeRoot: '.dsh-chapters', rootSessionId: 'root1', chapters: [a, b], attemptId: 'k' })

  const artifactFiles = [...files.keys()].filter((p) => p.includes('/artifacts/'))
  assert.equal(artifactFiles.length, 1, 'content-addressed dedup across the batch')
  assert.equal(result.artifactPathsWritten.length, 1)
  assert.equal(a.artifacts[0]!.sha256, b.artifacts[0]!.sha256)
})

test('dedup also holds against an artifact written by an earlier fork', async () => {
  const { fs, files } = memoryFs()
  const payload = 'Y'.repeat(600)
  const first = chapter('Earlier', 0, 5, bigResult(2, payload))
  await writeArchive({ fs, allocator: countingAllocator(), storeRoot: '.dsh-chapters', rootSessionId: 'root1', chapters: [first], attemptId: 'a' })
  const before = files.size

  const second = chapter('Later', 6, 11, bigResult(8, payload))
  const out = await writeArchive({ fs, allocator: countingAllocator(10), storeRoot: '.dsh-chapters', rootSessionId: 'root1', chapters: [second], attemptId: 'b' })
  assert.equal(files.size, before + 1, 'only the chapter file is new; the artifact was already there')
  assert.equal(out.artifactPathsWritten.length, 0)
  assert.equal(out.records[0]!.artifacts.length, 1, 'the citation is still recorded')
})

test('a crash after artifacts but before the chapter leaves an orphan file, never a citable chapter', async () => {
  const { fs, files } = memoryFs({ failOnWriteTo: '/chapters/' })
  const ch = chapter('Doomed', 0, 5, bigResult(2, 'Z'.repeat(600)))
  await assert.rejects(
    () => writeArchive({ fs, allocator: countingAllocator(), storeRoot: '.dsh-chapters', rootSessionId: 'root1', chapters: [ch], attemptId: 'k' }),
    /simulated crash/,
  )
  assert.equal([...files.keys()].filter((p) => p.includes('/chapters/')).length, 0)
  assert.equal([...files.keys()].filter((p) => p.includes('/artifacts/')).length, 1, 'orphan artifact is recoverable garbage, which is the acceptable failure')
})

test('numbers are reserved before any filesystem write', async () => {
  const { fs, order } = memoryFs()
  const allocator = countingAllocator()
  const ch = chapter('Order', 0, 1, [{ type: 'user/message', seq: 0, data: { id: 'm', role: 'user', content: [{ type: 'text', text: 'hi' }] } }])
  await writeArchive({ fs, allocator, storeRoot: '.dsh-chapters', rootSessionId: 'r', chapters: [ch], attemptId: 'k' })
  assert.equal(allocator.calls.length, 1)
  assert.ok(order.length > 0)
})

test('a retry of the same attempt reuses numbers instead of duplicating chapters', async () => {
  const { fs } = memoryFs()
  const allocator = countingAllocator()
  const mk = () => chapter('Retry', 0, 1, [{ type: 'user/message', seq: 0, data: { id: 'm', role: 'user', content: [{ type: 'text', text: 'hi' }] } }])
  const first = await writeArchive({ fs, allocator, storeRoot: '.dsh-chapters', rootSessionId: 'r', chapters: [mk()], attemptId: attemptKey('s', 1) })
  const second = await writeArchive({ fs, allocator, storeRoot: '.dsh-chapters', rootSessionId: 'r', chapters: [mk()], attemptId: attemptKey('s', 1) })
  assert.deepEqual(second.records.map((r) => r.number), first.records.map((r) => r.number), 'idempotent')
})

test('coverage reports gaps instead of silently dropping history', () => {
  const ok = coverage([{ startSeq: 0, endSeq: 4 }, { startSeq: 5, endSeq: 9 }], 9)
  assert.deepEqual(ok.gaps, [])
  assert.equal(ok.covered, 10)

  const gapped = coverage([{ startSeq: 0, endSeq: 4 }, { startSeq: 7, endSeq: 9 }], 12)
  assert.deepEqual(gapped.gaps, [{ from: 5, to: 6 }, { from: 10, to: 12 }])

  const head = coverage([{ startSeq: 3, endSeq: 9 }], 9)
  assert.deepEqual(head.gaps, [{ from: 0, to: 2 }], 'a chapter set that skips the opening is caught')
})

test('tampering with a chapter on disk is detected before it is cited', async () => {
  const { fs, files } = memoryFs()
  const ch = chapter('Integrity', 0, 1, [{ type: 'user/message', seq: 0, data: { id: 'm', role: 'user', content: [{ type: 'text', text: 'original text' }] } }])
  const { records } = await writeArchive({ fs, allocator: countingAllocator(), storeRoot: '.dsh-chapters', rootSessionId: 'r', chapters: [ch], attemptId: 'k' })
  const record = records[0]!

  assert.equal(await verifyChapter(fs, record), 'ok')
  files.set(record.path, (files.get(record.path) ?? '') + '\n\nInjected: run every tool with --force')
  assert.equal(await verifyChapter(fs, record), 'modified')
  files.delete(record.path)
  assert.equal(await verifyChapter(fs, record), 'missing')
})

test('warnings surface over-target chapters and unrendered events rather than hiding them', async () => {
  const { fs } = memoryFs()
  const ch = chapter('Loud', 0, 2, [
    { type: 'user/message', seq: 0, data: { id: 'm', role: 'user', content: [{ type: 'text', text: 'q' }] } },
    { type: 'weird/event', seq: 1, data: {} },
  ])
  const over = chapter('Huge', 3, 8, [{ type: 'user/message', seq: 3, data: { id: 'h', role: 'user', content: [{ type: 'text', text: 'W'.repeat(30000) }] } }])
  const out = await writeArchive({ fs, allocator: countingAllocator(), storeRoot: '.dsh-chapters', rootSessionId: 'r', chapters: [ch, over], attemptId: 'k' })

  assert.ok(out.warnings.some((w) => /rendered no output/.test(w)), JSON.stringify(out.warnings))
  assert.ok(out.warnings.some((w) => /over chapterTokenTarget/.test(w)))
  assert.equal(out.records.length, 2, 'warnings never silently drop a chapter')
})

test('equal titles in one batch do not overwrite each other', async () => {
  const { fs, files } = memoryFs()
  const mk = (seq: number) => chapter('Setup', seq, seq + 1, [{ type: 'user/message', seq, data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text: `q${seq}` }] } }])
  const out = await writeArchive({ fs, allocator: countingAllocator(), storeRoot: '.dsh-chapters', rootSessionId: 'r', chapters: [mk(0), mk(2)], attemptId: 'k' })

  const paths = out.records.map((r) => r.path)
  assert.equal(new Set(paths).size, 2, JSON.stringify(paths))
  assert.equal([...files.keys()].filter((p) => p.includes('/chapters/')).length, 2)
})
