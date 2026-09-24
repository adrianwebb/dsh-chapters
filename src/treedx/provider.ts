/**
 * The TreeDX transport provider (src/provider.ts seam; design pinned in
 * spikes/treedx/FINDINGS.md). It implements the sync loop's six transport
 * verbs over TreeDX's no-clone HTTP API, mapping them so runSync's proven
 * control flow — publish → commit → pull → push, degraded to local-only on
 * any remote failure, rebuilt from the store on divergence — keeps working
 * UNCHANGED. The mirror directory is still materialized (§3.1: it is the
 * search/rules/index read surface in every mode); only what fills it changes.
 *
 * Verb mapping (the six, in runSync order):
 * - ensureClone        resolve the managed repo, fetch head + corpus into the
 *                      mirror, write the state file (origin, head, baseline).
 *                      Origin changed ⇒ 'origin-mismatch' (same code, same
 *                      rebuild behavior as git mode).
 * - stageAllAndCommit  LOCAL workdir-vs-baseline diff, recorded as `staged`
 *                      (mirrors git's local-commit step: no network here).
 * - pullFastForward    head compare vs state. Moved while we hold staged
 *                      work ⇒ 'diverged' (the rebuild path re-publishes from
 *                      the store and re-derives the index — safer than an
 *                      ff refetch could ever be: derived files must not go
 *                      stale against a corpus they predate). Moved with
 *                      nothing staged ⇒ plain refetch (ff).
 * - push               workspace-create (one writable lease per branch) →
 *                      overlay-write each staged path (UTF-8 file API; binary
 *                     -safe blob API) → commit. Lease contention ⇒ 'rejected'
 *                      (runSync's existing pull-and-retry, plus bounded
 *                      in-provider waits); moved-base commit ⇒ 'diverged'.
 * - initLocal          offline state file (publish/commit/index/search keep
 *                      working; push deferred — §5.3).
 * - removeMirror       inherited from the filesystem reality (mirror is
 *                      transport, the store is truth).
 *
 * Every failure is a VALUE ({ok:false, code}) — never a throw into the
 * conversation path, and never a prose-matched classification (r35).
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseKnowledgeRemote, type KnowledgeRemoteTarget } from '../repo.ts'
import type { GitOpResult, RemoteSpec, CommitAuthor } from '../gitops.ts'
import { registerProvider, type SyncProvider } from '../provider.ts'
import { createTreeDxClient, pick, type TreeDxClient, type FetchLike } from './client.ts'
import { contentHash, isUtf8Safe, readState, walkMirror, writeState, type TreedxState } from './state.ts'

export interface TreedxProviderConfig {
  fetchTimeoutMs: number
  workspaceTtlSeconds: number
  leaseRetries: number
  leaseRetryDelayMs: number
  /** Injectable (stub tests and any future transport instrumentation). */
  fetchImpl?: FetchLike
  /** Injectable sleep (tests run the retry path without wall-clock cost). */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULTS: TreedxProviderConfig = {
  fetchTimeoutMs: 15000,
  workspaceTtlSeconds: 900,
  leaseRetries: 3,
  leaseRetryDelayMs: 1000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
}

const REF = 'refs/heads/main'

const sleepOf = (cfg: TreedxProviderConfig): ((ms: number) => Promise<void>) =>
  cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

/**
 * The live-shaped repository catalog: GET /repos → {ok, repos:[…]} (older
 * docs called it `repositories`); rows carry `repoId` (live-measured) or a
 * bare `id`. One parser for the provider AND the /chapters-link command —
 * this exact shape drift is why the first live run broke.
 */
export function repoCatalog(data: Record<string, unknown>): Array<{ name: string; repoId: string }> {
  const rows = Array.isArray(data.repos) ? data.repos
    : Array.isArray(data.repositories) ? data.repositories : []
  return (rows as Record<string, unknown>[]).map((x) => ({
    name: String(x.repositoryName ?? x.name ?? ''),
    repoId: String(x.repoId ?? x.id ?? ''),
  })).filter((x) => x.repoId !== '')
}

