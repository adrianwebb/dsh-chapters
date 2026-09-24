/**
 * TreeDX parser-fallback branch sweep via an injected fetchImpl. The live
 * service (and stub) always answer with the canonical shapes — but the
 * provider carries defensive arms for alternates measured during the API's
 * evolution (repositories/repos keys, id/repoId, entries-as-strings, sha/
 * target/objectId, commitSha/sha, content/contentBase64, encoding base64
 * file reads). The first live run broke on exactly this family of drift, so
 * the arms are the contract — this file pins every one of them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTreedxProvider } from '../../src/treedx/provider.ts'
import { repoCatalog, resolveRepoId } from '../../src/treedx/provider.ts'
import { pick } from '../../src/treedx/client.ts'
import { createTreeDxClient } from '../../src/treedx/client.ts'

type Resp = { status: number; ok: boolean; body: unknown }
const json = (status: number, body: unknown): Resp => ({ status, ok: status >= 200 && status < 300, body })

/** scripted transport: match (METHOD path) → response, LIFO so overrides win */
function scripted(routes: Array<[string, Resp | ((body: unknown) => Resp)]>) {
  const calls: string[] = []
  const fetchImpl = async (url: string, init: Record<string, unknown>) => {
    const u = new URL(url)
    const method = String(init.method ?? 'GET')
    const key = `${method} ${u.pathname}`
    calls.push(key)
    for (let i = routes.length - 1; i >= 0; i -= 1) {
      const [pattern, r] = routes[i]!
      if (pattern === key || pattern === `* ${u.pathname}`) {
        const body = init.body !== undefined ? JSON.parse(String(init.body)) : undefined
        const resp = typeof r === 'function' ? r(body) : r
        return { status: resp.status, ok: resp.ok, text: async () => JSON.stringify(resp.body) }
      }
    }
    return { status: 404, ok: false, text: async () => JSON.stringify({ ok: false, error: { code: 'not_found', message: `unscripted ${key}` } }) }
  }
  return { fetchImpl: fetchImpl as never, calls }
}
const mk = (fetchImpl: never) => createTreedxProvider({ fetchImpl, fetchTimeoutMs: 1000, leaseRetries: 1, leaseRetryDelayMs: 0, sleep: async () => {} } as never)
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'treedx-parse-'))

test('repoCatalog parses every measured key shape', () => {
  assert.deepEqual(repoCatalog({ repos: [{ repositoryName: 'a', repoId: 'r1' }] }), [{ name: 'a', repoId: 'r1' }])
  assert.deepEqual(repoCatalog({ repositories: [{ name: 'b', id: 'r2' }] }), [{ name: 'b', repoId: 'r2' }])
  assert.deepEqual(repoCatalog({ repos: [{ name: 'skip-me', repoId: '' }] }), [], 'a row without an id is dropped')
  assert.deepEqual(repoCatalog({}), [])
})

test('pick() finds the first present object key and skips scalars', () => {
  assert.deepEqual(pick({ workspace: { id: 'w' } }, 'status', 'workspace'), { id: 'w' })
  assert.deepEqual(pick({ status: 'ready', workspace: { id: 'w' } }, 'workspace', 'status'), { id: 'w' })
  assert.equal(pick({ value: 3 }, 'missing'), undefined)
  assert.equal(pick({ status: 'ready' }, 'status'), undefined, 'strings are not object payloads')
})

test('resolveRepoId returns empty on a failed list, found on alternates', async () => {
  const down = scripted([['GET /api/v1/repos', json(500, { ok: false, error: { code: 'boom', message: 'down' } })]])
  assert.equal(await resolveRepoId(createTreeDxClient({ baseUrl: 'http://x', fetchImpl: down.fetchImpl }) as never, 'a'), '')
  const alt = scripted([['GET /api/v1/repos', json(200, { ok: true, repositories: [{ name: 'a', id: 'r9' }] })]])
  assert.equal(await resolveRepoId(createTreeDxClient({ baseUrl: 'http://x', fetchImpl: alt.fetchImpl }) as never, 'a'), 'r9')
})

