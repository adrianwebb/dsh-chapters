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
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { type CommitAuthor, type RemoteSpec } from './gitops.ts'
import { selectProvider, type ProviderKind, type SyncProvider } from './provider.ts'
import { buildIndexShards, entryFromChapter, parseCuration, stitchFragments, type CurationFact, type IndexEntry, type IndexManifest } from './indexing.ts'
import { analyzeTopics, planAppends, type VocabOpts } from './vocabulary.ts'

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
  /** Transport kind (§15 amendment); absent = 'git' (pre-provider records). */
  kind?: ProviderKind
  /** TreeDX: the server-assigned repository id (resolved at link time). */
  repoId?: string | undefined
}

export interface SyncResult {
  ok: boolean
  /** What actually happened, for the status command and tests. */
  steps: string[]
  detail: string
  /** 'synced' only when the remote accepted the push; 'local-only' when the
   * mirror is current but the remote did not take it (record §5.3). */
  mode: 'synced' | 'local-only'
}

/**
 * Per-project credentials — stored under the DSH HOME, never the workspace
 * (user directive 2026-09-18: the project tree is the agent's reading room;
 * the plugin is the only accessor). 0600 file per projectKey. Note honestly:
 * same-uid files are a hygiene boundary, not a cryptographic one — the real
 * guarantee is that the plugin never echoes the token anywhere an agent sees.
 */
export const tokenPath = (projectKey: string): string =>
  dshHomePath('dsh-chapters', 'credentials', projectKey)

/** Pre-move location, migrated on first read (delete after copying). */
const legacyTokenPath = (cwd: string, storeRoot: string, projectKey: string): string =>
  path.join(cwd, storeRoot, '.git-auth', projectKey)

export function readToken(cwd: string, storeRoot: string, projectKey: string): string | undefined {
  try {
    const raw = fs.readFileSync(tokenPath(projectKey), 'utf8').trim()
    if (raw.length > 0) return raw
  } catch { /* not in home yet */ }
  const legacy = legacyTokenPath(cwd, storeRoot, projectKey)
  try {
    const raw = fs.readFileSync(legacy, 'utf8').trim()
    if (raw.length === 0) return undefined
    fs.mkdirSync(path.dirname(tokenPath(projectKey)), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenPath(projectKey), raw + '\n', { mode: 0o600 })
    fs.rmSync(legacy, { force: true })
    return raw
  } catch {
    return undefined
  }
}

export function writeToken(projectKey: string, token: string): void {
  const p = tokenPath(projectKey)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, token + '\n', { mode: 0o600 })
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
  /** P2 §6.3 vocabulary pass over the mirror's chapters (undefined = off). */
  vocab?: VocabPassOpts
  /** Force a run even when the lock is held (tests). Default false. */
  force?: boolean
  /** Transport provider (tests inject a fake; default resolves from the
   * project record's kind via src/provider.ts — 'git' when absent). */
  provider?: SyncProvider
}

/**
 * Deepest-cwd match (record §8): the active knowledge project for a
 * workspace path. Shared by the notice line, the scheduler, and the commands.
 */
export function projectForCwd(records: Iterable<[string, ProjectRecord]>, cwd: string): ProjectRecord | undefined {
  let best: ProjectRecord | undefined
  for (const [, rec] of records) {
    if (cwd === rec.cwd || cwd.startsWith(`${rec.cwd}/`) || cwd.startsWith(`${rec.cwd}${path.sep}`)) {
      if (best === undefined || rec.cwd.length > best.cwd.length
        || (rec.cwd.length === best.cwd.length && rec.linkedAt > best.linkedAt)) best = rec
    }
  }
  return best
}

/** The mirror directory, relative to the workspace (record §3.1). */
export const DEFAULT_CLONE_DIR = '.dsh-knowledge'

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
    // P3: the rules author tree is project-level, not session-level
    if (sessionDir.name === 'rules') continue
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
  // rules/<harness>/*.md -> rules/<projectKey>/<harness>/*.md (record §7.1:
  // rules are chapters of a different kind, same transport, author-partitioned)
  const rulesRoot = path.join(storeDir, 'rules')
  if (fs.existsSync(rulesRoot)) {
    for (const h of fs.readdirSync(rulesRoot, { withFileTypes: true })) {
      if (!h.isDirectory()) continue
      for (const f of fs.readdirSync(path.join(rulesRoot, h.name))) {
        if (!f.endsWith('.md')) continue
        out.push({ abs: path.join(rulesRoot, h.name, f), rel: path.join('rules', projectKey, h.name, f) })
      }
    }
  }
  return out
}

