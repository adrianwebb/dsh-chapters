/**
 * Git operations over isomorphic-git (knowledge-repo.md §3.2): pure-JS, no
 * git binary, no native deps. Every operation takes explicit dir/remote —
 * no global state — and every failure comes back as `{ok, detail}` because
 * the sync layer is best-effort by rule: a remote failure must never break
 * the conversation path (record §5.3).
 *
 * Fast-forward ONLY (§3.3): append-only content means divergence is separate
 * files and ff always succeeds; a non-ff state is an error, never a force.
 * The local repo is the mirror (transport, not storage, §3.1) — the
 * workspace store stays the read path's source of truth.
 *
 * API notes (isomorphic-git 1.42, verified against the installed types):
 * `http` is a client object with a `request` fn (node default from
 * `isomorphic-git/http/node`); the remote `url` is a SEPARATE argument;
 * auth rides `onAuth`; statusMatrix rows are
 * `[filepath, head, workdir, stage]` of numeric literals.
 */
import * as git from 'isomorphic-git'
import { randomUUID } from 'node:crypto'
import nodeHttp from 'isomorphic-git/http/node'
import * as fs from 'node:fs'
import * as nodefs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface RemoteSpec {
  url: string
  /** Scoped per-harness token (record §2.1); absent for file:// remotes. */
  token?: string
}

export interface GitOpResult {
  ok: boolean
  detail: string
  changed?: boolean
  /** Machine-readable failure class (r35 lesson: the caller must NOT regex
   * prose — the network failure's wording once contained 'diverge'). */
  code?: 'diverged' | 'network' | 'rejected' | 'origin-mismatch' | 'auth' | 'not_found'
}

export interface CommitAuthor {
  name: string
  email: string
}

const authOf = (r: RemoteSpec) =>
  r.token !== undefined ? () => ({ username: 'dsh-chapters', password: r.token! }) : undefined

const headOf = (dir: string): string => path.join(dir, '.git', 'HEAD')

const isRepo = async (dir: string): Promise<boolean> => {
  try {
    await nodefs.access(headOf(dir))
    return true
  } catch {
    return false
  }
}

/**
 * Ensure a clone exists at `dir` for `remote`. A non-repo dir is cloned
 * (single branch, main); an existing repo is left alone — pull/ff is the
 * caller's step. A non-empty non-repo dir is dead transport: moved aside
 * (`<dir>.stale-<ts>`, contents preserved) and cloned fresh. The r39-era e2e
 * failure class was exactly this residue making every later clone refuse;
 * renaming aside is strictly weaker than what the diverged-rebuild path
 * already does (removeMirror rm -rf) — the mirror is transport, the store
 * is truth (§3.1).
 */
export async function ensureClone(dir: string, remote: RemoteSpec, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  try {
    if (await isRepo(dir)) {
      const remotes = await git.listRemotes({ fs, dir }).catch(() => [] as { remote: string; url: string }[])
      const origin = remotes.find((r) => r.remote === 'origin')
      if (origin !== undefined && origin.url !== remote.url) {
        return { ok: false, code: 'origin-mismatch', detail: `mirror origin is ${origin.url}, the project's remote is ${remote.url}` }
      }
      if (origin === undefined && remote.url !== '') await git.addRemote({ fs, dir, remote: 'origin', url: remote.url, force: true }).catch(() => undefined)
      return { ok: true, detail: 'already a repo' }
    }
    const entries = await nodefs.readdir(dir).catch(() => [] as string[])
    let movedAside = ''
    if (entries.length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      movedAside = `${path.basename(dir)}.stale-${stamp}`
      await nodefs.rename(dir, `${dir}.stale-${stamp}`)
      await nodefs.mkdir(path.dirname(dir), { recursive: true })
    }
    await git.clone({ fs, http: nodeHttp, dir, url: remote.url, singleBranch: true, onAuth: authOf(remote) })
    // Cloning an EMPTY remote leaves the clone on isomorphic-git's fallback
    // branch ('master') — real finding from the first real-HTTP sync test.
    // Align HEAD to the expected branch while it is still unborn (no commit
    // to move); a born branch stays untouched.
    const branch = opts.defaultBranch ?? 'main'
    const current = await git.currentBranch({ fs, dir, fullname: false })
    if (current !== branch && (await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null)) === null) {
      await nodefs.writeFile(headOf(dir), `ref: refs/heads/${branch}\n`)
    }
    return { ok: true, detail: 'cloned', changed: true }
  } catch (error) {
    return { ok: false, code: 'network', detail: `clone: ${String((error as Error)?.message ?? error)}` }
  }
}

