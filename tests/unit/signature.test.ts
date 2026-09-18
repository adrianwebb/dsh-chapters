/**
 * signature.ts — per-turn deterministic signatures (record §4.1). The
 * contract the composer relies on: stable, loud-signal-first (paths >
 * commands > terms), and turn-span math that never crosses turn boundaries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractSignature, turnSpanOf } from '../../src/signature.ts'
import type { SessionEventLike } from '../../src/types.ts'

const user = (seq: number, text: string): SessionEventLike => ({
  type: 'user/message', seq, data: { id: `u${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const assistant = (seq: number, text: string): SessionEventLike => ({
  type: 'assistant/message', seq, data: { id: `a${seq}`, role: 'assistant', source: { kind: 'model' }, message: { content: [{ type: 'text', text }] } },
})
const call = (seq: number, name: string, args: string): SessionEventLike => ({ type: 'tool/call', seq, data: { callId: `c${seq}`, name, arguments: args } })
const turnEnd = (seq: number): SessionEventLike => ({ type: 'turn/end', seq, data: { turn: 1 } })

const twoTurns: SessionEventLike[] = [
  user(0, 'Please fix the auth middleware in src/auth/middleware.ts, the refresh flow is broken'),
  call(1, 'read', '{"file_path": "src/auth/middleware.ts", "limit": 80}'),
  assistant(2, 'Found it — the token refresh in src/auth/token.ts drops the expiry; patching src/auth/token.ts now'),
  turnEnd(3),
  user(4, 'Now run the test suite for the auth module'),
  call(5, 'bash', 'npm test -- --grep auth'),
  assistant(6, 'All 14 auth tests pass.'),
  turnEnd(7),
]

test('turnSpanOf: the just-ended turn only, never crossing the previous boundary', () => {
  assert.deepEqual(turnSpanOf(twoTurns, 3).map((e) => e.seq), [0, 1, 2, 3])
  assert.deepEqual(turnSpanOf(twoTurns, 7).map((e) => e.seq), [4, 5, 6, 7])
  assert.deepEqual(turnSpanOf(twoTurns, 99), [])
  // a single-turn log: the span is everything up to the end
  assert.deepEqual(turnSpanOf(twoTurns.slice(0, 4), 3).map((e) => e.seq), [0, 1, 2, 3])
})

test('extractSignature: paths and commands carry the task signal', () => {
  const sig = extractSignature(turnSpanOf(twoTurns, 3))
  assert.deepEqual(sig.seqs, [0, 1, 2, 3])
  assert.ok(sig.paths.includes('src/auth/middleware.ts'))
  assert.ok(sig.paths.includes('src/auth/token.ts'))
  assert.deepEqual(sig.commands, [], 'non-shell tool NAMES are not command signal (r28: they appear every turn and drown the topic)')
  assert.ok(sig.size > 0)
  assert.equal(sig.by, 'deterministic')
})

test('extractSignature: shell argv becomes a command prefix, not the whole line', () => {
  const sig = extractSignature(turnSpanOf(twoTurns, 7))
  assert.ok(sig.commands.includes('npm test auth')) // flags stripped; the positional IS signal
  assert.ok(sig.terms.length >= 1 && sig.terms.length <= 8)
})

test('deterministic: same events → identical signatures, byte for byte', () => {
  const a = JSON.stringify(extractSignature(turnSpanOf(twoTurns, 3)))
  const b = JSON.stringify(extractSignature(turnSpanOf(twoTurns, 3)))
  assert.equal(a, b)
})

test('empty turn (no text, no tools): valid signature with empty signals', () => {
  const empty: SessionEventLike[] = [turnEnd(0)]
  const sig = extractSignature(empty)
  assert.deepEqual(sig, { seqs: [0], paths: [], commands: [], terms: [], size: 0, by: 'deterministic' })
})

// ---------------------------------------------------------------- r28 noise fixes (measured in a live boot)

const injected = (seq: number, kind: string, text: string): SessionEventLike => ({
  type: 'user/message', seq, data: { id: `i${seq}`, role: 'user', source: { kind }, content: [{ type: 'text', text }] },
})

test('injected context (agent-instructions / plugin / skill-catalog) contributes NO paths or terms (r28)', () => {
  const span: SessionEventLike[] = [
    user(0, 'fix the sync pass in src/sync.ts'),
    injected(1, 'agent-instructions', 'see docs/contract.md and docs/architecture.md and AGENTS.md for rules'),
    injected(2, 'plugin', 'Current runtime context mentions src/engine.ts'),
    injected(3, 'skill-catalog', 'a skill covers hf-cli in src/skills/x.ts'),
    turnEnd(4),
  ]
  const sig = extractSignature(span)
  assert.ok(sig.paths.includes('src/sync.ts'))
  for (const noise of ['docs/contract.md', 'docs/architecture.md', 'AGENTS.md', 'src/engine.ts', 'src/skills/x.ts'])
    assert.ok(!sig.paths.includes(noise), `${noise} must not leak from injected ${'context'}`)
  assert.ok(!sig.terms.includes('agents') && !sig.terms.includes('skill'), 'injected prose is not term signal')
})

test('absolute and relative spellings of one file normalize to one path (r28)', () => {
  const span: SessionEventLike[] = [
    call(0, 'read', '{"file_path": "/home/adrian/Projects/dsh-chapters/src/sync.ts"}'),
    user(1, 'also check src/sync.ts here'),
    turnEnd(2),
  ]
  const sig = extractSignature(span)
  assert.ok(sig.paths.includes('src/sync.ts'), sig.paths.join(','))
  assert.equal(sig.paths.filter((p) => p.endsWith('src/sync.ts')).length, 1, 'one entry per real file')
})

test('prose slash-phrases are not paths; known-root directories are (r28)', () => {
  const span: SessionEventLike[] = [
    user(0, 'explain compaction/fork and topics/summaries/rule handling under the src/client dir'),
    turnEnd(1),
  ]
  const sig = extractSignature(span)
  assert.ok(!sig.paths.includes('compaction/fork'), 'prose phrase')
  assert.ok(!sig.paths.includes('topics/summaries/rule'), 'prose phrase')
  assert.ok(sig.paths.includes('src/client'), 'known root dir without extension still counts')
})