/**
 * Copy store files into the mirror. A file absent in the mirror is new; a
 * file present with DIFFERENT bytes is rewritten (P2 enrichment legitimately
 * updates the frontmatter of chapter files — model-owned fields only, with
 * the body hash guard in enrich-store.ts ensuring the verbatim body never
 * changes). Cross-machine safety is the same argument that already governs
 * collection JSONL (§3.3): paths are partitioned by rootSession, a session
 * belongs to exactly one machine, so only its author rewrites its files and
 * ff-only stays conflict-free. Byte-identical files are skipped.
 */
function copyNewFiles(cloneDir: string, files: { abs: string; rel: string }[]): { copied: number; skipped: number } {
  let copied = 0
  let skipped = 0
  for (const f of files) {
    const dst = path.join(cloneDir, f.rel)
    if (fs.existsSync(dst)) {
      try {
        if (fs.readFileSync(dst).equals(fs.readFileSync(f.abs))) { skipped += 1; continue }
      } catch { skipped += 1; continue }
    }
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
  const { shards, manifest: next, changed } = buildIndexShards(stitchFragments(entries), curation, manifest)
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
 * Publish the store + collections into the mirror and rebuild its index.
 * Returns the count of newly written/changed files (the commit trigger).
 * Shared by the normal pass and the diverged-rebuild pass.
 */
function publishIntoClone(
  cloneDir: string, storeDir: string, opts: SyncOpts,
): { copied: number; skipped: number; vocabReport?: string } {
  let vocabReport: string | undefined
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
  // P2 §6.3: emergent vocabulary pass. Shadow mode (default) only reports;
  // applied merges append topic-alias facts to edits/<author>/curation.jsonl
  // — every merge git-visible and revertible, consumed by the index build
  // just below on the NEXT rebuild and by the one here.
  try {
    const vr = runVocabularyPass(cloneDir, opts.project, opts.vocab)
    if (vr !== undefined) {
      vocabReport = vr.report
      copied += vr.wrote
    }
  } catch (error) {
    vocabReport = `vocabulary pass failed (${String((error as Error)?.message ?? error).slice(0, 80)})`
  }
  let indexChanged = false
  try {
    indexChanged = buildIndexInClone(cloneDir)
    if (indexChanged) copied += 1
    // record §6.3: the derived vocabulary artifact — deterministic (no
    // timestamps), so identical inputs never dirty the mirror
    emitVocabularyJson(cloneDir)
  } catch { /* index failure never blocks the pass (record §5.3) */ }
  return { copied, skipped, ...(vocabReport !== undefined ? { vocabReport } : {}) }
}

/** topics/vocabulary.json: canonical labels, live aliases, frequency. */
function emitVocabularyJson(cloneDir: string): void {
  const root = path.join(cloneDir, 'chapters')
  if (!fs.existsSync(root)) return
  const labels = new Map<string, number>()
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.md')) continue
      try { for (const t of entryFromChapter('', fs.readFileSync(p, 'utf8')).topics) labels.set(t, (labels.get(t) ?? 0) + 1) } catch { /* skip */ }
    }
  }
  walk(root)
  const alias = new Map<string, string>()
  const editsRoot = path.join(cloneDir, 'edits')
  if (fs.existsSync(editsRoot)) {
    for (const h of fs.readdirSync(editsRoot, { withFileTypes: true })) {
      if (!h.isDirectory()) continue
      const file = path.join(editsRoot, h.name, 'curation.jsonl')
      if (!fs.existsSync(file)) continue
      for (const f of parseCuration(fs.readFileSync(file, 'utf8'))) if (f.type === 'topic-alias') alias.set(f.from, f.to)
    }
  }
  const resolve = (l: string): string => { let x = l; for (let i = 0; i < 10 && alias.has(x); i++) x = alias.get(x)!; return x }
  const canonical = new Map<string, number>()
  for (const [l, n] of labels) canonical.set(resolve(l), (canonical.get(resolve(l)) ?? 0) + n)
  const doc = {
    canonical: Object.fromEntries([...canonical.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)),
    aliases: Object.fromEntries([...alias.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)),
    unvetted: [...labels.keys()].filter((l) => alias.has(l)).sort(),
  }
  const text = JSON.stringify(doc, null, 1) + '\n'
  const out = path.join(cloneDir, 'topics', 'vocabulary.json')
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, text)
  }
}