/**
 * Commit every workdir file whose content differs from HEAD. Does not trust
 * `statusMatrix` — on isomorphic-git 1.42 it reports stale index state right
 * after a commit (verified: a clean repo still reports [1,1,1]); the
 * workdir-vs-HEAD content comparison is the honest diff. Untracked dotfiles
 * and .git are out of scope (the mirror holds knowledge files only).
 */
export async function stageAllAndCommit(dir: string, message: string, author: CommitAuthor): Promise<GitOpResult> {
  try {
    const headFiles = await git.listFiles({ fs, dir, ref: 'HEAD' }).catch(() => [] as string[])
    const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null)
    const head = new Map<string, string | null>()
    for (const f of headFiles) {
      // HEAD's OWN content — reading the workdir here (as an earlier cut did)
      // compares the disk against itself, so modifications to TRACKED files
      // are permanently invisible to the commit: P2 enrichment writes would
      // never travel. Measured by the two-machine enrichment test (r37).
      let text: string | null = null
      if (headOid !== null) {
        const r = await git.readBlob({ fs, dir, oid: headOid, filepath: f }).catch(() => null)
        if (r !== null) text = Buffer.from(r.blob).toString('utf8')
      }
      head.set(f, text)
    }
    const changed: string[] = []
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (e.name === '.git' || e.name.startsWith('.')) continue
        const relPath = rel === '' ? e.name : path.join(rel, e.name)
        if (e.isDirectory()) walk(relPath)
        else {
          const content = fs.readFileSync(path.join(dir, relPath), 'utf8')
          const prev = head.get(relPath) ?? null
          if (prev === null || prev !== content) changed.push(relPath)
        }
      }
    }
    walk('')
    if (changed.length === 0) return { ok: true, detail: 'nothing to commit' }
    for (const f of changed) {
      await git.add({ fs, dir, filepath: f })
    }
    await git.commit({ fs, dir, message, author, committer: author })
    return { ok: true, detail: `committed ${changed.length} path(s)`, changed: true }
  } catch (error) {
    return { ok: false, detail: `commit: ${String((error as Error)?.message ?? error)}` }
  }
}

/** The branch HEAD points at (falls back to the expected default). */
async function branchOf(dir: string, fallback: string): Promise<string> {
  return (await git.currentBranch({ fs, dir, fullname: false })) || fallback
}

/** Fetch the remote and fast-forward the local branch. ff-only, always. */
export async function pullFastForward(dir: string, remote: RemoteSpec, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  const branch = await branchOf(dir, opts.defaultBranch ?? 'main')
  const ref = `refs/heads/${branch}`
  try {
    await git.fetch({ fs, http: nodeHttp, dir, url: remote.url, singleBranch: true, onAuth: authOf(remote) })
    const remoteRef = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null)
    const localRef = await git.resolveRef({ fs, dir, ref }).catch(() => null)
    if (remoteRef === null || localRef === null || remoteRef === localRef) {
      return { ok: true, detail: 'up to date (nothing to fast-forward)' }
    }
    // ff-only guard, all three cases (the direction here was inverted once —
    // isDescendent({oid, ancestor}) asks whether OID's history CONTAINS
    // ancestor): remote ahead ⇒ fast-forward; local ahead ⇒ nothing to do
    // (push will ship it); neither contains the other ⇒ genuine divergence.
    const remoteAhead = await git.isDescendent({ fs, dir, oid: remoteRef, ancestor: localRef })
    if (!remoteAhead) {
      const localAhead = await git.isDescendent({ fs, dir, oid: localRef, ancestor: remoteRef })
      if (localAhead) return { ok: true, detail: 'nothing to fast-forward (local ahead; push will ship it)' }
      return { ok: false, code: 'diverged', detail: 'diverged — fast-forward impossible (the mirror diverged from the remote; rebuild will recover)' }
    }
    await git.fastForward({ fs, http: nodeHttp, dir, url: remote.url, ref, onAuth: authOf(remote) })
    return { ok: true, detail: 'fast-forwarded', changed: true }
  } catch (error) {
    return { ok: false, code: 'network', detail: `pull failed: ${String((error as Error)?.message ?? error)}` }
  }
}