/** Resolve a repository's catalog id by name ('' = not found). */
export async function resolveRepoId(client: TreeDxClient, name: string): Promise<string> {
  const list = await client.get('/api/v1/repos')
  if (!list.ok) return ''
  return repoCatalog(list.data).find((x) => x.name === name)?.repoId ?? ''
}

/** Resolve `treedx+…` RemoteSpec → target + client + repo id. */
interface Resolved {
  target: KnowledgeRemoteTarget
  client: TreeDxClient
  repoId: string
}

async function resolve(cfg: TreedxProviderConfig, remote: RemoteSpec, state: TreedxState | null): Promise<
  { ok: true; r: Resolved } | { ok: false; res: GitOpResult }
> {
  let target: KnowledgeRemoteTarget
  try {
    target = parseKnowledgeRemote(remote.url)
  } catch (error) {
    return { ok: false, res: { ok: false, detail: `bad treedx remote: ${String((error as Error)?.message ?? error)}` } }
  }
  if (target.treedx === undefined) {
    return { ok: false, res: { ok: false, detail: `remote ${remote.url} is not a treedx+ target` } }
  }
  const client = createTreeDxClient({
    baseUrl: target.treedx.baseUrl,
    ...(remote.token !== undefined ? { token: remote.token } : {}),
    fetchTimeoutMs: cfg.fetchTimeoutMs,
    ...(cfg.fetchImpl !== undefined ? { fetchImpl: cfg.fetchImpl } : {}),
  })
  // Repo id: prefer the state-cached id (stable across passes); otherwise
  // resolve by canonical name through the catalog.
  const list = await client.get('/api/v1/repos')
  if (!list.ok) {
    if (list.code === 'authentication_required' || list.code === 'invalid_token' || list.status === 401 || list.status === 403) {
      return { ok: false, res: { ok: false, code: 'auth', detail: `TreeDX auth rejected (${list.detail}) — re-link the token with /chapters-link` } }
    }
    return { ok: false, res: { ok: false, code: 'network', detail: `repos list: ${list.detail}` } }
  }
  const catalog = repoCatalog(list.data)
  const want = target.treedx.repoName
  const found = catalog.find((x) => x.name === want)
  const repoId = found !== undefined ? found.repoId : ''
  if (repoId === '' && state?.repoId === undefined) {
    return { ok: false, res: { ok: false, code: 'not_found', detail: `TreeDX has no repository '${want}' at ${target.treedx.baseUrl} (create it or re-link)` } }
  }
  return { ok: true, r: { target, client, repoId: repoId !== '' ? repoId : String(state?.repoId ?? '') } }
}

/**
 * Head sha of `refs/heads/main`. LIVE-MEASURED (spikes/treedx/FINDINGS.md):
 * refs entries carry `{kind:'branch', name, target}` — the sha key is
 * `target`; and a managed repository is BORN with `refs/heads/main` (a
 * seeding commit holding `.treedxkeep`), so `null` here only means an
 * unexpected listing failure shape, handled tolerantly. Repo routes address
 * by repoId (name 404s).
 */
async function headOf(client: TreeDxClient, repoId: string): Promise<{ ok: true; head: string | null } | { ok: false; res: GitOpResult }> {
  const refs = await client.get(`/api/v1/repos/${encodeURIComponent(repoId)}/refs`)
  if (!refs.ok) {
    if (refs.code === 'not_found') return { ok: true, head: null }
    return { ok: false, res: { ok: false, code: refs.code === 'auth' ? 'auth' : 'network', detail: `refs: ${refs.detail}` } }
  }
  const list = Array.isArray(refs.data.refs) ? refs.data.refs as Record<string, unknown>[] : []
  const main = list.find((x) => String(x.name ?? x.ref ?? '') === REF || String(x.name ?? x.ref ?? '') === 'main')
  const sha = main !== undefined ? String(main.target ?? main.objectId ?? main.sha ?? main.commitSha ?? '') : ''
  return { ok: true, head: sha === '' ? null : sha }
}

/**
 * Corpus paths at HEAD. LIVE-MEASURED shape: `{ok, ref, entries:[{path,
 * kind:'blob'|'tree', objectId}]}` — entries include tree rows, so filter to
 * blobs. NO extension filter: the mirror must be a faithful cache of
 * everything the pool holds. Dot-prefixed paths (the birth-seeded
 * `.treedxkeep`) are EXCLUDED on purpose: `walkMirror` never stages them, so
 * a baseline containing one would report a phantom deletion every pass and
 * try to delete the service's own bookkeeping file.
 */
