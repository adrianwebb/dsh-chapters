/**
 * A stub TreeDX service for provider tests: a real in-process HTTP server
 * implementing the routes src/treedx/provider.ts speaks — SHAPED EXACTLY LIKE
 * THE LIVE SERVICE (every envelope and error code below was measured against
 * the dev-auth container on 2026-09-21; see spikes/treedx/FINDINGS.md
 * §"LIVE MEASURED"). Semantics the provider's correctness depends on:
 *
 * - bearer auth on every /api/v1 route except /health (401
 *   `authentication_required` empty / `invalid_token` wrong);
 * - `POST /repos` → `{ok, repo:{name, repoId, repositoryName, defaultRef,
 *   status:'registered'}}`; duplicate name ⇒ 409 `conflict`; a managed repo
 *   is BORN with `refs/heads/main` (a seeding commit holding `.treedxkeep`);
 * - one active writable lease per repository branch: the second create
 *   answers 409 `conflict` "writable lease already exists for <repoId>
 *   <branch>"; a lease SURVIVES its ttl until commit or close (measured —
 *   expiredAt passed and create still 409'd; POST /close released it);
 * - workspace create snapshots the current head as base; commit whose base is
 *   no longer the head fails closed (409); commit with no overlay changes
 *   answers 422 "no workspace changes to commit."; commit releases the lease;
 * - `blobs/write` requires `contentBase64` (missing ⇒ 422 exactly that); a
 *   non-UTF-8 path answers `files/read` with 415 `unsupported_media_type`
 *   and `blobs/read` with `{blob.contentBase64}`;
 * - `paths/list` → `{ok, ref, resolvedRef, repoId, entries:[{path, kind:
 *   'blob'|'tree', objectId, size, …}]}` — tree rows included;
 * - errors are the documented envelope `{ok:false,error:{code,message,details}}`;
 * - UTF-8 file writes above the configured limit ⇒ 413 `payload_too_large`.
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface StubTreeDx {
  base: string
  token: string
  /** Inspect committed state: repo name → (path → content, utf8-decoded). */
  treeOf(repoName: string): Map<string, string> | null
  headOf(repoName: string): string | null
  /** Advance the head from "another machine" (moved-base / divergence tests). */
  commitFromOutside(repoName: string, path: string, content: string): string
  /** Force-release every open lease. */
  releaseLeases(): void
  /** Toggle a fault: next request matching {method, pathRe} answers the given status/code once. */
  failNext(f: { method: string; pathRe: string; status: number; code: string }): void
  stop(): Promise<void>
}