// ------------------------------------------------------------- local-path upstreams
// A local-path upstream ('/srv/git/kb.git', '~/pools/kb.git', './kb.git') is a
// bare directory the user owns — no HTTP, no git binary, no credentials
// needed (record §2.1's loopback-of-the-filesystem). Transfer is isomorphic-
// git's OWN pack layer: packObjects (full closure of a commit set) into a
// temp file, indexPack into the target. ff-only rules identical to the HTTP
// path: push checks the remote head is an ancestor of ours before moving it.

export const isLocalUpstreamUrl = (url: string): boolean =>
  /^(?:file:\/\/\/|[/~]|\.\.{0,1}\/|[a-zA-Z]:\\)/.test(url) && !/^https?:\/\//.test(url)

/** file:///a/b -> /a/b ; ~ -> homedir ; relative resolved against `cwd`. */
export function resolveLocalUpstreamPath(url: string, cwd: string): string {
  let p = url.startsWith('file:///') ? decodeURIComponent(url.slice('file://'.length)) : url
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1))
  if (!path.isAbsolute(p)) p = path.join(cwd, p)
  return path.normalize(p)
}

/** The gitdir of a repo that may be bare (gitdir = the dir itself) or a
 * working tree (gitdir = dir/.git); null when neither. */
function gitdirOf(repoDir: string): string | null {
  if (fs.existsSync(path.join(repoDir, 'HEAD')) && fs.existsSync(path.join(repoDir, 'objects'))) return repoDir
  if (fs.existsSync(path.join(repoDir, '.git', 'HEAD'))) return path.join(repoDir, '.git')
  return null
}

/** All objects reachable from the given commits (commit chain + trees +
 * blobs). packObjects packs EXACTLY what it is given — the closure is ours
 * to compute (measured the hard way: 'Could not find <oid>' on checkout). */
async function closureOids(fromDir: string, fromGit: string, commits: string[]): Promise<string[]> {
  const oids = new Set<string>()
  for (const c of commits) {
    const history = await git.log({ fs, dir: fromDir, gitdir: fromGit, ref: c })
    for (const entry of history) oids.add(entry.oid)
  }
  for (const co of [...oids]) {
    const { object: commit } = (await git.readObject({ fs, dir: fromDir, gitdir: fromGit, oid: co })) as unknown as { object: { tree: string } }
    const stack = [commit.tree]
    while (stack.length > 0) {
      const t = stack.pop()!
      if (oids.has(t)) continue
      oids.add(t)
      // measured in this isomorphic build: a tree readObject's `object` IS
      // the entries array (keys '0','1',…), not an { entries } wrapper.
      const { object: treeEntries } = (await git.readObject({ fs, dir: fromDir, gitdir: fromGit, oid: t })) as unknown as { object: Array<{ type: string; oid: string }> }
      for (const e of treeEntries) {
        if (e.type === 'tree') stack.push(e.oid)
        else oids.add(e.oid)
      }
    }
  }
  return [...oids]
}

async function transferCommits(fromDir: string, toDir: string, commits: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const fromGit = gitdirOf(fromDir)
    const toGit = gitdirOf(toDir)
    if (fromGit === null) return { ok: false, detail: `transfer source ${fromDir} is not a git repo` }
    if (toGit === null) return { ok: false, detail: `transfer target ${toDir} is not a git repo` }
    const oids = await closureOids(fromDir, fromGit, commits)
    const packed = await git.packObjects({ fs, dir: fromDir, gitdir: fromGit, oids, write: false })
    if (packed.packfile === undefined) return { ok: false, detail: 'packObjects returned no packfile' }
    // indexPack resolves filepath RELATIVE TO dir and expects the pack where
    // pushes put packs: inside the object store. So the incoming pack is
    // written to <gitdir>/objects/pack/ first — where it then legitimately
    // lives (this is literally how a git receive-pack lands objects).
    const inTree = toGit !== toDir
    const relPack = path.posix.join(...(inTree ? ['.git', 'objects', 'pack'] : ['objects', 'pack']), `dsh-xfer-${randomUUID().slice(0, 8)}.pack`)
    const absPack = path.join(toDir, ...(inTree ? ['.git', 'objects', 'pack'] : ['objects', 'pack']))
    await nodefs.mkdir(absPack, { recursive: true })
    const packFile = path.join(absPack, path.posix.basename(relPack))
    await nodefs.writeFile(packFile, packed.packfile)
    await git.indexPack({ fs, dir: toDir, gitdir: toGit, filepath: relPack })
    return { ok: true, detail: `transferred ${commits.length} commit(s), ${oids.length} objects` }
  } catch (error) {
    return { ok: false, detail: `transfer: ${String((error as Error)?.message ?? error)}` }
  }
}

