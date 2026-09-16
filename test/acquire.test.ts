/**
 * acquireChapterStore: the one-domain-one-opener rule (r27b's product bug —
 * DomainFacility.open reserves the name and only close() releases it; every
 * second opener threw already-open and broke compaction).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireChapterStore, type DomainLike } from '../src/store.ts'

const fakeDomain = (): DomainLike => ({
  table() {
    const m = new Map<string, any>()
    return { get: (k) => m.get(k), put: async (k, v) => { m.set(k, v) }, entries: () => m.entries(), get size() { return m.size } }
  },
  close: async () => {},
})

test('first acquirer opens and owns', async () => {
  const live = fakeDomain()
  const facility = {
    opened: false,
    async open() { if (this.opened) throw Object.assign(new Error("domain 'dsh_chapters' is already open"), { code: 'already-open' }); this.opened = true; return live },
    get: () => (facility.opened ? live : undefined),
  }
  const h = await acquireChapterStore(facility)
  assert.equal(h.owner, true)
  const second = await acquireChapterStore(facility)
  assert.equal(second.owner, false) // adopts the live handle, no close ownership
  await second.store.put('x', { parentSession: null, rootSession: 'x', nextChapterNumber: 1, chapters: [], reservations: {}, plans: {}, finalized: {}, shadowedSeqs: undefined } as never)
  const back = await h.store.get('x') // read through the OPENER's handle: proves both share one table
  assert.equal(back.rootSession, 'x')
})

test('a non-already-open failure propagates untouched', async () => {
  const facility = { async open() { throw new Error('backend gone') }, get: () => undefined }
  await assert.rejects(() => acquireChapterStore(facility as never), /backend gone/)
})

test('already-open with nothing live behind it still throws', async () => {
  const facility = { async open() { throw new Error("domain 'dsh_chapters' is already open") }, get: () => undefined }
  await assert.rejects(() => acquireChapterStore(facility as never), /already open/)
})
