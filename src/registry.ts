/**
 * Registry — pure ancestry/numbering state. No cordis, no zod, no I/O: this is
 * the L0 layer (docs/development.md § Test Layers); `src/store.ts` is the thin
 * storage-domain adapter over it, deliberately untested because it is glue.
 *
 * The registry is the SOLE authority on ancestry (contract.md § Lineage: the
 * kernel header carries `parentSession` for seed lineage we deliberately do not
 * use; the UI graph will show our children as unrelated roots). Corruptions it
 * must survive: cycles (walk guard throws, never hangs), duplicate chapter ids
 * (append is idempotent), retry-after-crash (reserve is attempt-keyed, so the
 * same `sourceSession@ceiling` reuses its numbers — archive.ts depends on it).
 *
 * Numbering is per-author-session (invariant: chapters keyed by creating
 * session, so siblings cannot collide), and the flat index is built by the
 * PLUGIN walking the ancestor path — the model never traverses a graph.
 */
import type { ChapterRecord } from './archive.ts'

import type { CollectionSignature } from './signature.ts'

export interface SessionState {
  /** Registry-level parent, set at continuation commit. null until linked. */
  parentSession: string | null
  /** Root of the ancestry tree; the store directory key. Self for a root session. */
  rootSession: string
  /** Next unallocated chapter number for THIS author session. */
  nextChapterNumber: number
  chapters: ChapterRecord[]
  /** attemptKey -> numbers, so an idempotent retry reuses rather than duplicates. */
  reservations: Record<string, number[]>
  /**
   * compactionId -> the plan summarize() committed to: the TOC text already
   * cited `path`, so finalize (possibly after a crash and process restart)
   * must reproduce it exactly. Rebuilding the title from messages is not
   * available post-commit — this manifest is the durable bridge.
   */
  plans: Record<string, { number: number; path: string; title: string; summary: string }>
  /**
   * compactionId -> chapter numbers, written when a compaction's chapter bodies
   * are durably finalized post-commit. Idempotence key for the finalizer and
   * the reconciliation scan (FINDINGS § correlation seam).
   */
    finalized: Record<string, number[]>
  /**
   * Per-turn deterministic signatures, appended at turn/end (knowledge-repo
   * §4.1). The composer (§4.2) reads these at archive time; P2 enrichment may
   * relabel later but never rewrites them. Append-only like chapters.
   */
  collections: CollectionSignature[]
}

export const freshSession = (sessionId: string): SessionState => ({
  parentSession: null,
  rootSession: sessionId,
  nextChapterNumber: 1,
  collections: [],
  chapters: [],
  reservations: {},
  plans: {},
  finalized: {},
})

/** Persist a summarize-time plan so finalization survives a restart. */
export function rememberPlan(
  state: SessionState,
  compactionId: string,
  plan: { number: number; path: string; title: string; summary: string },
): SessionState {
  return { ...state, plans: { ...state.plans, [compactionId]: plan } }
}

/** Record a post-commit finalization for one compaction. Same write twice is a no-op. */
export function markFinalized(state: SessionState, compactionId: string, numbers: readonly number[]): SessionState {
  if (state.finalized[compactionId] !== undefined) return state
  return { ...state, finalized: { ...state.finalized, [compactionId]: [...numbers] } }
}

/** True when a compaction's chapters are already committed (finalizer + scan use this). */
export const isFinalized = (state: SessionState, compactionId: string): boolean =>
  state.finalized[compactionId] !== undefined

/** Immutably updated copy with `n` numbers reserved for `attemptId`. */
export function reserve(state: SessionState, attemptId: string, count: number): { state: SessionState; numbers: number[] } {
  if (count <= 0 || !Number.isInteger(count)) {
    throw new Error(`reserve: count must be a positive integer, got ${count}`)
  }
  const existing = state.reservations[attemptId]
  if (existing !== undefined) {
    if (existing.length !== count) {
      // Same attempt, different size: the caller's chapter set changed under a
      // half-finished attempt. Reusing a shorter list would silently drop
      // chapters; growing would collide. Refuse — never guess.
      throw new Error(`reserve: attempt "${attemptId}" already holds ${existing.length} numbers, requested ${count}`)
    }
    return { state, numbers: [...existing] }
  }
  const numbers = Array.from({ length: count }, (_, i) => state.nextChapterNumber + i)
  return {
    state: {
      ...state,
      nextChapterNumber: state.nextChapterNumber + count,
      reservations: { ...state.reservations, [attemptId]: numbers },
    },
    numbers,
  }
}

