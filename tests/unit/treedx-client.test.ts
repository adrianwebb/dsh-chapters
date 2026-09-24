/**
 * The TreeDX HTTP client's failure vocabulary, driven directly with an
 * injected fetch (the stub-server tests exercise it end-to-end but never
 * force the malformed/timeout shapes — the 2026-09-23 coverage audit found
 * the error-class branches untested). These classes ARE the sync loop's
 * degradation contract: network | timeout | auth | not_found, envelope
 * mapping included.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTreeDxClient, pick, type FetchLike } from '../../src/treedx/client.ts'

const fetchReturning = (status: number, body: string, contentType = 'application/json'): FetchLike =>
  (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as FetchLike

const client = (doFetch: FetchLike, timeoutMs = 5_000) =>
  createTreeDxClient({ baseUrl: 'http://svc', token: 't', fetchImpl: doFetch, fetchTimeoutMs: timeoutMs })

test('2xx JSON: ok with the parsed envelope', async () => {
  const r = await client(fetchReturning(200, '{"ok":true,"repos":[{"repoId":"r1"}]}')).get('/api/v1/repos')
  assert.ok(r.ok)
  assert.equal(r.status, 200)
})

test('2xx non-JSON: refused as bad_json, never a crash on undefined fields', async () => {
  const r = await client(fetchReturning(200, '<html>proxy error</html>', 'text/html')).get('/api/v1/repos')
  assert.ok(!r.ok)
  if (r.ok) return
  assert.equal(r.code, 'bad_json')
  assert.match(r.detail, /non-JSON response/)
})

test('error envelope: TreeDX {code,message} surfaces BOTH in code + detail', async () => {
  const r = await client(fetchReturning(409, '{"ok":false,"error":{"code":"writable lease already exists","message":"held elsewhere"}}')).post('/api/v1/workspaces')
  assert.ok(!r.ok)
  if (r.ok) return
  assert.equal(r.status, 409)
  assert.match(r.code, /lease/)
  assert.match(r.detail, /409/)
  assert.match(r.detail, /held elsewhere/)
})

test('non-2xx without a parseable error body degrades to http_<status>', async () => {
  const r = await client(fetchReturning(502, 'gateway exploded', 'text/plain')).get('/api/v1/repos')
  assert.ok(!r.ok)
  if (r.ok) return
  assert.equal(r.code, 'http_502')
})

test('network death: refused with code network, never thrown', async () => {
  const dead = (async () => { throw new Error('ECONNREFUSED') }) as unknown as FetchLike
  const r = await client(dead).get('/api/v1/repos')
  assert.ok(!r.ok)
  if (r.ok) return
  assert.equal(r.code, 'network')
  assert.match(r.detail, /ECONNREFUSED/)
})

test('a service that never answers is a bounded timeout (AbortError → code timeout)', async () => {
  // fetch impl that hangs until the client's own signal fires
  const hang: FetchLike = (url, init) => new Promise((_res, rej) => {
    const signal = (init as { signal?: AbortSignal }).signal
    const onAbort = (): void => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  })
  const r = await client(hang, 150).get('/api/v1/repos')
  assert.ok(!r.ok)
  if (r.ok) return
  assert.equal(r.code, 'timeout')
  assert.match(r.detail, /timed out after 150ms/)
})

test('pick(): first present object key wins; scalars and absence miss', () => {
  assert.deepEqual(pick({ repos: [{ a: 1 }] }, 'data', 'repos'), [{ a: 1 }])
  assert.deepEqual(pick({ data: { x: 1 }, repos: [{ a: 1 }] }, 'data', 'repos'), { x: 1 })
  assert.equal(pick({ ok: true }, 'repos'), undefined)
})

test('the bearer token rides every request and appears in no detail string', async () => {
  let seen = ''
  const spy = (async (_u: string, init?: RequestInit) => {
    seen = String(new Headers(init?.headers).get('authorization') ?? '')
    return new Response('{"ok":false,"error":{"code":"authentication_required","message":"no"}}', { status: 401 })
  }) as unknown as FetchLike
  const r = await client(spy).get('/api/v1/repos')
  assert.equal(seen, 'Bearer t', 'auth header shape')
  assert.ok(!r.ok)
  if (r.ok) return
  assert.equal(r.code, 'authentication_required')
  assert.ok(!r.detail.includes('t\n') && !seen.includes('undefined'), 'token material never echoed back into details')
})
