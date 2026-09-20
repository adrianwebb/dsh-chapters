import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEnrichQueue, type EnrichQueueDeps } from '../../src/enrich-queue.ts'

function harness(over: Partial<EnrichQueueDeps> = {}) {
  const calls: string[] = []
  let pending = ['c1', 'c2', 'c3']
  let pendingFor = (m: string, cap: number) => { void m; return Promise.resolve(pending.slice(0, cap).map((k) => ({ key: k, label: k }))) }
  const deps: EnrichQueueDeps = {
    listPending: over.listPending ?? ((m, cap) => { void cap; return pendingFor(m, cap) }),
    enrichOne: over.enrichOne ?? (async (k) => { calls.push(k); return { ok: true } }),
    resolveModel: over.resolveModel ?? (async () => 'test-model'),
    enabled: over.enabled ?? true,
    trigger: over.trigger ?? 'both',
    idleMs: over.idleMs ?? 1000,
    batchCap: over.batchCap ?? 2,
    log: over.log ?? (() => undefined),
    setTimer: over.setTimer,
  }
  return { q: createEnrichQueue(deps), calls, setPending: (p: string[]) => { pending = p } }
}

test('afterPush trigger: drain on sync completion only', async () => {
  const { q, calls } = harness({ trigger: 'afterPush' })
  q.noteActivity() // idle provider NOT active: must not drain
  assert.deepEqual(calls, [])
  q.onSyncDone('test')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, ['c1', 'c2'], 'batch cap honored')
  q.dispose()
})

test('idle trigger: resets on activity, drains once on silence', async () => {
  let fire: (() => void) | null = null
  let resets = 0
  const { q, calls } = harness({
    trigger: 'idle',
    setTimer: (fn) => { fire = fn; resets++; return { cancel: () => { fire = null } } },
  })
  q.noteActivity(); q.noteActivity(); q.noteActivity()
  assert.equal(resets, 3, 'each activity re-arms the debounce')
  assert.equal(typeof fire, 'function')
  fire!()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls.length, 2)
  q.dispose()
})

test('manual trigger: auto paths are silent; drainNow works', async () => {
  const { q, calls } = harness({ trigger: 'manual' })
  q.onSyncDone('x'); q.noteActivity()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, [])
  const n = await q.drainNow()
  assert.equal(n, 2); assert.equal(calls.length, 2)
  q.dispose()
})

test('kill switch: EVERY entry point is a pure no-op', async () => {
  const { q, calls } = harness({ enabled: false })
  q.onSyncDone('x'); q.noteActivity(); assert.equal(await q.drainNow(), 0)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, [])
  assert.equal(q.state().enabled, false)
  q.dispose()
})

test('concurrent triggers collapse into ONE drain; state reports for /chapters-status', async () => {
  const { q } = harness()
  q.onSyncDone('a'); q.onSyncDone('b'); q.onSyncDone('c')
  const st = q.state()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(st.trigger, 'both')
  assert.equal(q.state().lastBatch, 2)
  assert.equal(q.state().model, 'test-model')
  q.dispose()
})

test('a throwing enrichOne... queue survives (enrichOne must not throw, but defend anyway)', async () => {
  const { q, calls } = harness({ enrichOne: async (k) => { calls.push(k); throw new Error('boom') } })
  await q.drainNow()
  assert.equal(q.state().lastBatch, 0, 'failure reported zero processed, no crash')
  q.dispose()
})