async function localHeadOf(repoDir: string, branch: string): Promise<string | null> {
  const g = gitdirOf(repoDir)
  if (g === null) return null
  return await git.resolveRef({ fs, dir: repoDir, gitdir: g, ref: `refs/heads/${branch}` }).catch(() => null)
}

/** Materialize the mirror's workdir from its committed state (the local
 * transport moves refs and transfers objects; HTTP clones materialize — keep
 * the two transports behaving identically for the copy-out/search layers). */
async function checkoutMirror(mirrorDir: string, branch: string): Promise<void> {
  // NOT caught: a mirror that failed to materialize must fail the pass
  // loudly (the silent swallow here hid the closure bug for one whole round).
  await git.checkout({ fs, dir: mirrorDir, ref: branch, force: true })
}

/** Create the upstream (bare, empty) when it does not exist — 'link a path'
 * materializes the pool dir; never clobbers an existing repo. */
async function ensureUpstreamDir(upstream: string, branch: string): Promise<GitOpResult> {
  if (gitdirOf(upstream) !== null) return { ok: true, detail: 'upstream exists' }
  if (fs.existsSync(upstream) && fs.readdirSync(upstream).length > 0) {
    return { ok: false, detail: `upstream path ${upstream} exists but is not a git repo` }
  }
  try {
    await nodefs.mkdir(upstream, { recursive: true })
    await git.init({ fs, dir: upstream, gitdir: upstream, bare: true, defaultBranch: branch })
    return { ok: true, detail: 'upstream created (bare)', changed: true }
  } catch (error) {
    return { ok: false, detail: `upstream init: ${String((error as Error)?.message ?? error)}` }
  }
}

/** local-upstream ops take a url that is a resolved absolute path (sync.ts
 * resolves before calling; the driver dispatches on the shape). */
export async function ensureCloneLocal(mirrorDir: string, upstreamPath: string, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  const branch = opts.defaultBranch ?? 'main'
  try {
    const up = await ensureUpstreamDir(upstreamPath, branch)
    if (!up.ok) return up
    if (await isRepo(mirrorDir)) return { ok: true, detail: 'already a repo' }
    const entries = await nodefs.readdir(mirrorDir).catch(() => [] as string[])
    if (entries.length > 0) return { ok: false, detail: `clone target ${mirrorDir} exists and is not empty and not a git repo` }
    await nodefs.mkdir(mirrorDir, { recursive: true })
    await git.init({ fs, dir: mirrorDir, defaultBranch: branch })
    const t = await localHeadOf(upstreamPath, branch)
    if (t !== null) {
      const tr = await transferCommits(upstreamPath, mirrorDir, [t])
      if (!tr.ok) return tr
      const g = gitdirOf(mirrorDir) ?? path.join(mirrorDir, '.git')
      await git.writeRef({ fs, dir: mirrorDir, gitdir: g, ref: `refs/heads/${branch}`, value: t, force: true })
      await git.writeRef({ fs, dir: mirrorDir, gitdir: g, ref: `refs/remotes/origin/${branch}`, value: t, force: true })
      await checkoutMirror(mirrorDir, branch)
      return { ok: true, detail: 'cloned (local upstream)', changed: true }
    }
    return { ok: true, detail: `mirror initialized against ${up.ok === true ? 'new empty' : 'empty'} local upstream`, changed: true }
  } catch (error) {
    return { ok: false, code: 'network', detail: `clone(local): ${String((error as Error)?.message ?? error)}` }
  }
}