test('ensureClone parses corpus listings in every measured shape', async () => {
  const dir = tmpDir()
  const s = scripted([
    ['GET /api/v1/repos', json(200, { ok: true, repositories: [{ name: 'kb', id: 'repo_k' }] })],
    ['GET /api/v1/repos/repo_k/refs', json(200, { ok: true, refs: [{ ref: 'refs/heads/main', objectId: 'sha111' }] })],
    ['POST /api/v1/repos/repo_k/paths/list', json(200, {
      ok: true, entries: ['chapters/a.md', { path: 'chapters/b.md', kind: 'blob' }, { path: 'chapters', kind: 'tree' }, { path: '.treedxkeep', kind: 'blob' }],
      page: { hasMore: false },
    })],
    ['* /api/v1/repos/repo_k/files/read', json(200, { ok: true, file: { content: 'UTF8 body' } })],
    ['PUT /api/v1/workspaces/w1/files', json(200, { ok: true })],
    ['GET /api/v1/workspaces/w1', json(200, { ok: true, status: 'ready' })],
  ])
  const p = mk(s.fetchImpl)
  const r = await p.ensureClone(path.join(dir, 'm'), { url: 'treedx+http://svc/kb', token: 't' } as never)
  assert.ok(r.ok, r.detail)
  assert.match(r.detail, /1 file\(s\)|2 file\(s\)/, 'tree rows skipped, dot segments skipped: ' + r.detail)
  assert.ok(fs.existsSync(path.join(dir, 'm', 'chapters', 'a.md')))
  assert.ok(!fs.existsSync(path.join(dir, 'm', '.treedxkeep')), 'the service bookkeeping never lands in the mirror')
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'm', '.treedx-state.json'), 'utf8')) as { head: string; repoId: string }
  assert.equal(st.head, 'sha111', 'refs fallback parsed objectId')
  assert.equal(st.repoId, 'repo_k', 'repositories/id catalog shape resolved')
})

test('clone reads a base64-encoded file read via the encoding fallback', async () => {
  const dir = tmpDir()
  const b64 = Buffer.from('binary-ish \x00\x01', 'utf8').toString('base64')
  const s = scripted([
    ['GET /api/v1/repos', json(200, { ok: true, repos: [{ name: 'kb', repoId: 'r' }] })],
    ['GET /api/v1/repos/r/refs', json(200, { ok: true, refs: [{ name: 'main', target: 'h1' }] })],
    ['POST /api/v1/repos/r/paths/list', json(200, { ok: true, paths: ['artifacts/x.bin'], page: { hasMore: false } })],
    ['* /api/v1/repos/r/files/read', json(200, { ok: true, file: { content: b64, encoding: 'base64' } })],
  ])
  const p = mk(s.fetchImpl)
  const r = await p.ensureClone(dir, { url: 'treedx+http://svc/kb', token: 't' } as never)
  assert.ok(r.ok, r.detail)
  const landed = path.join(dir, 'artifacts', 'x.bin')
  assert.ok(fs.existsSync(landed), 'base64-encoded file read decoded and written')
  assert.deepEqual([...fs.readFileSync(landed)], [...Buffer.from('binary-ish \x00\x01', 'utf8')])
})

test('push parses commit alternates: bare sha and a missing-sha re-read of the head', async () => {
  const dir = tmpDir()
  const base: Array<[string, Resp | ((b: unknown) => Resp)]> = [
    ['GET /api/v1/repos', json(200, { ok: true, repos: [{ name: 'kb', repoId: 'r' }] })],
    ['GET /api/v1/repos/r/refs', json(200, { ok: true, refs: [{ name: 'main', sha: 'h9' }] })],
    ['POST /api/v1/repos/r/paths/list', json(200, { ok: true, entries: [], page: {} })],
    ['POST /api/v1/repos/r/workspaces', json(200, { ok: true, workspaceId: 'w7' })],
    ['PUT /api/v1/workspaces/w7/files', json(200, { ok: true })],
  ]
  // commit WITHOUT a sha field → provider must re-read refs for the new head
  const s = scripted([...base, ['POST /api/v1/workspaces/w7/commit', json(200, { ok: true, status: 'committed' })]])
  const p = mk(s.fetchImpl)
  const clone = await p.ensureClone(dir, { url: 'treedx+http://svc/kb', token: 't' } as never)
  assert.ok(clone.ok, clone.detail)
  fs.writeFileSync(path.join(dir, 'new.md'), '# new\n')
  const stage = await p.stageAllAndCommit(dir, 'msg', { name: 't', email: 't@t' } as never)
  assert.ok(stage.ok, stage.detail)
  const push = await p.push(dir, { url: 'treedx+http://svc/kb', token: 't' } as never)
  assert.ok(push.ok, push.detail)
  const st = JSON.parse(fs.readFileSync(path.join(dir, '.treedx-state.json'), 'utf8')) as { head: string }
  assert.equal(st.head, 'h9', 'missing commit sha was recovered by re-reading refs')
  // no explicit close after a SUCCESSFUL commit: the commit itself releases the lease
  // (close is the failure path's duty — proven in treedx-provider-branches.test.ts)
})