export interface VocabPassOpts extends VocabOpts {
  /** write applied aliases? false (shadow) = report only — the default */
  apply: boolean
}

/** one line of the sync report describing the vocabulary pass outcome. */
function runVocabularyPass(
  cloneDir: string,
  project: SyncOpts['project'],
  opts: VocabPassOpts | undefined,
): { report: string; wrote: number } | undefined {
  if (opts === undefined) return undefined
  const root = path.join(cloneDir, 'chapters', project.projectKey)
  if (!fs.existsSync(root)) return { report: 'vocabulary: no chapters yet', wrote: 0 }
  const chapterTopics: string[][] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(path.join(dir, e.name)); continue }
      if (!e.name.endsWith('.md')) continue
      try {
        const entry = entryFromChapter('', fs.readFileSync(path.join(dir, e.name), 'utf8'))
        if (entry.topics.length > 0) chapterTopics.push(entry.topics)
      } catch { /* unreadable chapter: skip, the index build reports it */ }
    }
  }
  walk(root)
  const { candidates } = analyzeTopics(chapterTopics, opts)
  // existing aliases from EVERY edits/<harness>/curation.jsonl (chain-aware)
  const existing = new Map<string, string>()
  const editsRoot = path.join(cloneDir, 'edits')
  if (fs.existsSync(editsRoot)) {
    for (const h of fs.readdirSync(editsRoot, { withFileTypes: true })) {
      if (!h.isDirectory()) continue
      const file = path.join(editsRoot, h.name, 'curation.jsonl')
      if (!fs.existsSync(file)) continue
      for (const f of parseCuration(fs.readFileSync(file, 'utf8'))) {
        if (f.type === 'topic-alias') existing.set(f.from, f.to)
      }
    }
  }
  const { lines, plan } = planAppends(candidates, existing, new Date().toISOString())
  if (lines.length === 0) {
    return { report: `vocabulary: ${candidates.length} candidate(s), ${existing.size} alias(es) known, nothing new`, wrote: 0 }
  }
  if (!opts.apply) {
    return { report: `vocabulary: ${lines.length} merge candidate(s) SHADOWED (set vocabApply): ${lines.slice(0, 3).map((l) => { const o = JSON.parse(l) as { from: string; to: string }; return `${o.from}->${o.to}` }).join(', ')}${lines.length > 3 ? ' …' : ''}`, wrote: 0 }
  }
  const authorDir = path.join(editsRoot, project.harnessId)
  fs.mkdirSync(authorDir, { recursive: true })
  fs.appendFileSync(path.join(authorDir, 'curation.jsonl'), lines.join('\n') + '\n')
  return { report: `vocabulary: applied ${lines.length} topic-alias curation entr${lines.length === 1 ? 'y' : 'ies'} (author ${project.harnessId})`, wrote: 1 }
}

/**
 * One sync pass (record §5): lock → ensure clone (offline init fallback) →
 * publish → commit → pull → push. Failure semantics §5.3: EVERY remote-path
 * failure (clone, pull, push) degrades to local-only mode — the mirror stays
 * current for search and the status file says so with detail; only a local
 * commit failure or lock loss returns without a current mirror. A diverged
 * pull rebuilds the mirror from the remote (safe: the mirror is transport,
 * the store is truth, §3.1). ok=true means the remote accepted the push.
 */