export async function pullLocal(mirrorDir: string, upstreamPath: string, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  const branch = opts.defaultBranch ?? 'main'
  try {
    const t = await localHeadOf(upstreamPath, branch)
    if (t === null) return { ok: true, detail: 'up-to-date (upstream has no branch yet)' }
    const s = await localHeadOf(mirrorDir, branch)
    const g = gitdirOf(mirrorDir)
    if (g === null) return { ok: false, detail: 'mirror is not a git repo' }
    if (s === t) return { ok: true, detail: 'up to date (nothing to fast-forward)' }
    const tr = await transferCommits(upstreamPath, mirrorDir, [t])
    if (!tr.ok) return tr
    if (s !== null) {
      const remoteAhead = await git.isDescendent({ fs, dir: mirrorDir, gitdir: g, oid: t, ancestor: s })
      if (!remoteAhead) {
        const localAhead = await git.isDescendent({ fs, dir: mirrorDir, gitdir: g, oid: s, ancestor: t })
        if (localAhead) return { ok: true, detail: 'nothing to fast-forward (local ahead; push will ship it)' }
        return { ok: false, code: 'diverged', detail: 'diverged — fast-forward impossible (local upstream)' }
      }
    }
    await git.writeRef({ fs, dir: mirrorDir, gitdir: g, ref: `refs/heads/${branch}`, value: t, force: true })
    await git.writeRef({ fs, dir: mirrorDir, gitdir: g, ref: `refs/remotes/origin/${branch}`, value: t, force: true })
    await checkoutMirror(mirrorDir, branch)
    return { ok: true, detail: 'fast-forwarded (local)', changed: true }
  } catch (error) {
    return { ok: false, code: 'network', detail: `pull(local): ${String((error as Error)?.message ?? error)}` }
  }
}

export async function pushLocal(mirrorDir: string, upstreamPath: string, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  const branch = opts.defaultBranch ?? 'main'
  try {
    const s = await localHeadOf(mirrorDir, branch)
    if (s === null) return { ok: true, detail: 'pushed (nothing new)' }
    const up = await ensureUpstreamDir(upstreamPath, branch)
    if (!up.ok) return { ok: false, code: 'network', detail: up.detail }
    const t = await localHeadOf(upstreamPath, branch)
    const ug = gitdirOf(upstreamPath)
    if (ug === null) return { ok: false, detail: 'upstream lost its gitdir' }
    if (s === t) return { ok: true, detail: 'pushed (up to date)' }
    const tr = await transferCommits(mirrorDir, upstreamPath, [s])
    if (!tr.ok) return tr
    if (t !== null) {
      const canFf = await git.isDescendent({ fs, dir: upstreamPath, gitdir: ug, oid: s, ancestor: t })
      if (!canFf) return { ok: false, code: 'diverged', detail: 'push rejected — upstream diverged (local)' }
    }
    await git.writeRef({ fs, dir: upstreamPath, gitdir: ug, ref: `refs/heads/${branch}`, value: s, force: true })
    const g = gitdirOf(mirrorDir)
    if (g !== null) await git.writeRef({ fs, dir: mirrorDir, gitdir: g, ref: `refs/remotes/origin/${branch}`, value: s, force: true }).catch(() => undefined)
    return { ok: true, detail: 'pushed (local)', changed: true }
  } catch (error) {
    return { ok: false, code: 'network', detail: `push(local): ${String((error as Error)?.message ?? error)}` }
  }
}

/** Mirror provenance: which upstream this mirror was last bound to (http OR
 * local) — an origin change is detected on EVERY ensureClone, local or not. */
export const originSentinel = (mirrorDir: string): string => path.join(mirrorDir, '.git', 'DSH-ORIGIN')
export async function recordOrigin(mirrorDir: string, url: string): Promise<void> {
  await nodefs.mkdir(path.join(mirrorDir, '.git'), { recursive: true })
  await nodefs.writeFile(originSentinel(mirrorDir), url)
}
export function readOrigin(mirrorDir: string): string | null {
  try { return fs.readFileSync(originSentinel(mirrorDir), 'utf8').trim() } catch { return null }
}

export interface GitDriver {
  ensureClone(dir: string, remote: RemoteSpec, opts?: { defaultBranch?: string }): Promise<GitOpResult>
  initLocal(dir: string, remote?: RemoteSpec, opts?: { defaultBranch?: string }): Promise<GitOpResult>
  removeMirror(dir: string): Promise<GitOpResult>
  stageAllAndCommit(dir: string, message: string, author: CommitAuthor): Promise<GitOpResult>
  pullFastForward(dir: string, remote: RemoteSpec, opts?: { defaultBranch?: string }): Promise<GitOpResult>
  push(dir: string, remote: RemoteSpec, opts?: { defaultBranch?: string }): Promise<GitOpResult>
}

/**
 * Initialize a local-only mirror (offline mode, record §5.3): the remote is
 * unreachable, but the mirror is transport over truth we own — publish,
 * index, commit, and search keep working; push waits for the remote.
 */
