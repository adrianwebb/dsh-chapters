/**
 * The engine ADAPTER's signature listener (knowledge-repo.md §4.1) against
 * the REAL host Session shape. r28 proved this was load-bearing: the listener
 * read `.events`, the host Session only has `snapshotEvents()`, and the L0
 * test that stubbed `.events` happily passed a silently-dead listener. These
 * tests hold the listener to the class shape: a Session-like with a
 * snapshotEvents METHOD collects; an object carrying a bare `.events`
 * property does NOT.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSignatureListener } from '../../src/engine.ts'
import { makeDomainStore } from '../../src/store.ts'
import type { SessionEventLike } from '../../src/types.ts'

const turn = (seq: number, text: string): SessionEventLike =>
  ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }] } })

function fakeDomain() {
  const sessions = new Map<string, unknown>()
  const projects = new Map<string, unknown>()
  return {
    table(name: string) {
      const m = name === 'sessions' ? sessions : projects
      return {
        get: (k: string) => m.get(k),
        put: async (k: string, v: unknown) => { m.set(k, v) },
        entries: () => m.entries(),
        get size() { return m.size },
      }
    },
    close: async () => {},
    raw: { sessions, projects },
  }
}

function fakeListener() {
  const warns: string[] = []
  const domain = fakeDomain()
  const store = makeDomainStore(domain as never)
  const listener = makeSignatureListener({
    store: async () => ({ store }),
    warn: (e) => { warns.push(String(e)) },
  })
  return { domain, listener, warns }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

test('signature listener collects per-turn from snapshotEvents() (the real Session shape)', async () => {
  const { domain, listener, warns } = fakeListener()
  const events: SessionEventLike[] = [
    turn(0, 'edit src/render.ts to defer big results'),
    { type: 'turn/end', seq: 1 },
    turn(2, 'fix src/sync.ts copy-out plan and run npm test -- unit'),
    { type: 'turn/end', seq: 3 },
  ]
  const session = { id: 'p-adapt', snapshotEvents: () => events }
  // SAME-TICK on purpose: the per-session queue must serialize the two
  // read-modify-append writes (without it the second put clobbers the first).
  listener(session, { type: 'turn/end', seq: 1 })
  listener(session, { type: 'turn/end', seq: 3 })
  await settle()
  const st = domain.raw.sessions.get('p-adapt') as { collections: { seqs: number[]; paths: string[] }[] }
  assert.equal(st.collections.length, 2, 'one collection per completed turn')
  assert.deepEqual(st.collections[0]!.seqs, [0, 1])
  assert.deepEqual(warns, [], 'no containment warnings on the happy path')
  assert.ok(st.collections[1]!.paths.some((p) => p.includes('sync')), 'turn-2 paths from prose')
})

test('a Session-shaped object WITHOUT snapshotEvents is ignored (no phantom .events reads)', async () => {
  const { domain, listener, warns } = fakeListener()
  const stale = { id: 'p-legacy', events: [turn(0, 'x'), { type: 'turn/end', seq: 1 }] }
  listener(stale, { type: 'turn/end', seq: 1 })
  await settle()
  assert.equal(domain.raw.sessions.get('p-legacy'), undefined, 'nothing stored — the old broken read must not revive')
})
