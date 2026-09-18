/**
 * §5.3 failure semantics with the fake driver (the real-protocol versions
 * live in tests/integration/sync-remote.test.ts): every remote-path failure
 * leaves the MIRROR CURRENT and says so with a mode — only local failures
 * stop the pass. And a diverged pull rebuilds transport from truth.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, readSyncStatus, DEFAULT_CLONE_DIR, type ProjectRecord, type SyncOpts } from '../../src/sync.ts'
import { makeFakeRemote, makeFakeDriver } from '../support/fake-driver.ts'
import type { GitDriver } from '../../src/gitops.ts'

const project: ProjectRecord = { projectKey: 'K', slug: 's', remote: 'https://remote.example/x.git', harnessId: 'h', linkedAt: 'now', cwd: '' }

function machine(withStore = true): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'degrade-'))
  if (withStore) {
    fs.mkdirSync(path.join(cwd, '.dsh-chapters', 't1', 'chapters'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.dsh-chapters', 't1', 'chapters', '001-alpha.md'), '---\ntitle: "Alpha"\ntopics: ["src/a.ts"]\n---\nbody\n')
  }
  return cwd
}
const pass = (cwd: string, driver: GitDriver, opts: Partial<SyncOpts> = {}) =>
  runSync({ cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project, force: true, driver, ...opts })

test('unreachable at clone ⇒ offline mirror: publish + index + commit still happen', async () => {
  const cwd = machine()
  const remote = makeFakeRemote()
  const r = await pass(cwd, makeFakeDriver(remote, { unreachable: { clone: true } }))
  assert.equal(r.ok, false)
  assert.equal(r.mode, 'local-only')
  assert.match(r.detail, /offline|unreachable/i)
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_CLONE_DIR, 'chapters', 'K', 't1', '001-alpha.md')), 'mirror is current')
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_CLONE_DIR, 'index')), 'index built even offline')
  assert.equal(readSyncStatus(cwd, '.dsh-chapters')?.mode, 'local-only')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('pull network failure after commit ⇒ local-only, mirror current, deferred push', async () => {
  const cwd = machine()
  const remote = makeFakeRemote()
  await pass(cwd, makeFakeDriver(remote)) // first pass reaches the remote
  const r = await pass(cwd, makeFakeDriver(remote, { unreachable: { fetch: true } }))
  assert.equal(r.ok, false)
  assert.equal(r.mode, 'local-only')
  assert.match(r.detail, /pull unavailable/)
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('push failure ⇒ local-only but committed; steps name the commit', async () => {
  const cwd = machine()
  const remote = makeFakeRemote()
  const r = await pass(cwd, makeFakeDriver(remote, { unreachable: { push: true } }))
  assert.equal(r.ok, false)
  assert.equal(r.mode, 'local-only')
  assert.ok(r.steps.some((s) => /committed/.test(s)), r.steps.join('; '))
  assert.equal(remote.files.size, 0, 'nothing reached the remote')
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('diverged pull ⇒ mirror rebuilt from the remote and pushed (transport, not truth)', async () => {
  const cwd = machine()
  const remote = makeFakeRemote()
  const base = makeFakeDriver(remote)
  let divergedOnce = false
  const driver: GitDriver = {
    ...base,
    async pullFastForward(...a: Parameters<typeof base.pullFastForward>) {
      if (!divergedOnce) { divergedOnce = true; return { ok: false, detail: 'diverged — fast-forward impossible (test)' } }
      return base.pullFastForward(...a)
    },
  }
  const r = await pass(cwd, driver)
  assert.ok(r.ok, r.detail)
  assert.equal(r.mode, 'synced')
  assert.ok(r.steps.some((s) => /rebuilding/i.test(s)), r.steps.join('; '))
  assert.ok([...remote.files.keys()].some((f) => f.endsWith('001-alpha.md')))
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('lock loss mid-pass releases on finally and next pass proceeds', async () => {
  const cwd = machine()
  const remote = makeFakeRemote()
  const driver = makeFakeDriver(remote)
  const lockPath = path.join(cwd, '.dsh-chapters', '.sync.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, at: Date.now() }))
  const r = await runSync({ cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project, driver }) // NOT forced
  assert.equal(r.ok, false)
  assert.match(r.detail, /lock/i)
  fs.rmSync(lockPath, { force: true })
  const r2 = await pass(cwd, driver)
  assert.equal(r2.ok, true, r2.detail)
  fs.rmSync(cwd, { recursive: true, force: true })
})