async function corpusPaths(client: TreeDxClient, repoId: string): Promise<string[]> {
  // PAGINATION IS MANDATORY, not an optimization (live finding 2026-09-23):
  // paths/list answers {entries, page:{limit,hasMore,nextCursor}} capped at
  // 100 — reading one page silently truncated the corpus, and a machine whose
  // twin had pushed the 101st file pulled "up to date" while missing real
  // work. The provider must follow nextCursor until hasMore is false.
  const out: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 500; page += 1) {
    const res = await client.post(`/api/v1/repos/${encodeURIComponent(repoId)}/paths/list`, {
      ref: REF,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    if (!res.ok) return []
    const raw: unknown[] = Array.isArray(res.data.entries) ? res.data.entries as unknown[]
      : Array.isArray(res.data.paths) ? res.data.paths : []
    for (const e of raw) {
      const p = String(typeof e === 'string' ? e : (e as Record<string, unknown>).path ?? '')
      const kind = typeof e === 'string' ? 'blob' : String((e as Record<string, unknown>).kind ?? 'blob')
      if (p !== '' && kind === 'blob' && !p.split('/').some((seg) => seg.startsWith('.'))) out.push(p)
    }
    const pg = res.data.page as { hasMore?: boolean; nextCursor?: string } | undefined
    if (pg?.hasMore !== true || pg.nextCursor === undefined || pg.nextCursor === cursor) return out
    cursor = pg.nextCursor
  }
  return out
}

/**
 * Read one corpus file at HEAD. UTF-8 document read; base64 blob fallback.
 * LIVE-MEASURED: a binary path answers `files/read` with 415
 * `unsupported_media_type` — `blobs/read` (→ `blob.contentBase64`) is the
 * binary path back.
 */
async function readCorpusFile(client: TreeDxClient, repoId: string, p: string): Promise<Buffer | null> {
  const doc = await client.post(`/api/v1/repos/${encodeURIComponent(repoId)}/files/read`, { ref: REF, path: p, parseFrontmatter: false })
  if (doc.ok) {
    const d = pick(doc.data, 'document', 'file') ?? doc.data
    const content = d.content
    if (typeof content === 'string') {
      if (String(d.encoding ?? 'utf8') === 'base64') return Buffer.from(content, 'base64')
      return Buffer.from(content, 'utf8')
    }
    return null
  }
  if (doc.code === 'unsupported_media_type' || doc.status === 415) {
    const blob = await client.post(`/api/v1/repos/${encodeURIComponent(repoId)}/blobs/read`, { ref: REF, path: p })
    if (blob.ok) {
      const b = pick(blob.data, 'blob') ?? blob.data
      const b64 = String(b.contentBase64 ?? b.content ?? '')
      if (b64 !== '') return Buffer.from(b64, 'base64')
    }
  }
  return null
}

async function fetchCorpus(r: Resolved): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  for (const p of await corpusPaths(r.client, r.repoId)) {
    const bytes = await readCorpusFile(r.client, r.repoId, p)
    if (bytes !== null) out.set(p, bytes)
  }
  return out
}

/**
 * Create the provider (registered under kind 'treedx'). One instance per
 * plane (host/engine); the mirror's state file carries everything across
 * calls, so instances remain safe to share across cwds/projects.
 */