test('a lease-conflicted commit re-fetches the head: moved ⇒ diverged, same ⇒ rejected', async () => {
  // refs is stateful: the clone sees h1; after the commit 409 the re-fetch
  // sees `movedTo` — 'abcdef...' exercises the DIVERGED arm, 'h1' the SAME⇒rejected arm
  const mkCase = async (movedTo: string) => {
    const dir = tmpDir()
    let refsCalls = 0
    const s = scripted([
      ['GET /api/v1/repos', json(200, { ok: true, repos: [{ name: 'kb', repoId: 'r' }] })],
      ['GET /api/v1/repos/r/refs', () => { refsCalls += 1; return json(200, { ok: true, refs: [{ name: 'main', target: refsCalls === 1 ? 'h1' : movedTo }] }) }],
      ['POST /api/v1/repos/r/paths/list', json(200, { ok: true, entries: [], page: {} })],
      ['POST /api/v1/repos/r/workspaces', json(200, { ok: true, workspaceId: 'w7' })],
      ['PUT /api/v1/workspaces/w7/files', json(200, { ok: true })],
      ['POST /api/v1/workspaces/w7/commit', json(409, { ok: false, error: { code: 'conflict', message: 'base moved' } })],
    ])
    const p = mk(s.fetchImpl)
    await p.ensureClone(dir, { url: 'treedx+http://svc/kb', token: 't' } as never)
    fs.writeFileSync(path.join(dir, 'x.md'), '# x\n')
    await p.stageAllAndCommit(dir, 'm', { name: 't', email: 't@t' } as never)
    return p.push(dir, { url: 'treedx+http://svc/kb', token: 't' } as never)
  }
  const diverged = await mkCase('abcdef0123456789')
  assert.equal(diverged.ok, false)
  assert.equal(diverged.code, 'diverged', `moved head ⇒ rebuild path: ${diverged.detail}`)
  const rejected = await mkCase('h1')
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'rejected', `unchanged head ⇒ pull-and-retry class: ${rejected.detail}`)
})

test('overlay delete failure is reported with the delete step (not swallowed)', async () => {
  const dir = tmpDir()
  const s = scripted([
    ['GET /api/v1/repos', json(200, { ok: true, repos: [{ name: 'kb', repoId: 'r' }] })],
    ['GET /api/v1/repos/r/refs', json(200, { ok: true, refs: [{ name: 'main', target: 'h1' }] })],
    ['POST /api/v1/repos/r/paths/list', json(200, { ok: true, entries: [{ path: 'gone.md', kind: 'blob' }], page: {} })],
    ['* /api/v1/repos/r/files/read', json(200, { ok: true, file: { content: 'to be deleted' } })],
    ['POST /api/v1/repos/r/workspaces', json(200, { ok: true, workspaceId: 'w7' })],
    ['PUT /api/v1/workspaces/w7/files', (b) => json(200, { ok: true })],
    ['DELETE /api/v1/workspaces/w7/files', json(500, { ok: false, error: { code: 'boom', message: 'delete refused' } })],
  ])
  const p = mk(s.fetchImpl)
  const clone = await p.ensureClone(dir, { url: 'treedx+http://svc/kb', token: 't' } as never)
  assert.ok(clone.ok, clone.detail)
  fs.rmSync(path.join(dir, 'gone.md'))
  await p.stageAllAndCommit(dir, 'deletion staged', { name: 't', email: 't@t' } as never)
  const r = await p.push(dir, { url: 'treedx+http://svc/kb', token: 't' } as never)
  assert.equal(r.ok, false)
  assert.match(r.detail, /overlay delete/, `delete fault surfaces: ${r.detail}`)
})
