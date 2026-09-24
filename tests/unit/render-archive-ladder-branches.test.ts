/**
 * Final margin sweep — the render arms a normal chapter rarely shows
 * (reasoning without text, nameless tool calls, long arguments, assistant
 * events whose only content was stripped injection), and the archive writer's
 * collision/dedup guards, and two ladder arms (no-workspace-yet, fetch that
 * throws). The coverage floor is the point, but each of these is also a
 * behavior a real session can hit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderChapter } from '../../src/render.ts'
import { writeArchive } from '../../src/archive.ts'
import type { ArchiveFs, NumberAllocator, RenderConfig, SessionEventLike } from '../../src/types.ts'

const CONFIG: RenderConfig = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 4000 }
const human = (seq: number, text: string): SessionEventLike =>
  ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })

test('render: reasoning-only turns, nameless tool calls, and truncated argument lines', () => {
  const events: SessionEventLike[] = [
    human(0, 'please inspect the runner'),
    // assistant carrying ONLY a reasoning block (no text) — renders the
    // reasoning marker; seq 5 then proves the textless arm degrades honestly
    { type: 'assistant/message', seq: 1, data: { content: [{ type: 'reasoning', text: 'weighed the ordering of migrations' }], source: { kind: 'user' } } },
    // tool/call with no name and an OBJECT (not string) argument bag, long enough to truncate
    { type: 'tool/call', seq: 2, data: { arguments: { payload: 'x'.repeat(500) } } },
    { type: 'assistant/message', seq: 3, data: { content: [{ type: 'text', text: 'done: verified with the suite' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 4, data: { content: [{ type: 'reasoning' }], source: { kind: 'user' } } },
  ]
  const r = renderChapter(events, { title: 'Runner inspection', summary: 'looked at the runner', startSeq: 0, endSeq: 4 }, CONFIG)
  assert.match(r.markdown, /unknown/, 'nameless tool call renders as unknown')
  assert.match(r.markdown, /…/, 'long args are visibly truncated')
  assert.match(r.markdown, /_reasoning:_/, 'the reasoning-only turn still renders its marker')
  assert.match(r.markdown, /weighed the ordering/, 'reasoning text is rendered under its marker')
  // the TEXTLESS reasoning turn (seq 4) renders nothing and is reported unrendered
  assert.ok(r.stats.unrenderedSeqs.includes(4), 'textless assistant block is disclosed, never silently dropped')
})

test('render: an assistant event that was ONLY stripped injection counts as nothing', () => {
  const events: SessionEventLike[] = [
    human(0, 'real question here'),
    { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: '<system-reminder>every byte of this is host context</system-reminder>' }], source: { kind: 'user' } } },
  ]
  const r = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 1 }, CONFIG)
  assert.match(r.markdown, /⟦omitted:host-injected/, 'marker present')
  assert.ok(!r.markdown.includes('**Assistant:**'), 'no assistant block emitted for pure-injection content')
})

// ------------------------------------------------------------------ archive

function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const fs: ArchiveFs = {
    async write(p, c) { files.set(p, c) },
    async read(p) { return files.get(p) },
    async exists(p) { return files.has(p) },
  }
  return { fs, files }
}
const allocator = (nums: number[]): NumberAllocator => ({ async reserve() { return nums } })

function rendered(title: string, body: string, artifacts: Array<{ path: string; sha256: string; bytes: number; content: string }> = []) {
  const events: SessionEventLike[] = [human(0, body)]
  const ch = renderChapter(events, { title, summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)
  return { ...ch, artifacts }
}

test('archive: identical artifact content is written once across a batch', async () => {
  const { fs, files } = memFs()
  const art = { path: 'artifacts/ab/ab12.txt', sha256: 'ab'.repeat(32), bytes: 5, content: 'hello' }
  const r = await writeArchive({
    fs, allocator: allocator([1, 2]), storeRoot: '.dsh-chapters', rootSessionId: 'rootA',
    chapters: [rendered('One', 'first chapter body', [art]), rendered('Two', 'second chapter body', [art])],
    attemptId: 'a1',
  })
  assert.equal(r.records.length, 2, 'both chapters archived')
  assert.equal([...files.keys()].filter((k) => k.endsWith('ab12.txt')).length, 1, 'the deduped artifact was written ONCE')
})

test('archive: an artifact already present from an earlier pass is not rewritten', async () => {
  const pre = '.dsh-chapters/rootA/artifacts/cd/cd34.txt'
  const { fs, files } = memFs({ [pre]: 'already here' })
  const art = { path: 'artifacts/cd/cd34.txt', sha256: 'cd'.repeat(32), bytes: 12, content: 'different now' }
  const r = await writeArchive({
    fs, allocator: allocator([1]), storeRoot: '.dsh-chapters', rootSessionId: 'rootA',
    chapters: [rendered('Cite', 'chapter citing a pre-existing artifact', [art])], attemptId: 'a2',
  })
  assert.equal(r.records.length, 1)
  assert.equal(files.get(pre), 'already here', 'the earlier bytes were untouched')
})

test('archive: empty chapter list throws before touching anything; short allocator refuses too', async () => {
  const { fs, files } = memFs()
  await assert.rejects(() => writeArchive({ fs, allocator: allocator([]), storeRoot: '.dsh-chapters', rootSessionId: 'r', chapters: [], attemptId: 'x' }), /no chapters/)
  await assert.rejects(() => writeArchive({
    fs, allocator: allocator([1]), storeRoot: '.dsh-chapters', rootSessionId: 'r',
    chapters: [rendered('A', 'a body'), rendered('B', 'b body')], attemptId: 'y',
  }), /numbers for 2 chapters/)
  assert.equal(files.size, 0, 'no partial writes from the refused call')
})

// ------------------------------------------------------------------ ladder

test('ladder: no workspace ever seen → the honest skip, not a crash', async () => {
  const { createEnrichWiring } = await import('../../src/enrich-wire.ts')
  const store = {
    get: async () => ({ chapters: [{ number: 1, path: '.dsh-chapters/s/chapters/001-x.md', title: 't', summary: 's', topics: [], startSeq: 0, endSeq: 1, sha256: 'x', estimatedTokens: 10 }] }),
    put: async () => undefined,
    sessions: () => [['s', { chapters: [{ number: 1, path: 'x', title: 't', summary: 's', topics: [], generated: undefined }] }]] as Iterable<[string, unknown]>,
    getSetting: () => undefined, putSetting: async () => undefined,
  }
  const w = createEnrichWiring({
    store: store as never, cwd: () => undefined,
    config: { enabled: true, model: 'p/m', trigger: 'manual', idleMs: 1000, batchCap: 5 },
    fetch: async () => { throw new Error('must not be called') },
    conversationRoute: () => null, log: () => undefined, warn: () => undefined,
  })
  const r = await w.runNow() // no cwd passed, none remembered
  assert.equal(r.processed, 0, 'nothing enriched without a workspace')
})

test('ladder: a fetch that throws is contained — warn, skip, keep going', async () => {
  const fsmod = await import('node:fs'); const osmod = await import('node:os'); const pathmod = await import('node:path')
  const ws = fsmod.mkdtempSync(pathmod.join(osmod.tmpdir(), 'lad-throw-'))
  const rel = '.dsh-chapters/sess-t/chapters/001-topic.md'
  fsmod.mkdirSync(pathmod.join(ws, '.dsh-chapters', 'sess-t', 'chapters'), { recursive: true })
  const body = '# Topic\n\n**User:** do the thing\n\n**Assistant:** finished: verified\n'
  const crypto = await import('node:crypto')
  const whole = `---\ntitle: "legacy fragment"\nsummary: deterministic summary text\ntopics: ["src/a.ts"]\nsha256: ${crypto.createHash('sha256').update(`${body}\n`, 'utf8').digest('hex')}\n---\n${body}`
  fsmod.writeFileSync(pathmod.join(ws, rel), whole)
  const state: any = { chapters: [{ number: 1, path: rel, title: 'legacy fragment', summary: 'det', topics: ['a'], startSeq: 0, endSeq: 5, estimatedTokens: 10 }] }
  const warns: string[] = []
  const w = (await import('../../src/enrich-wire.ts')).createEnrichWiring({
    store: {
      get: async () => state, put: async (_id: string, next: any) => { state.chapters = next.chapters },
      sessions: () => [['sess-t', state]] as Iterable<[string, unknown]>,
      getSetting: (k: string) => (k === 'enrichment.route' ? 'p/m' : undefined), putSetting: async () => undefined,
    } as never,
    cwd: () => ws,
    config: { enabled: true, model: '', trigger: 'manual', idleMs: 1000, batchCap: 5 },
    fetch: async () => { throw new Error('socket died mid-stream') },
    conversationRoute: () => ({ provider: 'p', model: 'm' }),
    log: () => undefined, warn: (m: string) => { warns.push(m) },
  })
  const r = await w.runNow()
  assert.equal(r.processed, 0)
  assert.ok(warns.some((m) => /enrichment failed/.test(m)), 'the failure was warned, not swallowed')
  fsmod.rmSync(ws, { recursive: true, force: true })
})
