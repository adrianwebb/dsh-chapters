/**
 * Arrival-time artifacting against a session shim that EMULATES the kernel's
 * surfaceOp replace (real sessions apply it; the r28 lesson demands the fake
 * mirror the real shape or the test proves nothing).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyArrivalStubs, ARRIVAL_MARKER } from '../../src/arrival.ts'
import { artifactPath, sha256 } from '../../src/render.ts'

interface Ev { type: string; data: any }
function fakeSession(events: Map<number, Ev>) {
  const appended: { type: string; data: any; opts?: any }[] = []
  return {
    session: {
      get surface() { return { nodes: [...events.keys()] } },
      eventAt: (seq: number) => events.get(seq),
      append(type: string, data: any, opts?: any) {
        appended.push({ type, data, opts })
        const op = opts?.surfaceOp
        if (op?.op === 'replace' && op.startSeq === op.endSeq) {
          events.set(op.startSeq, { type, data }) // kernel semantics: node content swapped in place
        }
        return { seq: 9000 + appended.length }
      },
    },
    appended,
  }
}

const est = (m: unknown): number => Math.ceil(JSON.stringify(m).length / 4)

test('over-floor tool/result lands as artifact + stub pair; below-floor untouched; second pass no-ops', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'))
  const big = 'research document '.repeat(4000) // ~28K chars => ~7K tok by est; floor 3000
  const small = 'ok'
  const events = new Map<number, Ev>([
    [1, { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'go' }] } } }],
    [2, { type: 'tool/result', data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: big }] } } }],
    [3, { type: 'tool/result', data: { message: { source: { callId: 'c3' }, content: [{ type: 'text', text: small }] } } }],
  ])
  const { session, appended } = fakeSession(events)
  const r = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  assert.deepEqual(r, { stubbed: 1 })
  const rel = artifactPath(sha256(big))
  assert.equal(fs.readFileSync(path.join(cwd, '.dsh-chapters', rel), 'utf8'), big, 'artifact carries exact bytes')
  assert.equal(appended.length, 2, 'prune + replacement pair')
  assert.equal(appended[0]!.type, 'compaction/prune')
  assert.deepEqual(appended[0]!.data.shadowedSeqs, [2])
  assert.deepEqual(appended[1]!.opts.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assert.deepEqual(appended[1]!.opts.sourceEventSeqs, [2])
  const stub = String((events.get(2) as Ev).data.message.content[0].text)
  assert.ok(stub.includes(ARRIVAL_MARKER) && stub.includes(rel) && stub.includes('chapters_artifact'), stub.slice(0, 160))
  assert.equal((events.get(3) as Ev).data.message.content[0].text, 'ok', 'small node untouched')
  const r2 = await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  assert.equal(r2.stubbed, 0, 'idempotent: the stub is small and marker-carrying')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('non-text blocks survive the stub', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'))
  const big = 'x'.repeat(30_000)
  const events = new Map<number, Ev>([
    [1, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: big }, { type: 'image', bytes: '…' }] } } }],
  ])
  const { session } = fakeSession(events)
  await applyArrivalStubs(session, { cwd, storeRoot: '.dsh-chapters', floorTokens: 3000, estimate: est })
  const content = (events.get(1) as Ev).data.message.content
  assert.equal(content.length, 2)
  assert.equal(content[1]!.type, 'image', 'image preserved after the stub text block')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('disk failure degrades to inline (loud detail), never throws', async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')), 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  const events = new Map<number, Ev>([
    [1, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'y'.repeat(30_000) }] } } }],
  ])
  const { session, appended } = fakeSession(events)
  const r = await applyArrivalStubs(session, { cwd: blocker, storeRoot: 'nope', floorTokens: 3000, estimate: est })
  assert.equal(r.stubbed, 0)
  assert.match(String(r.detail), /artifact write failed/)
  assert.equal(appended.length, 0, 'nothing half-committed')
  assert.equal((events.get(1) as Ev).data.message.content[0].text.length, 30_000, 'blob stays inline')
})
