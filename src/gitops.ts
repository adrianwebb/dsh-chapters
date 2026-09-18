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
import nodeHttp from 'isomorphic-git/http/node'
import * as fs from 'node:fs'
import * as nodefs from 'node:fs/promises'
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
  code?: 'diverged' | 'network' | 'rejected'
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
 * caller's step. A non-empty non-repo dir is an error, never wiped.
 */
export async function ensureClone(dir: string, remote: RemoteSpec, opts: { defaultBranch?: string } = {}): Promise<GitOpResult> {
  try {
    if (await isRepo(dir)) return { ok: true, detail: 'already a repo' }
    const entries = await nodefs.readdir(dir).catch(() => [] as string[])
    if (entries.length > 0) return { ok: false, detail: `clone target ${dir} exists and is not empty and not a git repo` }
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
    const head = new Map<string, string | null>()
    for (const f of headFiles) {
      head.set(f, await nodefs.readFile(path.join(dir, f), 'utf8').catch(() => null as string | null))
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
    // ff-only guard (isomorphic-git's fastForward has no fastForwardOnly flag):
    // fast-forward is possible IFF the LOCAL head is a descendant of the REMOTE
    // head. Divergence is an error here by rule (§3.3), never a force.
    const canFf = await git.isDescendent({ fs, dir, oid: localRef, ancestor: remoteRef })
    if (!canFf) {
      return { ok: false, code: 'diverged', detail: 'diverged — fast-forward impossible (the mirror diverged from the remote; rebuild will recover)' }
    }
    await git.fastForward({ fs, http: nodeHttp, dir, url: remote.url, ref, onAuth: authOf(remote) })
    return { ok: true, detail: 'fast-forwarded', changed: true }
  } catch (error) {
    return { ok: false, code: 'network', detail: `pull failed: ${String((error as Error)?.message ?? error)}` }
  }
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
      if (remote !== undefined) {
        const remotes = await git.listRemotes({ fs, dir }).catch(() => [] as { remote: string }[])
        if (!remotes.some((r) => r.remote === 'origin')) await git.addRemote({ fs, dir, remote: 'origin', url: remote.url })
      }
      return { ok: true, detail: 'already a repo' }
    }
    await nodefs.mkdir(dir, { recursive: true })
    const entries = await nodefs.readdir(dir)
    const strays = entries.filter((e) => e !== '.git')
    if (strays.length > 0) return { ok: false, detail: `init target ${dir} not empty and not a repo` }
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
export const isomorphicDriver: GitDriver = {
  ensureClone,
  initLocal,
  removeMirror,
  stageAllAndCommit,
  pullFastForward,
  push,
}