export async function runSync(opts: SyncOpts): Promise<SyncResult> {
  const steps: string[] = []
  const storeDir = path.join(opts.cwd, opts.storeRoot)
  const cloneDir = path.join(opts.cwd, opts.cloneDir)
  const record = (ok: boolean, mode: 'synced' | 'local-only', detail: string): SyncResult => {
    const result = { ok, steps, detail, mode }
    try {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(statusFilePath(opts.cwd, opts.storeRoot), JSON.stringify({
        at: new Date().toISOString(),
        projectKey: opts.project.projectKey,
        lastOk: ok, mode, detail, steps,
      }, null, 1))
    } catch { /* status is best-effort too */ }
    return result
  }
  let provider: SyncProvider
  try {
    provider = opts.provider ?? selectProvider(opts.project)
  } catch (error) {
    return record(false, 'local-only', `provider unavailable: ${String((error as Error)?.message ?? error)}`)
  }
  const lock = acquireLock(syncLockPath(storeDir), opts.force ?? false)
  if (!lock.held) {
    return record(false, 'local-only', lock.detail ?? 'lock unavailable')
  }
  const remote: RemoteSpec = { url: opts.project.remote, ...(opts.token !== undefined ? { token: opts.token } : {}) }
  const author: CommitAuthor = { name: 'dsh-chapters', email: `${opts.project.harnessId}@dsh-chapters.local` }
  const publishCommit = async (): Promise<{ copied: number; committed: boolean }> => {
    const { copied, skipped, vocabReport } = publishIntoClone(cloneDir, storeDir, opts)
    steps.push(`published ${copied} new file(s), ${skipped} already mirrored`)
    if (vocabReport !== undefined) steps.push(vocabReport)
    // P3: the commit is ATTEMPTED EVEN WHEN copied === 0. Command-written
    // curation facts (rule approvals) change the worktree without any store
    // copy; post-r37, stageAllAndCommit's workdir-vs-HEAD diff is the honest
    // gate and reports 'nothing to commit' when the tree truly is clean.
    const commit = await provider.stageAllAndCommit(cloneDir, `dsh-chapters: ${opts.project.projectKey} (+${copied} file(s)) — harness ${opts.project.harnessId}`, author)
    steps.push(commit.detail)
    return { copied, committed: commit.ok && commit.changed === true }
  }
  try {
    let offline = false
    let rebuild = false
    let clone = await provider.ensureClone(cloneDir, remote)
    if (!clone.ok && clone.code === 'origin-mismatch') {
      // the workspace re-linked to a different repo: the mirror is transport
      // for the CURRENT project — rebuild it (never sync into the wrong pool)
      steps.push(`origin changed (${clone.detail}) — rebuilding mirror`)
      rebuild = true
      clone = { ok: true, detail: 'rebuild' }
    }
    if (clone.ok && !rebuild) {
      steps.push(clone.detail)
    } else {
      if (rebuild) {
        const rm = await provider.removeMirror(cloneDir)
        if (!rm.ok) return record(false, 'local-only', `rebuild remove: ${rm.detail}`)
        const recl = await provider.ensureClone(cloneDir, remote)
        if (!recl.ok) {
          const init = await provider.initLocal(cloneDir, remote)
          if (!init.ok) return record(false, 'local-only', `rebuild clone: ${recl.detail}; init: ${init.detail}`)
          offline = true
        } else steps.push(recl.detail)
      } else {
        // §5.3: unreachable remote ⇒ offline mirror. publish/commit/index/
        // search all keep working; the push lands when the remote returns.
        const init = await provider.initLocal(cloneDir, remote)
        if (!init.ok) return record(false, 'local-only', `clone: ${clone.detail}; local init: ${init.detail}`)
        offline = true
        steps.push(`remote unreachable (${clone.detail}) — ${init.detail}`)
      }
    }

    const { committed } = await publishCommit()
    void committed

    // Divergence is resolved by REBUILDING from the store (record §5.2 via
    // §15): destroy transport, republish from truth, re-derive, push. Shared
    // by every place divergence surfaces — pull, first push (TreeDX commit
    // 409 under a race), or retry push. Bounded: rebuildAndPush never
    // re-enters itself.
    const rebuildAndPush = async (why: string): Promise<SyncResult> => {
      steps.push(`diverged (${why}) — rebuilding mirror from remote`)
      const rm = await provider.removeMirror(cloneDir)
      if (!rm.ok) return record(false, 'local-only', `rebuild remove: ${rm.detail}`)
      const recl = await provider.ensureClone(cloneDir, remote)
      if (!recl.ok) return record(false, 'local-only', `rebuild clone: ${recl.detail}`)
      await publishCommit()
      const repush = await provider.push(cloneDir, remote)
      steps.push(repush.detail)
      return repush.ok
        ? record(true, 'synced', 'rebuilt and pushed')
        : record(false, 'local-only', `rebuild push: ${repush.detail}`)
    }

    if (offline) {
      // The clone failure's OWN reason rides into the status (live-TreeDX
      // lesson: a 401 reported only as "unreachable" sends the user chasing
      // the wrong ghost — the auth detail must survive the offline fallback).
      return record(false, 'local-only', `remote unreachable at clone time (${clone.detail}) — local mirror current; push deferred`)
    }

    const pull = await provider.pullFastForward(cloneDir, remote)
    if (!pull.ok) {
      if (pull.code === 'diverged') return rebuildAndPush(pull.detail)
      return record(false, 'local-only', `pull unavailable (${pull.detail}) — local mirror current; push deferred`)
    }
    steps.push(pull.detail)

    let pushed = await provider.push(cloneDir, remote)
    if (!pushed.ok && pushed.code === 'diverged') return rebuildAndPush(`push: ${pushed.detail}`)
    if (!pushed.ok && pushed.code === 'rejected') {
      const retryPull = await provider.pullFastForward(cloneDir, remote)
      if (!retryPull.ok) {
        if (retryPull.code === 'diverged') return rebuildAndPush(retryPull.detail)
        return record(false, 'local-only', `retry pull: ${retryPull.detail}`)
      }
      pushed = await provider.push(cloneDir, remote)
      steps.push('push rejected — ff-retried')
    }
    if (!pushed.ok) {
      return record(false, 'local-only', `push failed (${pushed.detail}) — local mirror current; push deferred`)
    }
    steps.push(pushed.detail)
    return record(true, 'synced', 'synced')
  } catch (error) {
    return record(false, 'local-only', String((error as Error)?.message ?? error))
  } finally {
    lock.release()
  }
}