export function createTreedxProvider(cfgIn: Partial<TreedxProviderConfig> = {}): SyncProvider & {
  ensureClone: SyncProvider['ensureClone']
} {
  const cfg: TreedxProviderConfig = { ...DEFAULTS, ...cfgIn }
  const provider: SyncProvider = {
    kind: 'treedx',
    describe: (project) => {
      const s = readState(path.join(project.cwd, '.dsh-knowledge'))
      const id = s?.repoId ?? project.repoId ?? ''
      return `treedx · ${id !== '' ? `${id} · ` : ''}${s === null ? 'not cloned yet' : s.offline ? 'offline (push deferred)' : `head ${String(s.head ?? '—').slice(0, 10)}`}`
    },

    async ensureClone(dir, remote): Promise<GitOpResult> {
      const state = readState(dir)
      if (state !== null) {
        if (state.origin !== remote.url) {
          return { ok: false, code: 'origin-mismatch', detail: `mirror origin is ${state.origin}, the project's remote is ${remote.url}` }
        }
        return { ok: true, detail: 'already synced (state present)' }
      }
      const res = await resolve(cfg, remote, null)
      if (!res.ok) return res.res
      const r = res.r
      const head = await headOf(r.client, r.repoId)
      if (!head.ok) return head.res
      // Materialize the corpus into the mirror (the same read surface git mode
      // gives: real files the search/rules/index layers — and the read tool's
      // sibling mirror paths — consume unchanged). A dirty non-empty dir with
      // no state file is dead transport (gitops parity): moving it aside
      // prevents its files being re-pushed as "new" content into a fresh pool.
      const corpus = await fetchCorpus(r)
      if (fs.existsSync(dir)) {
        const strays = fs.readdirSync(dir)
        if (strays.length > 0) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          fs.renameSync(dir, `${dir}.stale-${stamp}`)
        }
      }
      fs.mkdirSync(dir, { recursive: true })
      const baseline: Record<string, string> = {}
      for (const [p, bytes] of corpus) {
        const abs = path.join(dir, p)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, bytes)
        baseline[p] = contentHash(bytes)
      }
      writeState(dir, { origin: remote.url, head: head.head, baseline, staged: null, offline: false, repoId: r.repoId })
      return { ok: true, detail: `cloned from TreeDX (${corpus.size} file(s)${head.head === null ? ', empty repo' : ''})`, changed: true }
    },

    async initLocal(dir, remote): Promise<GitOpResult> {
      if (readState(dir) !== null) return { ok: true, detail: 'already synced (state present)' }
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        fs.renameSync(dir, `${dir}.stale-${stamp}`)
      }
      fs.mkdirSync(dir, { recursive: true })
      writeState(dir, {
        origin: remote?.url ?? '', head: null, baseline: {}, staged: null, offline: true,
      })
      return { ok: true, detail: 'TreeDX offline mirror initialized', changed: true }
    },

    async removeMirror(dir): Promise<GitOpResult> {
      fs.rmSync(dir, { recursive: true, force: true })
      return { ok: true, detail: 'mirror removed for rebuild' }
    },

    async stageAllAndCommit(dir, message, author): Promise<GitOpResult> {
      const state = readState(dir)
      if (state === null) return { ok: false, detail: 'no TreeDX state — ensureClone/initLocal first' }
      const present = new Set(walkMirror(dir))
      const changed: string[] = []
      for (const p of present) {
        const bytes = fs.readFileSync(path.join(dir, p))
        if (state.baseline[p] !== contentHash(bytes)) changed.push(p)
      }
      const dropped = Object.keys(state.baseline).filter((p) => !present.has(p))
      if (changed.length === 0 && dropped.length === 0) return { ok: true, detail: 'nothing to commit' }
      // git-mode parity: a second stage of identical bytes is 'nothing to
      // commit'. The baseline advances at STAGE time (push success recomputes
      // it wholesale anyway; divergence replaces it), so the staged set is
      // exactly the workdir-vs-last-known delta.
      const baseline = { ...state.baseline }
      for (const p of changed) baseline[p] = contentHash(fs.readFileSync(path.join(dir, p)))
      for (const p of dropped) delete baseline[p]
      writeState(dir, { ...state, baseline, staged: { message, author, paths: [...changed, ...dropped].sort() } })
      return { ok: true, detail: `staged ${changed.length} path(s)${dropped.length > 0 ? `, ${dropped.length} removal(s)` : ''}`, changed: true }
    },

    async pullFastForward(dir, remote): Promise<GitOpResult> {
      const state = readState(dir)
      if (state === null) return { ok: false, detail: 'no TreeDX state' }
      if (state.offline) {
        // Recovery probe: still down ⇒ degrade again (§5.3). Reachable ⇒ the
        // offline mirror's commits cannot rebase onto the service's history
        // (ours live only in the store, which is the truth), so classify as
        // diverged and let runSync's rebuild republish from the store —
        // exactly the git mode's diverged-offline recovery.
        const probe = await resolve(cfg, remote, state)
        if (!probe.ok) return probe.res
        const head = await headOf(probe.r.client, probe.r.repoId)
        if (!head.ok) return head.res
        return { ok: false, code: 'diverged', detail: 'offline mirror, TreeDX reachable again — rebuilding mirror from remote' }
      }
      const res = await resolve(cfg, remote, state)
      if (!res.ok) return res.res
      const r = res.r
      const head = await headOf(r.client, r.repoId)
      if (!head.ok) return head.res
      if (head.head === state.head && state.staged === null) return { ok: true, detail: 'up to date (nothing to fast-forward)' }
      if (head.head === state.head) return { ok: true, detail: 'up to date (local work staged; push will ship it)' }
      // Remote moved since our base. With staged work in hand, a refetch-merge
      // could leave derived files (index/, topics/) built against a stale
      // corpus — divergence REBUILDS from the store (runSync's path), and the
      // rebuild re-publishes + re-derives. Without staged work, a plain ff
      // refetch is all there is.
      if (state.staged !== null) {
        return { ok: false, code: 'diverged', detail: `TreeDX head moved (${String(state.head).slice(0, 10)} → ${String(head.head).slice(0, 10)}) with local work staged — rebuild will recover` }
      }
      const corpus = await fetchCorpus(r)
      const baseline: Record<string, string> = {}
      for (const [p, bytes] of corpus) {
        const abs = path.join(dir, p)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, bytes)
        baseline[p] = contentHash(bytes)
      }
      writeState(dir, { ...state, head: head.head, baseline })
      return { ok: true, detail: `fast-forwarded (TreeDX ${String(head.head).slice(0, 10)}, ${corpus.size} file(s))`, changed: true }
    },

    async push(dir, remote): Promise<GitOpResult> {
      const state = readState(dir)
      if (state === null) return { ok: false, detail: 'no TreeDX state' }
      if (state.staged === null || state.staged.paths.length === 0) return { ok: true, detail: 'pushed (nothing new)' }
      const res = await resolve(cfg, remote, state)
      if (!res.ok) return res.res
      const r = res.r
      let attempt = 0
      for (;;) {
        const outcome = await onePush(r, dir, state, cfg)
        if (outcome.retryLease === true && attempt < cfg.leaseRetries) {
          attempt += 1
          await sleepOf(cfg)(cfg.leaseRetryDelayMs * attempt)
          continue
        }
        return outcome.res
      }
    },
  }
  return provider
}