export async function initLocal(dir: string, remote?: RemoteSpec, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  try {
    if (await isRepo(dir)) {
      // even an existing repo needs its origin (offline mirrors init before
      // the remote is reachable; recovery must be able to fetch)
      if (remote !== undefined) await git.addRemote({ fs, dir, remote: 'origin', url: remote.url, force: true }).catch(() => undefined)
      return { ok: true, detail: 'already a repo' }
    }
    await nodefs.mkdir(dir, { recursive: true })
    const entries = await nodefs.readdir(dir)
    const strays = entries.filter((e) => e !== '.git')
    if (strays.length > 0) {
      // same policy as ensureClone: dead transport moved aside, never fatal
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await nodefs.rename(dir, `${dir}.stale-${stamp}`)
      await nodefs.mkdir(dir, { recursive: true })
    }
    await git.init({ fs, dir, defaultBranch: opts.defaultBranch ?? 'main' })
    if (remote !== undefined) await git.addRemote({ fs, dir, remote: 'origin', url: remote.url })
    return { ok: true, detail: 'local mirror initialized (offline mode)', changed: true }
  } catch (error) {
    return { ok: false, detail: `init: ${String((error as Error)?.message ?? error)}` }
  }
}

/** Delete the mirror working tree + git dir entirely. SAFE ONLY because the
 * mirror is transport (§3.1): the workspace store holds the truth, and the
 * rebuild republishes from it (the diverged-offline recovery, §5.3). */
export async function removeMirror(dir: string): Promise<GitOpResult> {
  try {
    await nodefs.rm(dir, { recursive: true, force: true })
    return { ok: true, detail: 'mirror removed for rebuild' }
  } catch (error) {
    return { ok: false, detail: `remove: ${String((error as Error)?.message ?? error)}` }
  }
}

/** Push the local branch; a rejected (non-ff) push comes back for the caller to ff-and-retry. */
export async function push(dir: string, remote: RemoteSpec, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  const ref = `refs/heads/${await branchOf(dir, opts.defaultBranch ?? 'main')}`
  try {
    await git.push({ fs, http: nodeHttp, dir, url: remote.url, ref, onAuth: authOf(remote) })
    return { ok: true, detail: 'pushed' }
  } catch (error) {
    const msg = String((error as Error)?.message ?? error)
    if (/rejected|non-fast-forward|fetch first/i.test(msg)) {
      return { ok: false, code: 'rejected', detail: 'push rejected (remote is ahead) — pull-and-retry' }
    }
    return { ok: false, code: 'network', detail: `push failed: ${msg}` }
  }
}

/** The real driver (isomorphic-git, https only — record §3.2). Sync takes a driver
 * so tests can exercise the loop against a fake remote (the wire protocol is
 * isomorphic-git's to own; our logic is what the fake exercises). */
const upstreamOf = (remote: RemoteSpec, dir: string): string | undefined =>
  isLocalUpstreamUrl(remote.url) ? resolveLocalUpstreamPath(remote.url, path.dirname(path.dirname(dir))) : undefined

export const isomorphicDriver: GitDriver = {
  async ensureClone(dir, remote, opts) {
    const up = upstreamOf(remote, dir)
    if (up !== undefined) {
      const known = readOrigin(dir)
      if (known !== null && known !== up) {
        return { ok: false, code: 'origin-mismatch', detail: `mirror origin is ${known}, the project's upstream is ${up}` }
      }
      const res = await ensureCloneLocal(dir, up, opts)
      if (res.ok) await recordOrigin(dir, up)
      return res
    }
    if (await isRepo(dir)) {
      const known = readOrigin(dir)
      if (known !== null && known !== remote.url) {
        return { ok: false, code: 'origin-mismatch', detail: `mirror origin is ${known}, the project's remote is ${remote.url}` }
      }
      const r = await ensureClone(dir, remote, opts)
      if (r.ok && r.detail === 'already a repo') await recordOrigin(dir, remote.url)
      return r
    }
    const r = await ensureClone(dir, remote, opts)
    if (r.ok) await recordOrigin(dir, remote.url)
    return r
  },
  initLocal,
  removeMirror,
  stageAllAndCommit,
  async pullFastForward(dir, remote, opts) {
    const up = upstreamOf(remote, dir)
    return up !== undefined ? pullLocal(dir, up, opts) : pullFastForward(dir, remote, opts)
  },
  async push(dir, remote, opts) {
    const up = upstreamOf(remote, dir)
    return up !== undefined ? pushLocal(dir, up, opts) : push(dir, remote, opts)
  },
}
