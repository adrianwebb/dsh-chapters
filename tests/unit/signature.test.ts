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
  assert.deepEqual(sig.commands, ['read'])
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
