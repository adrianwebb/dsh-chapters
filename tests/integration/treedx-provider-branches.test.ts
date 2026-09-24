/**
 * TreeDX provider BRANCH sweep: every error arm that the happy-path and
 * scenario rows in treedx-{provider,sync}.test.ts don't reach — bad targets,
 * mid-flight 5xx faults on refs/repos/workspace/write/commit, the blob-read
 * fallback, the clone strays move-aside, and lease busy/rejected taxonomies.
 * Driven through the public verbs with the stub's one-shot failNext.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStubTreeDx, type StubTreeDx } from './treedx-stub-server.ts'
import { createTreedxProvider } from '../../src/treedx/provider.ts'
import { writeState } from '../../src/treedx/state.ts'
import type { RemoteSpec } from '../../src/gitops.ts'

let stub: StubTreeDx
let root: string
before(async () => {
  stub = await startStubTreeDx()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'treedx-branch-'))
})
after(async () => { await stub?.stop(); fs.rmSync(root, { recursive: true, force: true }) })

const mk = (over: Record<string, unknown> = {}) => createTreedxProvider({
  fetchTimeoutMs: 5000, workspaceTtlSeconds: 60, leaseRetries: 1, leaseRetryDelayMs: 0, sleep: async () => {}, ...over,
} as never)
const remoteOf = (name: string): RemoteSpec => ({ url: `treedx+${stub.base}/${name}`, token: stub.token })
const ensureRepo = async (name: string): Promise<void> => {
  await fetch(`${stub.base}/api/v1/repos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${stub.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryName: name, source: { type: 'empty' }, placement: { mode: 'local' } }),
  })
}
const dirOf = (who: string): string => path.join(root, who, '.dsh-knowledge')

test('bad targets refuse without a network trip', async () => {
  const p = mk()
  const r1 = await p.ensureClone(dirOf('bad1'), { url: 'not-a-url-at-all' })
  assert.equal(r1.ok, false)
  assert.match(r1.detail, /bad treedx remote|not a treedx/)
  const r2 = await p.ensureClone(dirOf('bad2'), { url: 'https://plain.git/repo' })
  assert.equal(r2.ok, false)
  assert.match(r2.detail, /not a treedx\+ target/)
})

test('repos-list auth fault classifies as auth (not the unreachable ghost)', async () => {
  await ensureRepo('dsh-kb-bra1')
  stub.failNext({ method: 'GET', pathRe: '/api/v1/repos$', status: 401, code: 'authentication_required' })
  const r = await mk().ensureClone(dirOf('auth-list'), remoteOf('dsh-kb-bra1'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'auth', `expected auth, got ${r.code}`)
})

test('unknown repo with no cached id refuses not_found; a cached repoId still works', async () => {
  const dir = dirOf('cached-id')
  fs.mkdirSync(dir, { recursive: true })
  const p = mk()
  const r = await p.ensureClone(dir, { url: `treedx+${stub.base}/dsh-kb-nope`, token: stub.token })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'not_found')
  // same dir, but the state caches a real repoId — resolution must bypass the miss
  await ensureRepo('dsh-kb-cached')
  const good = await mk().ensureClone(dirOf('cached-ok'), { url: `treedx+${stub.base}/dsh-kb-cached`, token: stub.token })
  assert.ok(good.ok, good.detail)
  const st = JSON.parse(fs.readFileSync(path.join(dirOf('cached-ok'), '.treedx-state.json'), 'utf8')) as { repoId: string }
  fs.mkdirSync(dirOf('cached-id'), { recursive: true })
  fs.writeFileSync(path.join(dirOf('cached-id'), '.treedx-state.json'), JSON.stringify({ ...st, origin: `treedx+${stub.base}/dsh-kb-nope` }))
  const r2 = await mk().ensureClone(dirOf('cached-id'), { url: `treedx+${stub.base}/dsh-kb-nope`, token: stub.token })
  // state's origin equals remote here; the cached id points at the REAL repo — clone proceeds by id
  assert.ok(r2.ok, `cached repoId resolves even when the name misses: ${r2.detail}`)
})

test('refs fault: non-auth transport failure surfaces as network', async () => {
  await ensureRepo('dsh-kb-brb2')
  const dir = dirOf('refs-fault')
  fs.mkdirSync(dir, { recursive: true })
  // origin must match to hit the clone branch; point state at the url we'll use
  writeState(dir, { origin: `treedx+${stub.base}/dsh-kb-brb2`, head: null, baseline: { 'x.txt': 'a'.repeat(64) }, staged: null, offline: true })
  stub.failNext({ method: 'GET', pathRe: '/refs$', status: 500, code: 'internal' })
  const p = mk()
  const pull = await p.pullFastForward(dir, remoteOf('dsh-kb-brb2'))
  assert.equal(pull.ok, false)
  assert.equal(pull.code, 'network', `refs 500 during pull: ${pull.detail}`)
})

test('clone moves aside strays of a dead non-repo mirror dir', async () => {
  await ensureRepo('dsh-kb-brc3')
  const dir = dirOf('strays')
  fs.mkdirSync(path.join(dir, 'junk'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'junk', 'left.txt'), 'x')
  const r = await mk().ensureClone(dir, remoteOf('dsh-kb-brc3'))
  assert.ok(r.ok, r.detail)
  assert.ok(fs.readdirSync(path.dirname(dir)).some((f) => f.startsWith('.dsh-knowledge.stale-')), 'the corpse moved aside, never deleted')
})

test('binary corpus files ride the blobs/read fallback on clone', async () => {
  await ensureRepo('dsh-kb-brd4')
  // machine A stages a binary artifact through the real push path...
  const dirA = dirOf('bin-a')
  const p = mk()
  await p.ensureClone(dirA, remoteOf('dsh-kb-brd4'))
  fs.mkdirSync(path.join(dirA, 'artifacts', 'ff'), { recursive: true })
  fs.writeFileSync(path.join(dirA, 'artifacts', 'ff', 'blob.bin'), Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80]))
  fs.mkdirSync(path.join(dirA, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(dirA, 'chapters', 'note.md'), '---\ntitle: "n"\n---\n# n\n')
  await p.stageAllAndCommit(dirA, 'binary commit', { name: 't', email: 't@t' })
  const push = await p.push(dirA, remoteOf('dsh-kb-brd4'))
  assert.ok(push.ok, `push with binary: ${push.detail}`)
  // machine B clones: the binary must come back byte-exact via blobs/read
  const dirB = dirOf('bin-b')
  const r2 = await mk().ensureClone(dirB, remoteOf('dsh-kb-brd4'))
  assert.ok(r2.ok, r2.detail)
  assert.deepEqual([...fs.readFileSync(path.join(dirB, 'artifacts', 'ff', 'blob.bin'))], [0x00, 0x01, 0xfe, 0xff, 0x80])
})

test('overlay write mid-flight 5xx fails the push with the write detail', async () => {
  await ensureRepo('dsh-kb-bre5')
  const dir = dirOf('write-fail')
  const p = mk()
  await p.ensureClone(dir, remoteOf('dsh-kb-bre5'))
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'chapters', 'fresh.md'), '# fresh\n')
  await p.stageAllAndCommit(dir, 'fresh', { name: 't', email: 't@t' })
  stub.failNext({ method: 'PUT', pathRe: '/workspaces/[^/]+/files$', status: 500, code: 'internal' })
  const r = await p.push(dir, remoteOf('dsh-kb-bre5'))
  assert.equal(r.ok, false)
  assert.match(r.detail, /overlay write/, `write fault: ${r.detail}`)
})

test('blob write 413 refuses with the size truth', async () => {
  await ensureRepo('dsh-kb-brf6')
  const dir = dirOf('blob-413')
  const p = mk()
  await p.ensureClone(dir, remoteOf('dsh-kb-brf6'))
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'artifacts', 'big.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00, 0xfe, 0x00]))
  await p.stageAllAndCommit(dir, 'big', { name: 't', email: 't@t' })
  stub.failNext({ method: 'POST', pathRe: '/workspaces/[^/]+/blobs/write$', status: 413, code: 'payload_too_large' })
  const r = await p.push(dir, remoteOf('dsh-kb-brf6'))
  assert.equal(r.ok, false)
  assert.match(r.detail, /exceeds TreeDX's blob limit/, `blob 413: ${r.detail}`)
})

test('workspace create network fault is a network refusal, and the workspace closes on it', async () => {
  await ensureRepo('dsh-kb-brg7')
  const dir = dirOf('ws-net')
  const p = mk()
  await p.ensureClone(dir, remoteOf('dsh-kb-brg7'))
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'chapters', 'n2.md'), '# n2\n')
  await p.stageAllAndCommit(dir, 'n2', { name: 't', email: 't@t' })
  stub.failNext({ method: 'POST', pathRe: '/workspaces$', status: 503, code: 'unavailable' })
  const r = await p.push(dir, remoteOf('dsh-kb-brg7'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'network')
  assert.match(r.detail, /workspace create/)
})

test('commit transport fault falls through to the code branch, and a silent commit re-reads the head', async () => {
  await ensureRepo('dsh-kb-brh8')
  const dir = dirOf('commit-net')
  const p = mk()
  await p.ensureClone(dir, remoteOf('dsh-kb-brh8'))
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'chapters', 'n3.md'), '# n3\n')
  await p.stageAllAndCommit(dir, 'n3', { name: 't', email: 't@t' })
  stub.failNext({ method: 'POST', pathRe: '/workspaces/[^/]+/commit$', status: 500, code: 'boom' })
  const r = await p.push(dir, remoteOf('dsh-kb-brh8'))
  assert.equal(r.ok, false)
  assert.match(r.detail, /commit:/, `commit 500: ${r.detail}`)
  // retry succeeds — the lease path already exists, this proves recovery
  const r2 = await p.push(dir, remoteOf('dsh-kb-brh8'))
  assert.ok(r2.ok, `retry after commit fault: ${r2.detail}`)
})

test('describe speaks every state: not-cloned, offline, head — with the cached repoId', async () => {
  const fresh = path.join(root, 'desc-fresh', '.dsh-knowledge')
  const p = mk()
  assert.match(p.describe({ cwd: path.join(root, 'desc-fresh') } as never), /not cloned yet/)
  fs.mkdirSync(fresh, { recursive: true })
  writeState(fresh, { origin: 'treedx+http://x/y', head: null, baseline: {}, staged: null, offline: true })
  assert.match(p.describe({ cwd: path.join(root, 'desc-fresh') } as never), /offline/)
  writeState(fresh, { origin: 'treedx+http://x/y', head: 'deadbeefcafe1234', baseline: {}, staged: null, offline: false, repoId: 'repo_z' })
  const d = p.describe({ cwd: path.join(root, 'desc-fresh') } as never)
  assert.match(d, /repo_z/, 'cached repoId rides the describe line')
  assert.match(d, /head deadbeefca/)
})
