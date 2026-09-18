/**
 * The sync loop (knowledge-repo.md §3.1, §5): workspace store → git mirror →
 * remote. The mirror lives INSIDE the workspace (`.dsh-knowledge`) so it is
 * transport, not storage (§3.1); the read path (the read tool) never touches
 * the clone.
 *
 * Best-effort by rule (§5.3): runSync never throws into the conversation
 * path — every failure returns `{ok: false, detail}` and lands in the status
 * file the /chapters-status command reads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isomorphicDriver, type CommitAuthor, type GitDriver, type RemoteSpec } from './gitops.ts'
import { buildIndexShards, entryFromChapter, parseCuration, type CurationFact, type IndexEntry, type IndexManifest } from './indexing.ts'

/** A linked knowledge project (record §2.1, §8): one record per linked
 * workspace cwd; deepest-cwd match resolves the active project. */
export interface ProjectRecord {
  projectKey: string
  slug: string
  remote: string
  harnessId: string
  linkedAt: string
  /** Workspace cwd this record was linked from (deepest-prefix match, record §8). */
  cwd: string
}

export interface SyncResult {
  ok: boolean
  /** What actually happened, for the status command and tests. */
  steps: string[]
  detail: string
}

export interface SyncOpts {
  /** Workspace root — the store and the mirror both live under it. */
  cwd: string
  /** Store root relative to cwd (`.dsh-chapters`). */
  storeRoot: string
  /** Mirror directory relative to cwd (`.dsh-knowledge`). */
  cloneDir: string
  project: ProjectRecord
  /** Per-harness token for this project (record §2.1); undefined for file remotes. */
  token?: string
  /** Collection files to (re)publish: one JSONL file per session's signatures. */
  collections?: { sessionId: string; lines: string[] }[]
  /** Force a run even when the lock is held (tests). Default false. */
  force?: boolean
  /** The git driver (tests inject a fake; production uses isomorphicDriver). */
  driver?: GitDriver
}

const LOCK_STALE_MS = 10 * 60 * 1000

/**
 * File lock around store transactions and clone ops (§5.2): the host-plane
 * plugin and the realm engine may be different module instances in the same
 * process, so an in-process mutex is not safe — a file is the honest lock.
 * Stale locks (>10 min) are stolen; live ones make runSync skip, not block.
 */
export function syncLockPath(storeDir: string): string {
  return path.join(storeDir, '.sync.lock')
}

function acquireLock(lockPath: string, force: boolean): { held: boolean; release(): void; detail?: string } {
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() })
  try {
    if (!force) {
      const existing = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { at: number } : null
      if (existing !== null && Date.now() - existing.at < LOCK_STALE_MS) {
        return { held: false, release() {}, detail: 'another sync is in progress (lock held) — skipped, will retry at the next archive' }
      }
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, payload)
    return { held: true, release() { try { fs.unlinkSync(lockPath) } catch { /* best-effort */ } } }
  } catch (error) {
    // A lock that cannot be written is reported as such, not as "held" —
    // conflating the two would hide a real failure as a benign skip.
    return { held: false, release() {}, detail: `lock unavailable at ${lockPath}: ${String((error as Error)?.message ?? error)}` }
  }
}

/**
 * Map workspace-store files to repo paths (record §2.2):
 *   <storeRoot>/<rootSession>/chapters/x.md  → chapters/<projectKey>/<rootSession>/x.md
 *   <storeRoot>/<rootSession>/artifacts/ab/ab….txt → artifacts/<projectKey>/ab/ab….txt
 * Artifacts are content-addressed and shared across sessions, so their
 * per-session prefix is dropped; chapters keep it.
 */
