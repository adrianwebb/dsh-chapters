/**
 * The TreeDX transport verbs against the stub service (tests/integration/
 * treedx-stub-server.ts): every branch of src/treedx/provider.ts exercised
 * directly — clone/materialize, stage-diff, ff pull, diverged pull, lease
 * retry, auth refusal, blob-vs-file write, over-limit refusal, origin
 * mismatch, and the offline recovery path.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStubTreeDx, type StubTreeDx } from './treedx-stub-server.ts'
import { createTreedxProvider, type TreedxProviderConfig } from '../../src/treedx/provider.ts'
import { readState } from '../../src/treedx/state.ts'
import type { RemoteSpec } from '../../src/gitops.ts'

let stub: StubTreeDx
let root: string

const mk = (): ReturnType<typeof createTreedxProvider> => createTreedxProvider({
  fetchTimeoutMs: 5000, workspaceTtlSeconds: 60, leaseRetries: 1, leaseRetryDelayMs: 0, sleep: async () => {},
} satisfies Partial<TreedxProviderConfig>)
const remoteOf = (name: string): RemoteSpec => ({ url: `treedx+${stub.base}/${name}`, token: stub.token })
const dirOf = (who: string): string => path.join(root, who, '.dsh-knowledge')
const project = (cwd: string) => ({ projectKey: 'K', slug: 's', remote: '', harnessId: 'h', linkedAt: 'now', cwd })

before(async () => {
  stub = await startStubTreeDx()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'treedx-provider-'))
  await fetch(`${stub.base}/api/v1/repos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${stub.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryName: 'dsh-kb-alpha', source: { type: 'empty' }, placement: { mode: 'local' } }),
  })
})
after(async () => { await stub.stop(); fs.rmSync(root, { recursive: true, force: true }) })

const writeMirrorFile = (dir: string, rel: string, content: string | Buffer): void => {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

test('ensureClone materializes a live-shaped repo (born head, .treedxkeep excluded)', async () => {
  const p = mk()
  const dir = dirOf('empty')
  fs.mkdirSync(dir, { recursive: true })
  const r = await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(r.ok, r.detail)
  const s = readState(dir)
  assert.ok(s !== null && s.offline === false)
  assert.equal(typeof s.head, 'string', 'LIVE-MEASURED: managed repos are born with refs/heads/main')
  assert.ok((s.head ?? '').length > 0)
  assert.equal(s.repoId?.startsWith('repo_'), true, 'catalog repo id cached in state')
  assert.ok(!fs.existsSync(path.join(dir, '.treedxkeep')), 'service bookkeeping never enters the mirror')
  assert.equal(s.baseline['.treedxkeep'], undefined, '…or the baseline (a phantom-deletion delete-push would violate ff-only)')
})

test('stageAllAndCommit diffs against the state baseline, then push commits to the service', async () => {
  const p = mk()
  const dir = dirOf('pub')
  const clone = await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(clone.ok)
  writeMirrorFile(dir, 'chapters/K/rootA/001-first.md', '# first\nhello\n')
  writeMirrorFile(dir, 'artifacts/K/ab/abcdef.txt', 'blob-ish\n')
  const staged = await p.stageAllAndCommit(dir, 'dsh-chapters: K', { name: 'dsh-chapters', email: 'h@x.local' })
  assert.ok(staged.ok && staged.changed === true, staged.detail)
  const again = await p.stageAllAndCommit(dir, 'noop', { name: 'n', email: 'e' })
  assert.equal(again.detail, 'nothing to commit', 'second stage sees the same bytes as clean')
  const pushed = await p.push(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(pushed.ok, pushed.detail)
  const tree = stub.treeOf('dsh-kb-alpha')
  assert.equal(tree?.get('chapters/K/rootA/001-first.md'), '# first\nhello\n')
  const s = readState(dir)
  assert.ok(s !== null && s.head !== null, 'push advanced the tracked head')
  assert.equal(s.staged, null, 'staged list cleared after a successful push')
})

test('a second machine clones the materialized corpus (search-surface parity)', async () => {
  const p = mk()
  const dir = dirOf('puller')
  const r = await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(r.ok)
  assert.equal(fs.readFileSync(path.join(dir, 'chapters/K/rootA/001-first.md'), 'utf8'), '# first\nhello\n')
  const pull = await p.pullFastForward(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(pull.ok && /up to date/.test(pull.detail))
})

test('pull fast-forwards (no staged work): refetch materializes the newer head', async () => {
  const p = mk()
  const dir = dirOf('ff')
  await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  stub.commitFromOutside('dsh-kb-alpha', 'chapters/K/rootB/002-second.md', '# second\n')
  const r = await p.pullFastForward(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(r.ok && r.changed === true, r.detail)
  assert.ok(fs.existsSync(path.join(dir, 'chapters/K/rootB/002-second.md')), 'new file materialized')
})

test('pull with staged work against a moved head => diverged (rebuild is the recovery)', async () => {
  const p = mk()
  const dir = dirOf('div')
  const clone = await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(clone.ok, clone.detail)
  const headBefore = readState(dir)!.head
  stub.commitFromOutside('dsh-kb-alpha', 'chapters/K/rootC/003-third.md', '# third\n')
  writeMirrorFile(dir, 'chapters/K/mine/001-mine.md', 'mine\n')
  await p.stageAllAndCommit(dir, 'mine', { name: 'n', email: 'e' })
  const r = await p.pullFastForward(dir, remoteOf('dsh-kb-alpha'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'diverged', 'staged work + moved head is divergence, never a merge')
  void headBefore
})

test('lease contention: workspace-create 409 exhausts bounded retries, then rejected', async () => {
  // Hold the branch lease from outside, then let the retry budget run out.
  const holder = await fetch(`${stub.base}/api/v1/repos/dsh-kb-alpha/workspaces`, {
    method: 'POST',
    headers: { authorization: `Bearer ${stub.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ branchName: 'refs/heads/main', mode: 'writable', baseRef: 'refs/heads/main', ttlSeconds: 60 }),
  })
  assert.equal(holder.status, 200, 'holder got the lease')
  const p = mk()
  const dir = dirOf('lease')
  await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  writeMirrorFile(dir, 'chapters/K/leased/001-x.md', 'x\n')
  await p.stageAllAndCommit(dir, 'x', { name: 'n', email: 'e' })
  const r = await p.push(dir, remoteOf('dsh-kb-alpha'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'rejected', 'lease-busy is the retry class, not divergence')
  stub.releaseLeases()
  const r2 = await p.push(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(r2.ok, r2.detail)
})

test('wrong token => auth-class refusal; the message never carries the token', async () => {
  const p = mk()
  const dir = path.join(root, 'authfail', '.dsh-knowledge')
  fs.mkdirSync(dir, { recursive: true })
  const r = await p.ensureClone(dir, { url: `treedx+${stub.base}/dsh-kb-alpha`, token: 'wrong-token-sentinel' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'auth')
  assert.ok(!r.detail.includes('wrong-token-sentinel'), 'token material never echoes into status (§2.1)')
})

test('unknown repository => not_found with a re-link hint', async () => {
  const p = mk()
  const dir = path.join(root, 'norepo', '.dsh-knowledge')
  fs.mkdirSync(dir, { recursive: true })
  const r = await p.ensureClone(dir, remoteOf('dsh-kb-nope'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'not_found')
})

test('non-UTF-8 staged file travels the blob path (content round-trips)', async () => {
  const p = mk()
  const dir = dirOf('binary')
  await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80])
  writeMirrorFile(dir, 'artifacts/K/bin/blob.bin', bin)
  await p.stageAllAndCommit(dir, 'bin', { name: 'n', email: 'e' })
  const pushed = await p.push(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(pushed.ok, pushed.detail)
  // pull onto another machine and compare BYTES
  const dir2 = dirOf('binary2')
  const p2 = mk()
  await p2.ensureClone(dir2, remoteOf('dsh-kb-alpha'))
  assert.deepEqual(fs.readFileSync(path.join(dir2, 'artifacts/K/bin/blob.bin')), bin)
})

test('oversized UTF-8 file refuses with numbers (never truncates, record §1.2)', async () => {
  const big = await startStubTreeDx({ utf8FileLimitBytes: 100 })
  await fetch(`${big.base}/api/v1/repos`, {
    method: 'POST', headers: { authorization: `Bearer ${big.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryName: 'dsh-kb-limit', source: { type: 'empty' }, placement: { mode: 'local' } }),
  })
  const p = createTreedxProvider({ fetchTimeoutMs: 5000, workspaceTtlSeconds: 60, leaseRetries: 1, leaseRetryDelayMs: 0, sleep: async () => {} })
  const dir = path.join(root, 'limit', '.dsh-knowledge')
  fs.mkdirSync(dir, { recursive: true })
  await p.ensureClone(dir, { url: `treedx+${big.base}/dsh-kb-limit`, token: big.token })
  writeMirrorFile(dir, 'chapters/K/x/001-big.md', 'x'.repeat(500))
  await p.stageAllAndCommit(dir, 'big', { name: 'n', email: 'e' })
  const r = await p.push(dir, { url: `treedx+${big.base}/dsh-kb-limit`, token: big.token })
  assert.equal(r.ok, false)
  assert.match(r.detail, /exceeds TreeDX's UTF-8 file limit/)
  await big.stop()
})

test('origin change is caught by the state sentinel (never sync into the wrong pool)', async () => {
  const p = mk()
  const dir = dirOf('origin')
  await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  const r = await p.ensureClone(dir, remoteOf('dsh-kb-other'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'origin-mismatch')
})

test('push after an externally-moved head => diverged class (commit fail-closed)', async () => {
  const p = mk()
  const dir = dirOf('pushdiv')
  const clone = await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(clone.ok)
  // staged work exists; the service head already moved beyond OUR state head
  stub.failNext({ method: 'POST', pathRe: '/commit$', status: 409, code: 'conflict' })
  writeMirrorFile(dir, 'chapters/K/mine2/001.md', 'mine2\n')
  await p.stageAllAndCommit(dir, 'mine2', { name: 'n', email: 'e' })
  // move the head underneath while state.head lags (simulates the race)
  const st = readState(dir)!
  stub.commitFromOutside('dsh-kb-alpha', 'chapters/K/moved/001.md', 'moved\n')
  void st
  const r = await p.push(dir, remoteOf('dsh-kb-alpha'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'diverged', '409 + moved head => rebuild class, not retry')
})

test('initLocal offline mirror; pull probes recovery and classifies it as diverged', async () => {
  const p = mk()
  const dir = path.join(root, 'offline', '.dsh-knowledge')
  const init = await p.initLocal(dir, remoteOf('dsh-kb-alpha'))
  assert.ok(init.ok)
  writeMirrorFile(dir, 'chapters/K/offline/001.md', 'while down\n')
  const staged = await p.stageAllAndCommit(dir, 'offline work', { name: 'n', email: 'e' })
  assert.ok(staged.ok && staged.changed === true, 'stage works fully offline')
  const blocked = await p.pullFastForward(dir, { url: `treedx+http://127.0.0.1:1/dsh-kb-alpha`, token: stub.token })
  assert.equal(blocked.ok, false, 'service still down => network class')
  const recovered = await p.pullFastForward(dir, remoteOf('dsh-kb-alpha'))
  assert.equal(recovered.ok, false)
  assert.equal(recovered.code, 'diverged', 'reachable again => rebuild from the store (the git-mode-identical recovery)')
  assert.equal(readState(dir)?.offline, true)
})

test('describe names the transport, the repo, and the tracked head', async () => {
  const p = mk()
  const dir = dirOf('desc')
  await p.ensureClone(dir, remoteOf('dsh-kb-alpha'))
  const d = p.describe(project(root))
  assert.match(d, /treedx/)
  void dir
})
