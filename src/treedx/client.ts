/**
 * The TreeDX HTTP client (provider transport). Thin on purpose: one request
 * shape, bearer auth, bounded timeout, and the sync loop's `{ok, detail, code}`
 * error idiom (§5.3 — transport failures are VALUES, never exceptions).
 *
 * Every response shape consumed here is [doc]-pinned in
 * spikes/treedx/FINDINGS.md, contract-pinned by the stub server, and re-checked
 * live by tests/integration/treedx-live.test.ts. Do not add "convenience"
 * retries here — retry policy is the sync loop's (pull-and-retry, diverged-
 * rebuild) and belongs to the provider verbs.
 *
 * Credential hygiene (record §2.1): the token appears in exactly one place —
 * the request header. No detail/status string is ever built from a request or
 * response that could carry it (TreeDX error envelopes are {code,message,
 * details}; we surface code + message only).
 */

export interface FetchLike {
  (url: string, init: Record<string, unknown>): Promise<{
    status: number
    ok: boolean
    text(): Promise<string>
  }>
}

export interface TreeDxOk { ok: true; status: number; data: Record<string, unknown> }
export interface TreeDxFail {
  ok: false
  status: number
  /** TreeDX machine code when the envelope carried one (e.g. 'conflict',
   * 'authentication_required', 'not_found'); 'network' / 'timeout' / 'bad_json'
   * are ours. The provider branches on THESE, never on prose (r35 lesson). */
  code: string
  detail: string
}
export type TreeDxResult<T = Record<string, unknown>> =
  (TreeDxOk & { data: T }) | TreeDxFail

export interface TreeDxClientOpts {
  baseUrl: string
  token?: string
  /** fetch impl timeout */
  fetchTimeoutMs?: number
  fetchImpl?: FetchLike
}

export interface TreeDxClient {
  get(path: string): Promise<TreeDxResult>
  post(path: string, body?: unknown): Promise<TreeDxResult>
  put(path: string, body?: unknown): Promise<TreeDxResult>
  del(path: string): Promise<TreeDxResult>
}

/** Unwrap TreeDX's document envelopes: some routes nest under a named key.
 * The provider passes the candidate keys; first present object wins. */
export function pick(data: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const k of keys) {
    const v = data[k]
    if (v !== null && typeof v === 'object') return v as Record<string, unknown>
  }
  return undefined
}

export function createTreeDxClient(opts: TreeDxClientOpts): TreeDxClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const timeoutMs = opts.fetchTimeoutMs ?? 15000
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init as never).then((r) => ({
    status: r.status,
    ok: r.ok,
    text: () => r.text(),
  })) as never)

  const req = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<TreeDxResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (opts.token !== undefined && opts.token !== '') headers.authorization = `Bearer ${opts.token}`
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await res.text()
      let data: Record<string, unknown> = {}
      if (text !== '') {
        try {
          const parsed = JSON.parse(text)
          data = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : { value: parsed }
        } catch {
          if (res.ok) return { ok: false, status: res.status, code: 'bad_json', detail: `${method} ${path}: non-JSON response (${text.slice(0, 120)})` }
        }
      }
      if (res.ok) return { ok: true, status: res.status, data }
      const err = (data.error ?? {}) as Record<string, unknown>
      const code = String(err.code ?? `http_${res.status}`)
      const message = String(err.message ?? `${method} ${path} failed`)
      return { ok: false, status: res.status, code, detail: `${code} (${res.status}): ${message}`.slice(0, 300) }
    } catch (error) {
      const aborted = (error as { name?: string })?.name === 'AbortError'
      return { ok: false, status: 0, code: aborted ? 'timeout' : 'network', detail: `${method} ${path}: ${aborted ? `timed out after ${timeoutMs}ms` : String((error as Error)?.message ?? error)}`.slice(0, 300) }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    put: (p, b) => req('PUT', p, b ?? {}),
    del: (p) => req('DELETE', p),
  }
}
