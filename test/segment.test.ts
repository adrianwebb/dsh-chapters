/**
 * deriveRanges: turn-bounded cuts only, target respected, anchor-not-boundary
 * handled with a note (never a silent mid-turn cut), and zero model calls.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRanges } from '../src/continue-core.ts'
import type { SessionEventLike } from '../src/types.ts'

const msg = (seq: number, role: 'user' | 'assistant', text: string): SessionEventLike => ({
  type: `${role}/message`, seq, data: { id: `m${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const turnEnd = (seq: number): SessionEventLike => ({ type: 'turn/end', seq, data: { turn: seq } })

const conversation: SessionEventLike[] = [
  msg(0, 'user', 'setup the database schema'), msg(1, 'assistant', 'did it'), turnEnd(2),
  msg(3, 'user', `big topic one ${'filler words '.repeat(60)}`), msg(4, 'assistant', 'ok'), turnEnd(5),
  msg(6, 'user', 'big topic two ' + 'x'.repeat(500)), msg(7, 'assistant', 'done'), turnEnd(8),
]

test('anchors at the last turn/end; ranges tile [0..anchor] contiguously, boundary-only cuts', () => {
  const { chapters, notes } = deriveRanges(conversation, 8, 500)
  assert.equal(notes.length, 0)
  assert.equal(chapters[0]!.startSeq, 0)
  assert.equal(chapters[chapters.length - 1]!.endSeq, 8)
  for (let i = 1; i < chapters.length; i++) {
    assert.equal(chapters[i]!.startSeq, chapters[i - 1]!.endSeq + 1)
    assert.ok(chapters[i - 1]!.endSeq === 2 || chapters[i - 1]!.endSeq === 5 || chapters[i - 1]!.endSeq === 8, 'cut on a turn/end')
  }
})

test('small target splits into multiple segments; titles carry the segment index', () => {
  const { chapters } = deriveRanges(conversation, 8, 10) // tiny -> cut at nearly every boundary
  assert.ok(chapters.length >= 2)
  assert.match(chapters[1]!.title, /\(2\)$/)
})

test('mid-turn anchor: segmentation refuses to cut inside the turn and says so', () => {
  const { chapters, notes } = deriveRanges(conversation, 7, 500) // 7 is not a turn/end; boundaries <=7 are 2,5
  assert.equal(chapters[chapters.length - 1]!.endSeq, 5)
  assert.ok(notes.some((n) => /not a turn boundary/.test(n)))
})

test('no completed turn before the anchor refuses outright', () => {
  assert.throws(() => deriveRanges(conversation, 1, 500), /no completed turn/)
})