/**
 * Pull-only pass for the pre-fork refresh point (record §5.1): ensure the
 * mirror exists (clone, offline-init fallback) and ff-pull it. Never throws,
 * never pushes, never commits — a read-side refresh.
 */
export async function runPull(opts: Omit<SyncOpts, 'force'>): Promise<{ ok: boolean; detail: string }> {
  let provider: SyncProvider
  try {
    provider = opts.provider ?? selectProvider(opts.project)
  } catch (error) {
    return { ok: false, detail: `provider unavailable: ${String((error as Error)?.message ?? error)}` }
  }
  const cloneDir = path.join(opts.cwd, opts.cloneDir)
  const remote: RemoteSpec = { url: opts.project.remote, ...(opts.token !== undefined ? { token: opts.token } : {}) }
  try {
    const clone = await provider.ensureClone(cloneDir, remote)
    if (!clone.ok) {
      const init = await provider.initLocal(cloneDir, remote)
      return { ok: false, detail: `clone: ${clone.detail}${init.ok ? ' (offline mirror present)' : `; init: ${init.detail}`}` }
    }
    const pull = await provider.pullFastForward(cloneDir, remote)
    return { ok: pull.ok, detail: `${clone.detail}; ${pull.detail}` }
  } catch (error) {
    return { ok: false, detail: String((error as Error)?.message ?? error) }
  }
}

/**
 * A workspace-scoped collections reader for the scheduler (§5): only session
 * trees whose store directory lives in THIS workspace publish. Shared by the
 * host plugin and the realm engine (the two schedulers are the same code over
 * different module copies — the file lock keeps them honest).
 */
export function makeCollectionsReader(
  sessions: () => IterableIterator<[string, import('./registry.ts').SessionState]>,
  storeRoot: string,
): (cwd: string) => { sessionId: string; lines: string[] }[] {
  return (cwd: string) => {
    const out: { sessionId: string; lines: string[] }[] = []
    for (const [sid, st] of sessions()) {
      if (st.collections.length === 0) continue
      if (!fs.existsSync(path.join(cwd, storeRoot, st.rootSession))) continue
      out.push({ sessionId: sid, lines: st.collections.map((c) => JSON.stringify(c)) })
    }
    return out
  }
}

/**
 * The debounced scheduler (§5.2: "consecutive archive events within the
 * configured window coalesce into one push"). Pure wiring — the plane that
 * owns it (host plugin or realm engine) injects how to find the project, the
 * token, and the collection files. Never throws; a failed pass lands in the
 * status file like any other.
 */
export interface SyncSchedulerDeps {
  storeRoot: string
  cloneDir?: string
  debounceMs: number
  resolveProject(cwd: string): ProjectRecord | undefined
  tokenFor(cwd: string, projectKey: string): string | undefined
  /** Collection JSONL lines per session, read from the registry (may be empty). */
  collectionsFor(cwd: string): { sessionId: string; lines: string[] }[]
  /** P2 §6.3 vocabulary pass options for every scheduled pass (undefined = off). */
  vocab?: VocabPassOpts
  /** Injectable timer (tests). Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
  provider?: SyncProvider
  /** P2: fired after a REAL sync pass completes (success or degraded) — the
   * enrichment queue's natural idle point. Not fired for 'no project
   * linked' early-outs (nothing was published, nothing to enrich). */
  onSyncDone?: (cwd: string, ok: boolean) => void
}

