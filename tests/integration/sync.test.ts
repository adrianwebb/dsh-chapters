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
import { makeFakeRemote, makeFakeDriver, type FakeRemote } from './fake-driver.ts'

let root: string
const remote: FakeRemote = makeFakeRemote()
const driver = makeFakeDriver(remote)
const projectA = { projectKey: 'KEY', slug: 'proj', remote: 'https://remote.example/proj.git', harnessId: 'harness-a', linkedAt: 'now' }
const projectB = { ...projectA, harnessId: 'harness-b' }
const machineA = () => path.join(root, 'machine-a')
const machineB = () => path.join(root, 'machine-b')

const writeFile = (p: string, content: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }
const syncA = (extra?: Parameters<typeof runSync>[0]) => runSync({ cwd: machineA(), storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: projectA, driver, ...extra })
const syncB = (extra?: Parameters<typeof runSync>[0]) => runSync({ cwd: machineB(), storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: projectB, driver, ...extra })

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

test('sync never throws into the caller (best-effort, record §5.3)', async () => {
  // a clone target that is neither empty nor a repo: ensureClone fails, runSync reports
  fs.mkdirSync(path.join(root, 'machine-c', '.dsh-knowledge'), { recursive: true })
  writeFile(path.join(root, 'machine-c', '.dsh-knowledge', 'junk.txt'), 'x')
  const res = await runSync({ cwd: path.join(root, 'machine-c'), storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: projectA, driver })
  assert.equal(res.ok, false)
  assert.match(res.detail, /not empty/i)
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
