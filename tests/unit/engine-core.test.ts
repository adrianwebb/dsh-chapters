/**
 * L0/L1 tests for engine-core: the TOC accumulation loop and the durable-log
 * citation rule — the two places where an engine-path bug would silently make
 * a chapter unreachable or archive the wrong text. Pure fakes, no harness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import {
  CHAPTERS_PROVIDER, DETERMINISTIC_MODEL, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG,
  buildFinalizedChapter, chapterPathFor, deriveIdentity, engineRecord, extractCheckpointBlocks,
  findOpenCompactionId, parseTocState, planSummarize, resolveOriginalEvent,
  type EngineMessage, type EngineSession, type EngineSessionEvent,
} from '../../src/engine-core.ts'
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
    eventAt: (seq) => bySeq.get(seq),
  }
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
    ],
  }
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
    chapter: { title: 'do the migration', summary: '1 user / 0 assistant messages', path: 'x.md' },
  }
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
    stats: { estimatedTokens: 5, estimatedBytes: 3, events: 2, toolCalls: 0, toolResultsInlined: 0, toolResultsDeferred: 0, overTarget: false, unrenderedSeqs: [] },
  }
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