/** Append verified chapter records. A record with an existing (number) identity is a no-op — retries are safe. */
export function appendChapters(state: SessionState, records: readonly ChapterRecord[]): SessionState {
  const known = new Set(state.chapters.map((c) => c.number))
  const fresh = records.filter((r) => !known.has(r.number))
  if (fresh.length === 0) return state
  return { ...state, chapters: [...state.chapters, ...fresh] }
}

/**
 * Commit point for a continuation: the child inherits the PARENT's root and
 * gets its direct parent recorded. Set once, never rewritten — re-pointing a
 * linked session would silently re-home every chapter below it. Same link
 * twice is a no-op (retry safety); a DIFFERENT link is corruption or a bug,
 * and it throws.
 */
export function linkChild(state: SessionState, parentSessionId: string, parentRootSession: string): SessionState {
  if (state.parentSession !== null) {
    if (state.parentSession === parentSessionId && state.rootSession === parentRootSession) return state
    throw new Error(
      `linkChild: session already linked to parent ${state.parentSession} (root ${state.rootSession});`
      + ` refusing rewrite to parent ${parentSessionId} (root ${parentRootSession})`,
    )
  }
  return { ...state, parentSession: parentSessionId, rootSession: parentRootSession }
}

/**
 * Walk parent links root-first. Throws on a cycle or a missing parent — both
 * are registry corruption, and an infinite walk is how a small bad write
 * becomes a hung plugin at the worst moment.
 */
export function ancestorPath(get: (id: string) => SessionState | undefined, sessionId: string, maxDepth = 1000): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = sessionId
  while (cursor !== undefined) {
    if (seen.has(cursor)) throw new Error(`ancestorPath: cycle through ${cursor}`)
    if (seen.size >= maxDepth) throw new Error(`ancestorPath: exceeded depth ${maxDepth}`)
    seen.add(cursor)
    const state = get(cursor)
    if (state === undefined) {
      if (cursor === sessionId) return [cursor] // unregistered root: itself is the path
      throw new Error(`ancestorPath: missing state for parent ${cursor} (registry corruption)`)
    }
    path.unshift(cursor)
    cursor = state.parentSession ?? undefined
  }
  return path
}

export interface IndexEntry {
  /** Session that authored the chapter, for back-links. */
  authorSession: string
  number: number
  path: string
  title: string
  summary: string
  /** Integrity verdict supplied by the caller (verifyChapter via its fs port). */
  status: 'ok' | 'modified' | 'missing'
}

/**
 * The flat, chronological, numbered index the TOC renders — reading order IS
 * causal order (docs/architecture.md § Ancestry). Ancestor sessions first;
 * within a session, by reserved number. Siblings are excluded by construction:
 * the walk never enters them.
 */
export function buildIndex(
  path: readonly string[],
  get: (id: string) => SessionState | undefined,
  status: (record: ChapterRecord) => IndexEntry['status'],
): IndexEntry[] {
  const entries: IndexEntry[] = []
  for (const sessionId of path) {
    const state = get(sessionId)
    if (state === undefined) continue
    for (const chapter of [...state.chapters].sort((a, b) => a.number - b.number)) {
      entries.push({
        authorSession: sessionId,
        number: chapter.number,
        path: chapter.path,
        title: chapter.title,
        summary: chapter.summary,
        status: status(chapter),
      })
    }
  }
  return entries
}

/** Append one turn's signature. Idempotent per turn (same seqs → no-op), like appendChapters. */
export function appendCollection(state: SessionState, sig: CollectionSignature): SessionState {
  const last = state.collections[state.collections.length - 1]
  if (last !== undefined && last.seqs.length === sig.seqs.length && last.seqs.every((q, i) => q === sig.seqs[i])) return state
  return { ...state, collections: [...state.collections, sig] }
}