export function planStoreToRepo(storeDir: string, projectKey: string): { abs: string; rel: string }[] {
  const out: { abs: string; rel: string }[] = []
  for (const sessionDir of fs.existsSync(storeDir) ? fs.readdirSync(storeDir, { withFileTypes: true }) : []) {
    if (!sessionDir.isDirectory() || sessionDir.name.startsWith('.')) continue
    const chaptersDir = path.join(storeDir, sessionDir.name, 'chapters')
    if (fs.existsSync(chaptersDir)) {
      for (const f of fs.readdirSync(chaptersDir)) {
        if (!f.endsWith('.md')) continue
        out.push({ abs: path.join(chaptersDir, f), rel: path.join('chapters', projectKey, sessionDir.name, f) })
      }
    }
    const artifactsDir = path.join(storeDir, sessionDir.name, 'artifacts')
    const walk = (dir: string, rel: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name)
        if (f.isDirectory()) walk(p, path.join(rel, f.name))
        else out.push({ abs: p, rel: path.join('artifacts', projectKey, rel, f.name) })
      }
    }
    if (fs.existsSync(artifactsDir)) walk(artifactsDir, '')
  }
  return out
}

/** Copy files that are not yet in the mirror; never overwrites (append-only content). */
function copyNewFiles(cloneDir: string, files: { abs: string; rel: string }[]): { copied: number; skipped: number } {
  let copied = 0
  let skipped = 0
  for (const f of files) {
    const dst = path.join(cloneDir, f.rel)
    if (fs.existsSync(dst)) { skipped += 1; continue }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(f.abs, dst)
    copied += 1
  }
  return { copied, skipped }
}

export const statusFilePath = (cwd: string, storeRoot: string): string => path.join(cwd, storeRoot, '.sync-status.json')

const topicSlug = (topic: string): string =>
  topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'topic'

/**
 * Build the Layer-2 index inside the clone (record §10.2): entries from every
 * chapter/rule file (frontmatter), curation facts from every harness's
 * curation.jsonl, the manifest from the clone's index/manifest.json. Returns
 * true when shards or the manifest changed (the commit step then ships them).
 * Deterministic: the index is a pure function of the clone's corpus, so any
 * machine can rebuild it identically (the recovery path, record §10.2).
 */
export function buildIndexInClone(cloneDir: string): boolean {
  const entries: IndexEntry[] = []
  const collect = (top: string, kind: 'chapter' | 'rule') => {
    const root = path.join(cloneDir, top)
    if (!fs.existsSync(root)) return
    const walk = (dir: string, rel: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p, rel === '' ? e.name : path.join(rel, e.name)); continue }
        if (e.name.endsWith('.md')) {
          const relPath = rel === '' ? e.name : path.join(rel, e.name)
          const text = fs.readFileSync(p, 'utf8')
          const entry = entryFromChapter(path.join(top, relPath), text, fs.statSync(p).mtimeMs)
          entries.push({ ...entry, kind })
        }
      }
    }
    walk(root, '')
  }
  collect('chapters', 'chapter')
  collect('rules', 'rule')
  const curation: CurationFact[] = []
  const editsDir = path.join(cloneDir, 'edits')
  if (fs.existsSync(editsDir)) {
    for (const harness of fs.readdirSync(editsDir, { withFileTypes: true })) {
      if (!harness.isDirectory()) continue
      const file = path.join(editsDir, harness.name, 'curation.jsonl')
      if (fs.existsSync(file)) curation.push(...parseCuration(fs.readFileSync(file, 'utf8')))
    }
  }
  const manifestPath = path.join(cloneDir, 'index', 'manifest.json')
  let manifest: IndexManifest = {}
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as IndexManifest } catch { manifest = {} }
  }
  const { shards, manifest: next, changed } = buildIndexShards(entries, curation, manifest)
  const indexDir = path.join(cloneDir, 'index')
  if (!changed) {
    if (fs.existsSync(indexDir)) {
      const expected = new Set([...shards.keys()].map(topicSlug))
      for (const f of fs.readdirSync(indexDir)) {
        if (f.endsWith('.md') && !expected.has(f)) fs.unlinkSync(path.join(indexDir, f))
      }
    }
    return false
  }
  fs.mkdirSync(indexDir, { recursive: true })
  for (const [topic, content] of shards) {
    fs.writeFileSync(path.join(indexDir, `${topicSlug(topic)}.md`), content)
  }
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 1))
  return true
}

/**
 * One sync pass: lock → ensure clone → publish new store files + collection
 * JSONL → build the index → commit (if anything changed) → ff-pull → push
 * (ff-and-retry once). Never throws; the status file reflects the last attempt.
 */