export interface SyncScheduler {
  /** Debounced push after an archive event (compaction/fork). */
  schedule(cwd: string, why: string): void
  /** Immediate pass (a link, an explicit sync). An explicit project wins
   * over the cwd lookup — a re-link must sync the NEW record, not whichever
   * record the cwd tie-break happens to pick. */
  run(cwd: string, why: string, project?: ProjectRecord): Promise<SyncResult>
  /** Pre-fork refresh (§5.1): pull-only, bounded, never blocks long. */
  pullFor(cwd: string): Promise<{ ok: boolean; detail: string }>
  hasPending(cwd: string): boolean
  /** Await any in-flight/scheduled pass (tests + shutdown). */
  drain(): Promise<void>
}

export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  const cloneDir = deps.cloneDir ?? DEFAULT_CLONE_DIR
  const timers = new Map<string, { cancel(): void }>()
  const inFlight = new Map<string, Promise<SyncResult>>()
  const pendingSettled: Array<Promise<void>> = []
  const mkTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return { cancel: () => clearTimeout(t) }
  })
  const start = (cwd: string, projectOverride?: ProjectRecord): Promise<SyncResult> => {
    const existing = inFlight.get(cwd)
    if (existing !== undefined) return existing
    const project = projectOverride ?? deps.resolveProject(cwd)
    if (project === undefined) {
      return Promise.resolve({ ok: false, steps: [], detail: 'no knowledge project linked for this workspace', mode: 'local-only' })
    }
    const token = deps.tokenFor(cwd, project.projectKey)
    const pass = runSync({
      cwd,
      storeRoot: deps.storeRoot,
      cloneDir,
      project,
      ...(token !== undefined ? { token } : {}),
      collections: deps.collectionsFor(cwd),
      ...(deps.vocab !== undefined ? { vocab: deps.vocab } : {}),
      ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    }).finally(() => { inFlight.delete(cwd) })
    if (deps.onSyncDone !== undefined) {
      const notify = (r: SyncResult): void => { try { deps.onSyncDone?.(cwd, r.ok) } catch { /* never break the pass */ } }
      pass.then(notify, () => notify({ ok: false, steps: [], detail: 'pass rejected', mode: 'local-only' }))
    }
    inFlight.set(cwd, pass)
    return pass
  }
  return {
    schedule(cwd: string, _why: string): void {
      timers.get(cwd)?.cancel()
      const timer = mkTimer(() => {
        timers.delete(cwd)
        pendingSettled.push(start(cwd).then(() => undefined))
        if (pendingSettled.length > 32) pendingSettled.splice(0, pendingSettled.length - 32)
      }, deps.debounceMs)
      timers.set(cwd, timer)
    },
    run(cwd: string, _why: string, project?: ProjectRecord): Promise<SyncResult> {
      timers.get(cwd)?.cancel()
      timers.delete(cwd)
      return start(cwd, project)
    },
    async pullFor(cwd: string) {
      const project = deps.resolveProject(cwd)
      if (project === undefined) return { ok: false, detail: 'no linked project' }
      const token = deps.tokenFor(cwd, project.projectKey)
      const prior = inFlight.get(cwd)
      if (prior !== undefined) { await prior; return { ok: true, detail: 'awaited in-flight sync instead of a second pull' } }
      return runPull({
        cwd,
        storeRoot: deps.storeRoot,
        cloneDir,
        project,
        ...(token !== undefined ? { token } : {}),
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
      })
    },
    hasPending(cwd: string): boolean {
      return timers.has(cwd) || inFlight.has(cwd)
    },
    async drain(): Promise<void> {
      for (const t of timers.values()) t.cancel()
      timers.clear()
      let batch: Array<Promise<void>>
      do {
        batch = pendingSettled.splice(0)
        await Promise.all(batch.map((p) => p.catch(() => undefined)))
      } while (pendingSettled.length > 0)
      await Promise.all([...inFlight.values()].map((p) => p.catch(() => undefined)))
    },
  }
}

/** Read the last sync status (for /chapters-status). Null when never run. */
export function readSyncStatus(cwd: string, storeRoot: string): { at: string; projectKey: string; lastOk: boolean; mode?: string; detail: string; steps: string[] } | null {
  try {
    return JSON.parse(fs.readFileSync(statusFilePath(cwd, storeRoot), 'utf8'))
  } catch {
    return null
  }
}
