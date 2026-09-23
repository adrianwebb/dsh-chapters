/**
 * The §5 sync loop over the TreeDX transport, at the same transport-grade
 * level as sync.test.ts (fake git) and sync-remote.test.ts (real git-over-
 * HTTP): machine A publishes chapters, machine B clones and SEARCH FINDS
 * them, interleaved publishing converges, and divergence on the TreeDX
 * head routes through runSync's rebuild-from-the-store path.
 *
 * The service is the stub server (semantics pinned to the docs); the real
 * service is re-checked by treedx-live.test.ts when a container is up.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStubTreeDx, type StubTreeDx } from './treedx-stub-server.ts'
import { createTreedxProvider } from '../../src/treedx/provider.ts'
import { runSync, DEFAULT_CLONE_DIR, type ProjectRecord } from '../../src/sync.ts'
import { searchKnowledge } from '../../src/search.ts'

let stub: StubTreeDx
let root: string

const chapter = (title: string, body: string, topics: string[]): string =>
  `---\ntitle: "${title}"\ntopics: [${topics.map((t) => JSON.stringify(t)).join(', ')}]\n---\n# ${title}\n\n${body}\n`

const project = (harness: string, cwd: string): ProjectRecord => ({
  projectKey: 'TREEX', slug: 'dsh-kb-loop', remote: `treedx+${stub.base}/dsh-kb-loop`,
  harnessId: harness, linkedAt: 'now', cwd, kind: 'treedx',
})
const writeFile = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const sync = (harness: string, extra: { collections?: { sessionId: string; lines: string[] }[] } = {}) => {
  const cwd = path.join(root, harness)
  return runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR,
    project: project(harness, cwd),
    token: stub.token,
    provider: createTreedxProvider({ fetchTimeoutMs: 5000, workspaceTtlSeconds: 60, leaseRetries: 1, leaseRetryDelayMs: 0, sleep: async () => {} }),
    force: true,
    ...(extra.collections !== undefined ? { collections: extra.collections } : {}),
  })
}

before(async () => {
  stub = await startStubTreeDx()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'treedx-sync-'))
  await fetch(`${stub.base}/api/v1/repos`, {
    method: 'POST', headers: { authorization: `Bearer ${stub.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryName: 'dsh-kb-loop', source: { type: 'empty' }, placement: { mode: 'local' } }),
  })
})
after(async () => { await stub.stop(); fs.rmSync(root, { recursive: true, force: true }) })

test('machine A publishes chapters + a collection over TreeDX (create → workspace → commit)', async () => {
  const cwdA = path.join(root, 'harness-a')
  writeFile(path.join(cwdA, '.dsh-chapters', 'rootA', 'chapters', '001-treedx-loop.md'), chapter('treedx loop', 'sync over the remote api', ['sync', 'treedx']))
  const a = await sync('harness-a', { collections: [{ sessionId: 'rootA', lines: ['{"seqs":[1],"by":"deterministic"}'] }] })
  assert.ok(a.ok, `${a.detail} | ${a.steps.join('; ')}`)
  assert.equal(a.mode, 'synced')
  const tree = stub.treeOf('dsh-kb-loop')
  assert.equal(tree?.get(path.posix.join('chapters', 'TREEX', 'rootA', '001-treedx-loop.md')), chapter('treedx loop', 'sync over the remote api', ['sync', 'treedx']))
  assert.ok(tree?.has(path.posix.join('collections', 'TREEX', 'rootA.jsonl')))
  assert.ok(tree?.has(path.posix.join('index', 'manifest.json')), 'the index build rode the same commit')
})

test('machine B clones through the provider and SEARCH FINDS A (exit criterion)', async () => {
  const cwdB = path.join(root, 'harness-b')
  fs.mkdirSync(cwdB, { recursive: true })
  const b = await sync('harness-b')
  assert.ok(b.ok, b.detail)
  const cloneDir = path.join(cwdB, DEFAULT_CLONE_DIR)
  assert.ok(fs.existsSync(path.join(cloneDir, 'chapters', 'TREEX', 'rootA', '001-treedx-loop.md')))
  const hits = searchKnowledge(cloneDir, 'treedx sync', 400, { projectKey: 'TREEX' })
  assert.ok(hits.results.some((r) => r.path.includes('001-treedx-loop')), hits.line)
})

test('interleaved publishing converges: disjoint chapter trees, one head', async () => {
  const cwdA = path.join(root, 'harness-a')
  writeFile(path.join(cwdA, '.dsh-chapters', 'rootA', 'chapters', '002-second.md'), chapter('second topic', 'more work', ['auth']))
  const a = await sync('harness-a')
  assert.ok(a.ok, a.detail)
  const cwdB = path.join(root, 'harness-b')
  writeFile(path.join(cwdB, '.dsh-chapters', 'rootB', 'chapters', '001-b-first.md'), chapter('b chapter', 'other machine', ['deploy']))
  const b = await sync('harness-b')
  assert.ok(b.ok, b.detail)
  const tree = stub.treeOf('dsh-kb-loop')
  for (const p of [
    path.posix.join('chapters', 'TREEX', 'rootA', '001-treedx-loop.md'),
    path.posix.join('chapters', 'TREEX', 'rootA', '002-second.md'),
    path.posix.join('chapters', 'TREEX', 'rootB', '001-b-first.md'),
  ]) assert.ok(tree?.has(p), `remote lost ${p}`)
  // A's next pass sees B's chapter (mirror is the search corpus in every mode)
  const a2 = await sync('harness-a')
  assert.ok(a2.ok, a2.detail)
  assert.ok(fs.existsSync(path.join(cwdA, DEFAULT_CLONE_DIR, 'chapters', 'TREEX', 'rootB', '001-b-first.md')))
})

test('head moved underneath staged work => runSync rebuilds the mirror from the store', async () => {
  const cwdA = path.join(root, 'harness-a')
  writeFile(path.join(cwdA, '.dsh-chapters', 'rootA', 'chapters', '003-third.md'), chapter('third', 'staged divergence test', ['diverge']))
  const headBefore = stub.headOf('dsh-kb-loop')
  // a THIRD machine lands work while our pass computes its staged set
  stub.commitFromOutside('dsh-kb-loop', 'chapters/TREEX/rootC/001-elsewhere.md', chapter('elsewhere', 'foreign work', ['other']))
  assert.notEqual(stub.headOf('dsh-kb-loop'), headBefore, 'external commit moved the head')
  const a = await sync('harness-a')
  assert.ok(a.ok, `${a.detail} | ${a.steps.join('; ')}`)
  assert.ok(a.steps.some((s) => /rebuilding/i.test(s)), `rebuild did not fire: ${a.steps.join('; ')}`)
  const tree = stub.treeOf('dsh-kb-loop')
  assert.ok(tree?.has(path.posix.join('chapters', 'TREEX', 'rootA', '003-third.md')), 'our store file republished')
  assert.ok(tree?.has('chapters/TREEX/rootC/001-elsewhere.md'), 'the foreign work survived the rebuild')
})

test('TreeDX unreachable degrades to local-only — search keeps working (record §5.3)', async () => {
  const cwd = path.join(root, 'harness-down')
  writeFile(path.join(cwd, '.dsh-chapters', 'rootD', 'chapters', '001-down.md'), chapter('offline work', 'no service', ['degrade']))
  const url = stub.base
  await stub.stop()
  const dead = { url: `treedx+${url}/dsh-kb-loop`, token: 'x' }
  const r = await runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR,
    project: { projectKey: 'TREEX', slug: 'dsh-kb-loop', remote: dead.url, harnessId: 'h-down', linkedAt: 'now', cwd, kind: 'treedx' },
    token: 'x',
    provider: createTreedxProvider({ fetchTimeoutMs: 1500, leaseRetries: 0, leaseRetryDelayMs: 0, sleep: async () => {} }),
    force: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.mode, 'local-only')
  // The offline mirror still supports the local loop: publish, commit, search.
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_CLONE_DIR, 'chapters', 'TREEX', 'rootD', '001-down.md')), 'mirror materialized offline')
  const hits = searchKnowledge(path.join(cwd, DEFAULT_CLONE_DIR), 'offline degrade', 400)
  assert.ok(hits.total > 0, 'search works against the offline mirror')
  // (stub stays down — the suite's per-test isolation restarts it in `before`.)
})
