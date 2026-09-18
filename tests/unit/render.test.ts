/**
 * Tests for the pure chapter renderer. Run with the dependency-free loop in docs/development.md:
 *   node --test test/
 * No harness boot, no tokens, no DSH_HOME — this is layer L0/L1 and where the remaining design bugs live.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artifactPath, estimateTokens, fenced, longerFence, renderChapter, renderIndex, sha256, toolResultCandidates, validateRanges } from '../../src/render.ts'
import type { RenderConfig, SessionEventLike } from '../../src/types.ts'

const CONFIG: RenderConfig = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 4000 }

const msg = (seq: number, role: 'user' | 'assistant', text: string): SessionEventLike => ({
  type: `${role}/message`, seq, time: 0, surfaceOp: 'append',
  data: { id: `m${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const call = (seq: number, name: string, args: string, callId = `c${seq}`): SessionEventLike => ({
  type: 'tool/call', seq, data: { callId, name, arguments: args },
})
const result = (seq: number, text: string, callId = `c${seq - 1}`): SessionEventLike => ({
  type: 'tool/result', seq,
  data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } },
})

// ------------------------------------------------------------------ fence safety

test('a fence longer than any embedded run is chosen', () => {
  assert.equal(longerFence('plain'), '```')
  assert.equal(longerFence('has ``` inside'), '````')
  assert.equal(longerFence('has `````` six'), '```````')  // 6-run needs 7, one longer is sufficient
})

test('CHAPTER: conversation text containing a triple-backtick fence does not truncate the chapter', () => {
  // The invisible data-loss bug an XML format would have prevented; solved in the renderer instead.
  const hostile = 'Here is the fix:\n```ts\nconst x = 1\n```\nAnd the closing thought that MUST survive.'
  const chapter = renderChapter([msg(0, 'user', hostile)], { title: 'T', summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)

  assert.match(chapter.markdown, /And the closing thought that MUST survive\./)
  // opening fence of the wrapped block must outlast every run inside it
  const wrapper = longerFence(hostile)
  assert.ok(chapter.markdown.includes(`${wrapper}ts\n`) || chapter.markdown.includes(`${wrapper}\n`))
  assert.equal(chapter.stats.unrenderedSeqs.length, 0)
})

test('fenced() round-trips arbitrary backtick content', () => {
  for (const body of ['a```b', 'a````b', '```\n```', 'no fences']) {
    const wrapped = fenced(body)
    const outer = wrapped.split('\n')[0]!
    const innerRuns = body.match(/`+/g) ?? []
    for (const run of innerRuns) assert.ok(run.length < outer.length, `inner ${run.length} vs outer ${outer.length}`)
  }
})

// ------------------------------------------------------------------ ranges

test('validateRanges refuses overlaps, gaps-as-descents, and past-ceiling ranges', () => {
  const c = (title: string, startSeq: number, endSeq: number) => ({ title, summary: 's', startSeq, endSeq })
  assert.throws(() => validateRanges([c('a', 0, 10), c('b', 5, 20)], 30), /overlaps/)
  assert.throws(() => validateRanges([c('a', 10, 5)], 30), /startSeq 10 above endSeq 5/)
  assert.throws(() => validateRanges([c('a', 0, 40)], 30), /past the archive ceiling 30/)
  assert.throws(() => validateRanges([c('b', 9, 10), c('a', 0, 5)], 30), /descends/)
  assert.doesNotThrow(() => validateRanges([c('a', 0, 5), c('b', 6, 10)], 10))
})

test('a gap between chapters is visible via coverage arithmetic, not silently archived wrong', () => {
  const chapters = validateRanges([
    { title: 'a', summary: 's', startSeq: 0, endSeq: 4 },
    { title: 'b', summary: 's', startSeq: 7, endSeq: 9 },
  ], 9)
  // seqs 5-6 are dropped; callers diff coverage against the ceiling and must report it.
  assert.equal(chapters[1]!.startSeq - chapters[0]!.endSeq, 3)
})

// ------------------------------------------------------------------ tool results

test('small tool results stay inline and large ones are deferred with a readable path', () => {
  const small = result(2, 'exit code 0')
  const big = result(4, 'X'.repeat(4000))
  const events: SessionEventLike[] = [call(1, 'bash', 'npm test'), small, call(3, 'read', 'file.ts'), big]

  const chapter = renderChapter(events, { title: 'Work', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)
  assert.equal(chapter.stats.toolResultsInlined, 1)
  assert.equal(chapter.stats.toolResultsDeferred, 1)
  assert.match(chapter.markdown, /→ `artifacts\/[0-9a-f]{2}\/[0-9a-f]{64}\.txt`/)
  assert.equal(chapter.artifacts.length, 2, 'artifacts are written EITHER WAY, so deferral never loses data')
})

test('the model can force a large result to stay inline, and the artifact is still written', () => {
  const events: SessionEventLike[] = [call(1, 'bash', 'make'), result(2, 'E'.repeat(4000))]
  const chapter = renderChapter(events, { title: 'Build', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG, [{ seq: 2, inline: true }])

  assert.equal(chapter.stats.toolResultsInlined, 1)
  assert.equal(chapter.artifacts.length, 1)
  assert.equal(chapter.artifacts[0]!.inlined, true)
  assert.match(chapter.markdown, /also at `artifacts\//)
})

test('identical tool results dedupe to one content-addressed path', () => {
  const same = 'X'.repeat(4000)
  const events: SessionEventLike[] = [call(1, 'read', 'a'), result(2, same), call(3, 'read', 'b'), result(4, same)]
  const chapter = renderChapter(events, { title: 'Reads', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)
  assert.equal(chapter.artifacts[0]!.path, chapter.artifacts[1]!.path)
  assert.equal(new Set(chapter.artifacts.map((a) => a.sha256)).size, 1)
})

test('artifactPath shards by hash prefix', () => {
  const h = sha256('abc')
  assert.equal(artifactPath(h), `artifacts/${h.slice(0, 2)}/${h}.txt`)
})

test('candidates report real sizes so the model never guesses at byte counts', () => {
  const events: SessionEventLike[] = [call(1, 'bash', 'ls'), result(2, 'short'), call(3, 'bash', 'find'), result(4, 'Y'.repeat(2000))]
  const candidates = toolResultCandidates(events, { title: 'x', summary: 'y', startSeq: 0, endSeq: 9 })
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0]!.toolName, 'bash')
  assert.ok(candidates[1]!.bytes > 1900 && candidates[1]!.estimatedTokens > 400)
})

// ------------------------------------------------------------------ completeness

test('nothing in range vanishes silently', () => {
  const events: SessionEventLike[] = [
    msg(0, 'user', 'question'),
    { type: 'mystery/event', seq: 1, data: { whatever: true } },   // unknown type
    msg(2, 'assistant', 'answer'),
  ]
  const chapter = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 2 }, CONFIG)
  assert.deepEqual(chapter.stats.unrenderedSeqs, [1])
  assert.match(chapter.markdown, /unrenderedSeqs: \[1]/)
})

test('lifecycle events are omitted from the body but the range records them', () => {
  const events: SessionEventLike[] = [
    { type: 'turn/start', seq: 0, data: {} }, msg(1, 'user', 'hi'),
    { type: 'step/end', seq: 2, data: {} }, { type: 'turn/end', seq: 3, data: {} },
  ]
  const chapter = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 3 }, CONFIG)
  assert.equal(chapter.stats.unrenderedSeqs.length, 0, 'lifecycle is deliberately skipped, not an accident')
  assert.doesNotThrow(() => validateRanges(chapter.range ? [chapter.range] : [], 3))
})

test('oversized chapters report overTarget so the next boundary splits them; text is never clipped', () => {
  const events = [msg(0, 'user', 'Z'.repeat(20000))]
  const chapter = renderChapter(events, { title: 'Big', summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)
  assert.equal(chapter.stats.overTarget, true)
  assert.ok(chapter.markdown.includes('Z'.repeat(500)), 'full content present despite being over target')
})

// ------------------------------------------------------------------ index

test('the index is deterministic and costs no inference', () => {
  const entries = [
    { path: 'c/001-a.md', title: 'Project Setup', summary: 'Scaffolding.' },
    { path: 'c/002-b.md', title: 'Auth Debugging', summary: 'CORS fixed.' },
  ]
  const first = renderIndex(entries)
  assert.equal(first, renderIndex(entries), 'same input, byte-identical index')
  assert.match(first, /^1\. \[Project Setup]\(c\/001-a\.md\) — Scaffolding\./m)
  assert.ok(estimateTokens(first) < 60, 'a two-entry index stays tiny — the whole point on a 32K model')
})

test('empty input is a loud error, not an empty chapter that looks like success', () => {
  assert.throws(() => validateRanges([], 10), /no chapters supplied/)
})

// ------------------------------------------------- redaction at the chokepoint

test('CHAPTER: credentials never survive into the chapter body OR the deferred artifact (record §9)', () => {
  const aws = 'AKIAIOSFODNN7EXAMPLE'
  const bigResult = 'log line with aws key AKIAIOSFODNN7EXAMPLE embedded ' + 'filler tail text '.repeat(60)
  const events: SessionEventLike[] = [
    msg(0, 'user', `deploy with key ${aws} please`),
    msg(1, 'assistant', `done — note the key was ${aws}`),
    call(2, 'bash', 'aws s3 sync . s3://bucket'),
    result(3, bigResult),
  ]
  const chapter = renderChapter(events, { title: 'Deploy', summary: 's', startSeq: 0, endSeq: 3 }, CONFIG)
  assert.equal(chapter.markdown.includes(aws), false, 'secret absent from chapter markdown')
  assert.match(chapter.markdown, /⟦redacted:credential sha256=[0-9a-f]{8}⟧/)
  // the deferred artifact file body is redacted too (same chokepoint)
  const artifact = chapter.artifacts.find((a) => a.toolName === 'bash')
  assert.ok(artifact, 'a deferred artifact exists for the big result')
  assert.equal(artifact!.content.includes(aws), false, 'secret absent from artifact file content')
  assert.match(artifact!.content, /⟦redacted:credential sha256=[0-9a-f]{8}⟧/)
  // the stable marker appears in BOTH with the same hash (same secret → same marker)
  const markerInBody = /⟦redacted:credential sha256=([0-9a-f]{8})⟧/.exec(chapter.markdown)![1]
  const markerInArtifact = /⟦redacted:credential sha256=([0-9a-f]{8})⟧/.exec(artifact!.content)![1]
  assert.equal(markerInBody, markerInArtifact)
})

test('stats.messages counts user+assistant message events only (record §7.3)', () => {
  const evs = [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'q' }] } },
    { type: 'tool/call', seq: 1, data: { name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: 'a' }] } },
    { type: 'turn/end', seq: 3, data: {} },
  ] as never
  const r = renderChapter(evs, { title: 'T', summary: 's', startSeq: 0, endSeq: 3 }, { chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200 })
  assert.equal(r.stats.messages, 2)
  assert.equal(r.stats.events, 4)
})
