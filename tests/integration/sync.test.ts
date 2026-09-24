/**
 * The sync loop (record §5) against a fake driver that models the git
 * semantics the loop relies on — see tests/integration/fake-driver.ts for
 * why the REAL driver (https-only, isomorphic-git 1.42) cannot reach a
 * file:// remote and the real-remote smoke is a documented manual step
 * (docs/verify.md). Every assertion here is about OUR loop: publish →
 * pull → commit → push, disjoint convergence, collection regeneration,
 * lock behavior, and the status file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, planStoreToRepo, syncLockPath, readSyncStatus } from '../../src/sync.ts'
import { stageAllAndCommit } from '../../src/gitops.ts'
import { canonicalizeRemote, projectKeyFromRemote } from '../../src/repo.ts'
import { makeFakeRemote, makeFakeDriver, type FakeRemote } from '../support/fake-driver.ts'

let root: string
const remote: FakeRemote = makeFakeRemote()
const driver = makeFakeDriver(remote)
const projectA = { projectKey: 'KEY', slug: 'proj', remote: 'https://remote.example/proj.git', harnessId: 'harness-a', linkedAt: 'now' }
const projectB = { ...projectA, harnessId: 'harness-b' }
const machineA = () => path.join(root, 'machine-a')
const machineB = () => path.join(root, 'machine-b')

const writeFile = (p: string, content: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }
const syncA = (extra?: Parameters<typeof runSync>[0]) => runSync({ cwd: machineA(), storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: projectA, provider: driver, ...extra })
const syncB = (extra?: Parameters<typeof runSync>[0]) => runSync({ cwd: machineB(), storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: projectB, provider: driver, ...extra })

test('machine A: clone, publish chapters + artifacts, commit, push', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chapters-sync-'))
  writeFile(path.join(machineA(), '.dsh-chapters', 'rootA', 'chapters', '001-first-topic.md'), '# first\nverbatim body\n')
  writeFile(path.join(machineA(), '.dsh-chapters', 'rootA', 'artifacts', 'ab', 'abcdef0123.txt'), 'deferred blob\n')
  const res = await syncA()
  assert.ok(res.ok, res.detail + ' | ' + res.steps.join('; '))
  // the remote now carries the mapped layout (record §2.2)
  assert.ok(remote.files.has(path.join('chapters', 'KEY', 'rootA', '001-first-topic.md')), [...remote.files.keys()].join(', '))
  assert.ok(remote.files.has(path.join('artifacts', 'KEY', 'ab', 'abcdef0123.txt')))
  const status = readSyncStatus(machineA(), '.dsh-chapters')
  assert.equal(status?.lastOk, true)
})

test('machine B: fresh clone sees machine A\'s chapters', async () => {
  fs.mkdirSync(machineB())
  const res = await syncB()
  assert.ok(res.ok, res.detail + ' | ' + res.steps.join('; '))
  assert.ok(fs.existsSync(path.join(machineB(), '.dsh-knowledge', 'chapters', 'KEY', 'rootA', '001-first-topic.md')))
})

test('collections JSONL publishes per session and regenerates on growth', async () => {
  const gen = (lines: string[]) => syncA({ collections: [{ sessionId: 'sess-1', lines }] })
  const first = await gen(['{"seqs":[1]}'])
  assert.ok(first.ok, first.detail)
  assert.ok(fs.existsSync(path.join(machineA(), '.dsh-knowledge', 'collections', 'KEY', 'sess-1.jsonl')))
  const grown = await gen(['{"seqs":[1]}', '{"seqs":[2]}'])
  assert.ok(grown.ok, grown.detail)
  assert.ok(remote.files.get(path.join('collections', 'KEY', 'sess-1.jsonl'))!.includes('{"seqs":[2]}'), 'regenerated JSONL grew, not append-forever')
  const b = await syncB()
  assert.ok(b.ok, b.detail)
  assert.ok(fs.readFileSync(path.join(machineB(), '.dsh-knowledge', 'collections', 'KEY', 'sess-1.jsonl'), 'utf8').includes('{"seqs":[2]}'))
})

test('both machines commit disjoint files; the loop keeps the remote convergent', async () => {
  writeFile(path.join(machineA(), '.dsh-chapters', 'rootA', 'chapters', '002-second-topic.md'), '# second\n')
  const a = await syncA()
  assert.ok(a.ok, a.detail)
  const b = await syncB({ collections: [{ sessionId: 'sess-b', lines: ['{"seqs":[9]}'] }] })
  assert.ok(b.ok, b.detail + ' | ' + b.steps.join('; '))
  assert.ok(remote.files.has(path.join('chapters', 'KEY', 'rootA', '002-second-topic.md')))
  assert.ok(remote.files.has(path.join('collections', 'KEY', 'sess-b.jsonl')))
  assert.ok(remote.files.has(path.join('chapters', 'KEY', 'rootA', '001-first-topic.md')), 'no file lost to interleaved commits')
})

test('a held lock makes runSync skip (never block); force overrides', async () => {
  const cwd = machineB()
  const lock = syncLockPath(path.join(cwd, '.dsh-chapters'))
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, JSON.stringify({ pid: 99999, at: Date.now() }))
  const skipped = await syncB()
  assert.equal(skipped.ok, false)
  assert.match(skipped.detail, /lock/i)
  const forced = await syncB({ force: true })
  assert.ok(forced.ok, forced.detail)
  assert.equal(fs.existsSync(lock), false, 'lock released after the forced run')
})

test('a dirty mirror self-heals: moved aside (never deleted), clone proceeds, sync succeeds', async () => {
  // The r39-era e2e failure class, pinned: stale residue in the mirror dir
  // once made EVERY clone refuse forever ('exists and is not empty and not a
  // git repo'). Dead transport now moves aside under a .stale-<ts> name —
  // strictly weaker than the diverged-rebuild path's rm -rf, and refusing was
  // the bug. The store is the truth (§3.1); the mirror is disposable transport.
  const cwd = path.join(root, 'machine-c')
  fs.mkdirSync(path.join(cwd, '.dsh-knowledge'), { recursive: true })
  writeFile(path.join(cwd, '.dsh-knowledge', 'junk.txt'), 'x')
  const res = await runSync({ cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: projectA, provider: driver })
  assert.ok(res.ok, `${res.detail} | ${res.steps.join('; ')}`)
  const stale = fs.readdirSync(cwd).filter((f) => f.startsWith('.dsh-knowledge.stale-'))
  assert.equal(stale.length, 1, 'residue preserved in exactly one .stale- dir')
  assert.equal(fs.readFileSync(path.join(cwd, stale[0]!, 'junk.txt'), 'utf8'), 'x', 'moved aside, not destroyed')
})

test('sync never throws into the caller (best-effort, record §5.3)', async () => {
  // an unreachable remote at clone time: the offline mirror keeps local work,
  // and the failure is a VALUE, not an exception (the dirty-dir refusal it
  // once tested is now the self-heal case above)
  const cwd = path.join(root, 'machine-d')
  fs.mkdirSync(cwd, { recursive: true })
  writeFile(path.join(cwd, '.dsh-chapters', 'rootA', 'chapters', '001-x.md'), '# x\n')
  const res = await runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: projectA,
    provider: makeFakeDriver(makeFakeRemote(), { unreachable: { clone: true } }),
  })
  assert.equal(res.ok, false)
  assert.equal(res.mode, 'local-only')
  assert.match(res.detail, /unreachable/i)
})

test('planStoreToRepo maps the store layout to the repo layout (record §2.2)', () => {
  const plan = planStoreToRepo(path.join(machineA(), '.dsh-chapters'), 'KEY')
  const rels = plan.map((p) => p.rel)
  assert.ok(rels.some((r) => r === path.join('chapters', 'KEY', 'rootA', '001-first-topic.md')))
  assert.ok(rels.some((r) => r === path.join('artifacts', 'KEY', 'ab', 'abcdef0123.txt')), 'artifact drops the session prefix (content-addressed, shared)')
})

test('repo identity: canonicalization and projectKey stability', () => {
  assert.equal(canonicalizeRemote('https://GitHub.com/Adrian/Project.git'), 'github.com/adrian/project')
  assert.equal(projectKeyFromRemote('https://github.com/adrian/project'), projectKeyFromRemote('https://GitHub.com/Adrian/Project.git'))
  assert.match(projectKeyFromRemote('https://github.com/adrian/project'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('REAL driver smoke: local repo commit + nothing-to-commit (no network involved)', async () => {
  const { isomorphicDriver } = await import('../../src/gitops.ts')
  const dir = path.join(root, 'real-repo')
  fs.mkdirSync(dir)
  const gitmod = await import('isomorphic-git')
  const nodefs = await import('node:fs')
  await gitmod.init({ fs: nodefs as never, dir })
  writeFile(path.join(dir, 'a.md'), 'hello\n')
  const author = { name: 'dsh-chapters', email: 'harness@test.local' }
  const first = await isomorphicDriver.stageAllAndCommit(dir, 'first', author)
  assert.ok(first.ok, first.detail)
  const second = await isomorphicDriver.stageAllAndCommit(dir, 'again', author)
  assert.match(second.detail, /nothing to commit/)
  assert.ok(isomorphicDriver.ensureClone !== undefined)
})

// ------------------------------------------------- the push-rejected second acts
// (a fault-wrapped fake: the loop's rejected→retry branches were never
// reached by ANY git-plane test — the fake's pull always merges before push
// can reject, so the injected first-push failure is the honest way in.)

function rejectingOnce(inner: ReturnType<typeof makeFakeDriver>): ReturnType<typeof makeFakeDriver> {
  let fired = false
  return { ...inner, async push(dir, rem, o) {
    if (!fired) { fired = true; return { ok: false, code: 'rejected', detail: 'push rejected (injected: remote moved mid-pass)' } }
    return inner.push(dir, rem, o)
  } }
}

test('push rejected ⇒ ff-retry pulls and re-pushes (the retry path, converged)', async () => {
  const cwd = path.join(root, 'retry-machine')
  fs.mkdirSync(path.join(cwd, '.dsh-chapters', 'sessR', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.dsh-chapters', 'sessR', 'chapters', '001-r.md'), '# r\n\nretry content\n')
  const r = await runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge',
    project: { projectKey: 'KEY', slug: 'proj', remote: 'https://remote.example/proj.git', harnessId: 'h-retry', linkedAt: 'now', cwd },
    provider: rejectingOnce(driver) as never, force: true,
  })
  assert.ok(r.ok, r.detail)
  assert.ok(r.steps.some((s) => s.includes('ff-retried')), `retry step present: ${r.steps.join('; ')}`)
  assert.ok([...remote.files.keys()].some((f) => f.endsWith('001-r.md')), 'the work landed on the remote after retry')
})

test('retry pull itself diverges ⇒ rebuild-from-the-store recovers both sides', async () => {
  const cwd = path.join(root, 'diverge-machine')
  fs.mkdirSync(path.join(cwd, '.dsh-chapters', 'sessD', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.dsh-chapters', 'sessD', 'chapters', '001-d.md'), '# d\n\nmine\n')
  let push1 = true
  let pullCalls = 0
  const inner = driver
  const faulted = {
    ...inner,
    async push(dir: string, rem: never, o?: never) {
      if (push1) { push1 = false; return { ok: false, code: 'rejected', detail: 'injected reject' } as never }
      return inner.push(dir, rem as never, o)
    },
    async pullFastForward(dir: string, rem: never, o?: never) {
      pullCalls += 1
      // pull #1 is the normal pass (must succeed); ONLY the retry pull after
      // the rejected push diverges — that's the branch under test (line 559).
      if (pullCalls === 2) return { ok: false, code: 'diverged', detail: 'injected: retry pull diverges' } as never
      return inner.pullFastForward(dir, rem as never, o)
    },
  } as unknown as typeof driver
  const r = await runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge',
    project: { projectKey: 'KEY', slug: 'proj', remote: 'https://remote.example/proj.git', harnessId: 'h-div', linkedAt: 'now', cwd },
    provider: faulted, force: true,
  })
  assert.ok(r.ok, `rebuild must recover: ${r.detail} | ${r.steps.join('; ')}`)
  assert.ok(r.steps.some((s) => /rebuild/i.test(s)), `rebuild step recorded: ${r.steps.join('; ')}`)
  assert.ok([...remote.files.keys()].some((f) => f.endsWith('001-d.md')), 'diverged work shipped after rebuild')
})

test('a lock that cannot be written reports unavailable, never a benign skip', async () => {
  const cwd = path.join(root, 'lock-machine')
  const store = path.join(cwd, '.dsh-chapters')
  fs.mkdirSync(store, { recursive: true })
  fs.chmodSync(store, 0o500) // r-x: writing the lock (or the status) must fail
  try {
    const r = await runSync({
      cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge',
      project: { projectKey: 'KEY', slug: 'proj', remote: 'https://remote.example/proj.git', harnessId: 'h-lock', linkedAt: 'now', cwd },
      provider: driver, force: true,
    })
    assert.equal(r.ok, false, 'an unwritable lock dir never reports success')
    assert.match(r.detail, /lock unavailable|EACCES/i, `honest failure: ${r.detail}`)
  } finally {
    fs.chmodSync(store, 0o700)
  }
})

test('a junk-strewn store and mirror are absorbed: non-md files, stray files where dirs belong, corrupt manifest, empty chapter', async () => {
  const junk = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-junk-'))
  const cwd = path.join(junk, 'machine')
  const sess = path.join(cwd, '.dsh-chapters', 'sessJ', 'chapters')
  fs.mkdirSync(sess, { recursive: true })
  fs.writeFileSync(path.join(sess, '001-real.md'), '# real\n\ncontent here\n')
  fs.writeFileSync(path.join(sess, 'notes.txt'), 'not markdown, must be skipped by the copier')
  fs.mkdirSync(path.join(cwd, '.dsh-chapters', 'sessJ'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.dsh-chapters', 'loose.md'), 'a stray file at store root, not under a session dir')
  const r = await runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge',
    project: { ...projectA, harnessId: 'h-junk', cwd }, provider: driver, force: true,
  })
  assert.ok(r.ok, r.detail)
  // poison the mirror between passes: a non-dir in the harness slot + a broken manifest
  const mirror = path.join(cwd, '.dsh-knowledge')
  fs.mkdirSync(path.join(mirror, 'rules'), { recursive: true })
  fs.writeFileSync(path.join(mirror, 'rules', 'NOT-A-DIR.md'), 'stray where only dirs may live')
  fs.mkdirSync(path.join(mirror, 'index'), { recursive: true })
  fs.writeFileSync(path.join(mirror, 'index', 'manifest.json'), '{ not json at all')
  fs.writeFileSync(path.join(mirror, 'chapters', 'KEY', 'empty.md'), '')
  const r2 = await runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge',
    project: { ...projectA, harnessId: 'h-junk', cwd }, provider: driver, force: true,
  })
  assert.ok(r2.ok, `the rebuild must survive the poison: ${r2.detail}`)
  fs.rmSync(junk, { recursive: true, force: true })
})