export async function runSync(opts: SyncOpts): Promise<SyncResult> {
  const steps: string[] = []
  const storeDir = path.join(opts.cwd, opts.storeRoot)
  const cloneDir = path.join(opts.cwd, opts.cloneDir)
  const record = async (ok: boolean, detail: string, stepsSoFar = steps): Promise<SyncResult> => {
    const result = { ok, steps: stepsSoFar, detail }
    try {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(statusFilePath(opts.cwd, opts.storeRoot), JSON.stringify({
        at: new Date().toISOString(),
        projectKey: opts.project.projectKey,
        lastOk: ok,
        detail,
        steps,
      }, null, 1))
    } catch { /* status is best-effort too */ }
    return result
  }
  const driver = opts.driver ?? isomorphicDriver
  const lock = acquireLock(syncLockPath(storeDir), opts.force ?? false)
  if (!lock.held) {
    return record(false, lock.detail ?? 'lock unavailable')
  }
  try {
    const clone = await driver.ensureClone(cloneDir, { url: opts.project.remote, ...(opts.token !== undefined ? { token: opts.token } : {}) })
    if (!clone.ok) return record(false, `clone: ${clone.detail}`)
    steps.push(clone.detail)

    const storeFiles = planStoreToRepo(storeDir, opts.project.projectKey)
    const { copied: storeCopied, skipped } = copyNewFiles(cloneDir, storeFiles)
    let copied = storeCopied
    // collection files: write-if-changed. Unlike chapters they are REGENERATED
    // (a session keeps collecting signatures, so its JSONL grows); only THIS
    // harness writes its own sessions' files, so ff-only stays conflict-free.
    for (const c of opts.collections ?? []) {
      const rel = path.join('collections', opts.project.projectKey, `${c.sessionId}.jsonl`)
      const abs = path.join(cloneDir, rel)
      const content = c.lines.join('\n') + (c.lines.length > 0 ? '\n' : '')
      if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== content) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content)
        copied += 1
      }
    }
    steps.push(`published ${copied} new file(s), ${skipped} already mirrored`)

    let indexChanged = false
    try {
      indexChanged = buildIndexInClone(cloneDir)
      if (indexChanged) copied += 1
      steps.push(indexChanged ? 'index rebuilt' : 'index unchanged')
    } catch (error) {
      steps.push(`index build failed (non-fatal, retried next sync): ${String((error as Error)?.message ?? error)}`)
    }

    const author: CommitAuthor = { name: 'dsh-chapters', email: `${opts.project.harnessId}@dsh-chapters.local` }
    if (copied > 0) {
      const commit = await driver.stageAllAndCommit(cloneDir, `dsh-chapters: ${opts.project.projectKey} (+${copied} file(s)) — harness ${opts.project.harnessId}`, author)
      if (!commit.ok) return record(false, `commit: ${commit.detail}`)
      steps.push(commit.detail)
    }

    const remote: RemoteSpec = { url: opts.project.remote, ...(opts.token !== undefined ? { token: opts.token } : {}) }
    const pull = await driver.pullFastForward(cloneDir, remote)
    if (!pull.ok) return record(false, `pull: ${pull.detail}`)
    steps.push(pull.detail)

    let pushed = await driver.push(cloneDir, remote)
    if (!pushed.ok && /pull-and-retry/i.test(pushed.detail)) {
      const retryPull = await driver.pullFastForward(cloneDir, remote)
      if (!retryPull.ok) return record(false, `retry pull: ${retryPull.detail}`)
      pushed = await driver.push(cloneDir, remote)
      steps.push('push rejected — ff-retried')
    }
    if (!pushed.ok) return record(false, `push: ${pushed.detail}`)
    steps.push(pushed.detail)
    return record(true, 'synced')
  } catch (error) {
    return record(false, String((error as Error)?.message ?? error))
  } finally {
    lock.release()
  }
}

/** Read the last sync status (for /chapters-status). Null when never run. */
export function readSyncStatus(cwd: string, storeRoot: string): { at: string; projectKey: string; lastOk: boolean; detail: string; steps: string[] } | null {
  try {
    return JSON.parse(fs.readFileSync(statusFilePath(cwd, storeRoot), 'utf8'))
  } catch {
    return null
  }
}