interface WorkspaceState {
  id: string
  repo: RepoState
  branch: string
  baseCommit: string
  overlay: Map<string, string | null> // null = deleted; 'b64:…' = binary
  status: 'open' | 'committed' | 'closed'
}
interface RepoState {
  repoId: string
  name: string
  head: string
  commits: Map<string, Map<string, string>>
  lease: WorkspaceState | null
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const isBin = (v: string): boolean => v.startsWith('b64:')
const err = (res: http.ServerResponse, status: number, code: string, message: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: { code, message, details: {} } }))
}
const json = (res: http.ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startStubTreeDx(opts: { token?: string; utf8FileLimitBytes?: number } = {}): Promise<StubTreeDx> {
  const token = opts.token ?? 'treedx_dev_stub'
  const fileLimit = opts.utf8FileLimitBytes ?? 1024 * 1024
  const repos = new Map<string, RepoState>() // by name
  const workspaces = new Map<string, WorkspaceState>()
  const faults: Array<{ method: string; pathRe: RegExp; status: number; code: string }> = []
  let wsSeq = 0

  const repoByRef = (ref: string): RepoState | undefined =>
    [...repos.values()].find((r) => r.repoId === ref || r.name === ref)
  const repoBody = (r: RepoState): Record<string, unknown> => ({
    name: r.name, status: 'registered', repoId: r.repoId, remoteUrl: null,
    repositoryName: r.name, defaultRef: 'refs/heads/main', storageKind: 'managed',
  })
  const commitTree = (r: RepoState): Map<string, string> => r.commits.get(r.head) ?? new Map()
  const advance = (r: RepoState, tree: Map<string, string>): string => {
    const s = sha(JSON.stringify([...tree.entries()].sort()))
    r.commits.set(s, tree)
    r.head = s
    return s
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const path = url.pathname
    if (path === '/api/v1/health') return json(res, { ok: true, status: 'ok', service: 'treedx-api', dataDir: 'redacted' })

    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${token}`) {
      return err(res, 401, auth === '' ? 'authentication_required' : 'invalid_token', auth === '' ? 'Authentication required.' : 'No valid bearer token.')
    }
    const failIdx = faults.findIndex((f) => f.method === (req.method ?? 'GET') && f.pathRe.test(path))
    if (failIdx >= 0) {
      const f = faults.splice(failIdx, 1)[0]!
      return err(res, f.status, f.code, `injected fault ${f.code}`)
    }
    const body = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> } catch { return {} }
    }
    const m = (re: RegExp): RegExpMatchArray | null => re.exec(path)
    const seg = (s: string): string => decodeURIComponent(s)

    // ---------------------------------------------------------------- repos
    if (path === '/api/v1/repos' && req.method === 'POST') {
      return void body().then((b) => {
        const name = String(b.repositoryName ?? '')
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return err(res, 422, 'validation_error', 'repositoryName must be canonical lowercase.')
        if (repos.has(name)) return err(res, 409, 'conflict', `repository ${name} already exists`)
        // LIVE: a managed repo is BORN with refs/heads/main + .treedxkeep
        const r: RepoState = { repoId: `repo_${sha(name).slice(0, 16)}`, name, head: '', commits: new Map(), lease: null }
        advance(r, new Map([['.treedxkeep', 'treedx managed repository']]))
        repos.set(name, r)
        json(res, { ok: true, repo: repoBody(r), placement: { primaryNodeId: 'node_local' } })
      })
    }
    if (path === '/api/v1/repos' && req.method === 'GET') {
      return json(res, { ok: true, repos: [...repos.values()].map(repoBody) })
    }
    let mm = m(/^\/api\/v1\/repos\/([^/]+)$/)
    if (mm !== null && req.method === 'GET') {
      const r = repoByRef(seg(mm[1]!))
      if (r === undefined) return err(res, 404, 'not_found', 'Repository not found.')
      return json(res, repoBody(r))
    }
    mm = m(/^\/api\/v1\/repos\/([^/]+)\/refs$/)
    if (mm !== null && req.method === 'GET') {
      const r = repoByRef(seg(mm[1]!))
      if (r === undefined) return err(res, 404, 'not_found', 'Repository not found.')
      return json(res, { ok: true, repo: repoBody(r), refs: [{ kind: 'branch', name: 'refs/heads/main', target: r.head }] })
    }
    mm = m(/^\/api\/v1\/repos\/([^/]+)\/workspaces$/)
    if (mm !== null && req.method === 'POST') {
      return void body().then((b) => {
        const r = repoByRef(seg(mm![1]!))
        if (r === undefined) return err(res, 404, 'not_found', 'Repository not found.')
        const branch = String(b.branchName ?? 'refs/heads/main')
        if (r.lease !== null && r.lease.status === 'open') {
          return err(res, 409, 'conflict', `conflict: writable lease already exists for ${r.repoId} ${branch}`)
        }
        const ws: WorkspaceState = {
          id: `ws_${sha(String(++wsSeq)).slice(0, 22)}`, repo: r, branch,
          baseCommit: r.head, overlay: new Map(), status: 'open',
        }
        r.lease = ws
        workspaces.set(ws.id, ws)
        json(res, {
          ok: true, status: 'ready', mode: 'writable', repoId: r.repoId,
          workspaceId: ws.id, baseCommitSha: ws.baseCommit, nodeId: 'node_local',
          expiresAt: new Date(Date.now() + (Number(b.ttlSeconds ?? 900) * 1000)).toISOString(),
        })
      })
    }
    mm = m(/^\/api\/v1\/repos\/([^/]+)\/files\/read$/)
    if (mm !== null && req.method === 'POST') {
      return void body().then((b) => {
        const r = repoByRef(seg(mm![1]!))
        if (r === undefined) return err(res, 404, 'not_found', 'Repository not found.')
        const p = String(b.path ?? '')
        const content = commitTree(r).get(p)
        if (content === undefined) return err(res, 404, 'not_found', 'File not found.')
        if (isBin(content)) return err(res, 415, 'unsupported_media_type', 'File is not valid UTF-8.')
        json(res, { ok: true, file: { path: p, content, encoding: 'utf8', objectId: sha(content), size: Buffer.byteLength(content) } })
      })
    }
    mm = m(/^\/api\/v1\/repos\/([^/]+)\/blobs\/read$/)
    if (mm !== null && req.method === 'POST') {
      return void body().then((b) => {
        const r = repoByRef(seg(mm![1]!))
        if (r === undefined) return err(res, 404, 'not_found', 'Repository not found.')
        const content = commitTree(r).get(String(b.path ?? ''))
        if (content === undefined) return err(res, 404, 'not_found', 'Blob not found.')
        const b64 = isBin(content) ? content.slice(4) : Buffer.from(content, 'utf8').toString('base64')
        json(res, {
          ok: true, blob: {
            path: String(b.path ?? ''), encoding: 'base64', source: 'base',
            contentBase64: b64, byteLength: Buffer.from(b64, 'base64').length, objectId: sha(content),
          },
        })
      })
    }
    mm = m(/^\/api\/v1\/repos\/([^/]+)\/paths\/list$/)
    if (mm !== null && req.method === 'POST') {
      return void body().then((parsed) => {
        const r = repoByRef(seg(mm![1]!))
        if (r === undefined) return err(res, 404, 'not_found', 'Repository not found.')
        const tree = commitTree(r)
        const entries: Array<Record<string, unknown>> = []
        for (const [p, content] of [...tree.entries()].sort()) {
          const segs = p.split('/')
          for (let i = 1; i < segs.length; i += 1) {
            const dir = segs.slice(0, i).join('/')
            if (!entries.some((e) => e.path === dir)) {
              entries.push({ name: segs[i - 1], path: dir, kind: 'tree', mode: '40000', size: null, objectId: sha('tree:' + dir) })
            }
          }
          const bin = isBin(content)
          entries.push({
            name: segs[segs.length - 1], path: p, kind: 'blob', mode: '100644',
            size: bin ? Buffer.from(content.slice(4), 'base64').length : Buffer.byteLength(content),
            objectId: sha(content), extension: p.includes('.') ? `.${p.split('.').pop()}` : '',
          })
        }
        // PAGINATION exactly as the live service answers (measured 2026-09-23):
        // entries capped per page (default limit 100), page.nextCursor is a
        // base64 {"offset":N} while hasMore — the provider's corpusPaths loop
        // gets its cursor-following exercised HERE, not hoped at (uncapped
        // listings once made a twin's 101st file invisible: 'up to date', lie).
        const pageLimit = Number(parsed.limit ?? 100)
        let offset = 0
        try {
          const cur = String(parsed.cursor ?? '')
          if (cur !== '') offset = Number((JSON.parse(Buffer.from(cur, 'base64').toString('utf8')) as { offset?: number }).offset ?? 0)
        } catch { /* malformed cursor → page 0, matching live's tolerance */ }
        const slice = entries.slice(offset, offset + pageLimit)
        const next = offset + slice.length
        const hasMore = next < entries.length
        json(res, {
          ok: true, ref: 'refs/heads/main', resolvedRef: r.head, repoId: r.repoId, entries: slice,
          page: { limit: pageLimit, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ offset: next })).toString('base64') } : {}) },
        })
      })
    }
    // ---------------------------------------------------------------- workspaces
    mm = m(/^\/api\/v1\/workspaces\/([^/]+)$/)
    if (mm !== null && req.method === 'GET') {
      const ws = workspaces.get(seg(mm[1]!))
      if (ws === undefined) return err(res, 404, 'not_found', 'Workspace not found.')
      return json(res, { ok: true, status: ws.status, workspaceId: ws.id, repoId: ws.repo.repoId })
    }
    mm = m(/^\/api\/v1\/workspaces\/([^/]+)\/close$/)
    if (mm !== null && req.method === 'POST') {
      const ws = workspaces.get(seg(mm[1]!))
      if (ws === undefined) return err(res, 404, 'not_found', 'Workspace not found.')
      ws.status = 'closed'
      if (ws.repo.lease === ws) ws.repo.lease = null
      return json(res, { ok: true, status: 'closed', workspaceId: ws.id, repoId: ws.repo.repoId })
    }
    mm = m(/^\/api\/v1\/workspaces\/([^/]+)\/files$/)
    if (mm !== null && (req.method === 'PUT' || req.method === 'DELETE')) {
      return void (async () => {
        const ws = workspaces.get(seg(mm![1]!))
        if (ws === undefined || ws.status !== 'open') return err(res, 409, 'workspace_revoked', 'Workspace is not open.')
        const p = url.searchParams.get('path') ?? ''
        if (!/^[\w./-]+$/.test(p) || p.startsWith('/') || p.includes('..')) return err(res, 422, 'validation_error', 'Path must be repository-relative.')
        if (req.method === 'DELETE') { ws.overlay.set(p, null); return json(res, { ok: true }) }
        const b = await body()
        const content = String(b.content ?? '')
        if (Buffer.byteLength(content, 'utf8') > fileLimit) return err(res, 413, 'payload_too_large', `UTF-8 file limit is ${fileLimit} bytes.`)
        ws.overlay.set(p, content)
        json(res, { ok: true, file: { size: Buffer.byteLength(content), path: p, encoding: 'utf8', source: 'overlay', sha: 'blake3:' + sha(content) } })
      })()
    }
    mm = m(/^\/api\/v1\/workspaces\/([^/]+)\/blobs\/write$/)
    if (mm !== null && req.method === 'POST') {
      return void body().then((b) => {
        const ws = workspaces.get(seg(mm![1]!))
        if (ws === undefined || ws.status !== 'open') return err(res, 409, 'workspace_revoked', 'Workspace is not open.')
        const b64 = b.contentBase64
        if (typeof b64 !== 'string' || b64 === '') return err(res, 422, 'validation_error', 'contentBase64 is required.')
        const p = String(b.path ?? '')
        ws.overlay.set(p, `b64:${b64}`)
        json(res, {
          ok: true, result: {
            path: p, encoding: 'base64', op: 'put', workspaceId: ws.id,
            byteLength: Buffer.from(b64, 'base64').length, contentHash: 'blake3:' + sha(b64),
          },
        })
      })
    }
    mm = m(/^\/api\/v1\/workspaces\/([^/]+)\/commit$/)
    if (mm !== null && req.method === 'POST') {
      return void body().then((b) => {
        const ws = workspaces.get(seg(mm![1]!))
        if (ws === undefined || ws.status !== 'open') return err(res, 409, 'workspace_revoked', 'Workspace is not open.')
        if (ws.overlay.size === 0) {
          ws.status = 'committed'
          if (ws.repo.lease === ws) ws.repo.lease = null
          return err(res, 422, 'validation_error', 'no workspace changes to commit.')
        }
        if (ws.repo.head !== ws.baseCommit) {
          ws.status = 'committed'
          if (ws.repo.lease === ws) ws.repo.lease = null
          return err(res, 409, 'conflict', `base moved (fail closed): branch moved since ${String(ws.baseCommit).slice(0, 8)}`)
        }
        const next = new Map(commitTree(ws.repo))
        const changedPaths: string[] = []
        for (const [p, c] of ws.overlay) {
          if (c === null) next.delete(p)
          else next.set(p, c)
          changedPaths.push(p)
        }
        const newSha = advance(ws.repo, next)
        ws.status = 'committed'
        if (ws.repo.lease === ws) ws.repo.lease = null
        void b
        json(res, {
          ok: true, status: 'committed', repoId: ws.repo.repoId, workspaceId: ws.id,
          branchName: ws.branch, commitSha: newSha, changedPaths,
        })
      })
    }
    err(res, 404, 'not_found', `No stub route for ${req.method} ${path}`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    base,
    token,
    treeOf: (name) => {
      const r = repos.get(name)
      if (r === undefined) return null
      const out = new Map<string, string>()
      for (const [p, c] of commitTree(r)) out.set(p, isBin(c) ? Buffer.from(c.slice(4), 'base64').toString('latin1') : c)
      return out
    },
    headOf: (name) => repos.get(name)?.head ?? null,
    commitFromOutside: (name, p, content) => {
      const r = repos.get(name)!
      const next = new Map(commitTree(r))
      next.set(p, content)
      return advance(r, next)
    },
    releaseLeases: () => { for (const r of repos.values()) r.lease = null },
    failNext: (f) => { faults.push({ ...f, pathRe: new RegExp(f.pathRe) }) },
    stop: () => new Promise<void>((r) => {
      server.closeAllConnections?.()
      server.close(() => r())
    }),
  }
}