/** One push round: workspace → writes → commit. */
async function onePush(r: Resolved, dir: string, state: TreedxState, cfg: TreedxProviderConfig): Promise<{ res: GitOpResult; retryLease?: boolean }> {
  const staged = state.staged
  if (staged === null || staged.paths.length === 0) return { res: { ok: true, detail: 'pushed (nothing new)' } }
  // An empty repo has no head to base on (live-gated assumption, FINDINGS):
  // send baseRef only when one exists.
  const createBody: Record<string, unknown> = { branchName: REF, mode: 'writable', ttlSeconds: cfg.workspaceTtlSeconds }
  if (state.head !== null) createBody.baseRef = REF
  const wsRes = await r.client.post(`/api/v1/repos/${encodeURIComponent(r.repoId)}/workspaces`, createBody)
  if (!wsRes.ok) {
    if (wsRes.status === 409) return { res: { ok: false, code: 'rejected', detail: `workspace lease busy: ${wsRes.detail}` }, retryLease: true }
    if (wsRes.code === 'auth') return { res: { ok: false, code: 'auth', detail: wsRes.detail } }
    return { res: { ok: false, code: 'network', detail: `workspace create: ${wsRes.detail}` } }
  }
  const wsData = pick(wsRes.data, 'workspace') ?? wsRes.data
  const wsId = String(wsData.workspaceId ?? wsData.id ?? '')
  if (wsId === '') return { res: { ok: false, detail: 'workspace create returned no id' } }
  // LIVE-MEASURED: a committed workspace releases its lease, but a half-failed
  // one holds it — and the lease survives its TTL until closed (measured:
  // expiresAt passed, create still 409'd, /close released it). Every failure
  // path after create must close, or a broken push poisons the pool's branch
  // for every machine until an operator intervenes.
  const fail = async (res: GitOpResult, retryLease?: boolean): Promise<{ res: GitOpResult; retryLease?: boolean }> => {
    await r.client.post(`/api/v1/workspaces/${encodeURIComponent(wsId)}/close`, {}).catch(() => undefined)
    return { res, ...(retryLease === true ? { retryLease } : {}) }
  }
  let wrote = 0
  for (const p of staged.paths) {
    const abs = path.join(dir, p)
    if (!fs.existsSync(abs)) {
      const del = await r.client.del(`/api/v1/workspaces/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(p)}`)
      if (!del.ok && del.status !== 404) return await fail({ ok: false, detail: `overlay delete ${p}: ${del.detail}` })
      wrote += 1
      continue
    }
    const bytes = fs.readFileSync(abs)
    if (isUtf8Safe(bytes)) {
      const w = await r.client.put(`/api/v1/workspaces/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(p)}`, { encoding: 'utf8', content: bytes.toString('utf8') })
      if (!w.ok) {
        if (w.status === 413) return await fail({ ok: false, detail: `file ${p} exceeds TreeDX's UTF-8 file limit: ${w.detail}` })
        return await fail({ ok: false, detail: `overlay write ${p}: ${w.detail}` })
      }
    } else {
      // live-measured body: `contentBase64` (a `{encoding,content}` body is a 422)
      const b = await r.client.post(`/api/v1/workspaces/${encodeURIComponent(wsId)}/blobs/write`, { path: p, contentBase64: bytes.toString('base64') })
      if (!b.ok) {
        if (b.status === 413) return await fail({ ok: false, detail: `blob ${p} exceeds TreeDX's blob limit: ${b.detail}` })
        return await fail({ ok: false, detail: `blob write ${p}: ${b.detail}` })
      }
    }
    wrote += 1
  }
  const commit = await r.client.post(`/api/v1/workspaces/${encodeURIComponent(wsId)}/commit`, {
    message: staged.message,
    author: staged.author,
  })
  if (!commit.ok) {
    // A 409 here is TreeDX failing closed on a moved ref / revoked lease.
    // Classify by STATUS and CODE only — never by message prose (r35): the
    // head moved underneath us ⇒ diverged-rebuild; lease ⇒ rejected-retry.
    if (commit.status === 409) {
      const head = await headOf(r.client, r.repoId)
      if (head.ok && head.head !== state.head) {
        return await fail({ ok: false, code: 'diverged', detail: `commit refused; TreeDX head moved (${String(state.head).slice(0, 10)} → ${String(head.head).slice(0, 10)}) — rebuild will recover` })
      }
      return await fail({ ok: false, code: 'rejected', detail: `commit conflict: ${commit.detail}` }, true)
    }
    return await fail({ ok: false, code: commit.code === 'auth' ? 'auth' : 'network', detail: `commit: ${commit.detail}` })
  }
  const cData = pick(commit.data, 'commit') ?? commit.data
  let newHead: string | null = (() => {
    const s = cData.commitSha ?? cData.sha
    return typeof s === 'string' && s !== '' ? s : null
  })()
  if (newHead === null) {
    const after = await headOf(r.client, r.repoId)
    if (after.ok) newHead = after.head
  }
  const baseline = { ...state.baseline }
  for (const p of staged.paths) {
    const abs = path.join(dir, p)
    if (fs.existsSync(abs)) baseline[p] = contentHash(fs.readFileSync(abs))
    else delete baseline[p]
  }
  writeState(dir, {
    ...state, head: newHead ?? state.head, baseline, staged: null, offline: false,
  })
  return { res: { ok: true, detail: `pushed ${wrote} path(s) to TreeDX`, changed: true } }
}

/** The default instance registered at module load with production defaults;
 * both planes re-register with user config at boot (src/index.ts, engine). */
const defaultProvider = createTreedxProvider()
registerProvider(defaultProvider)
export { defaultProvider as treedxProvider }
