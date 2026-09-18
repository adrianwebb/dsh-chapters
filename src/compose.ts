/**
 * Topic-sequential composition (knowledge-repo.md §4.2–4.4).
 *
 * The user requirement in the record: consecutive message collections that
 * reference the SAME TASK merge into one chapter; a chapter splits only when
 * the task changes (signature overlap < τ) or the chapter outgrows a limit.
 * Greedy, sequential, deterministic — and composed from the per-turn
 * signatures already stored at turn/end (§4.1), so archive time is O(turns).
 *
 * Completeness guard (§4.3): only collections whose turn COMPLETED inside the
 * span are archived; anything cut by a span boundary stays live and is noted,
 * never silently dropped and never silently included.
 *
 * Pure module: events + stored collections + config in, chapter ranges out.
 * The titles/summaries come from deriveIdentity (engine-core) — the same
 * deterministic derivation the rest of the plugin uses; P2 enrichment may
 * relabel later, never re-chapter (append-only, §4.4).
 */
import { deriveIdentity, type EngineMessage } from './engine-core.ts'
import type { CollectionSignature } from './signature.ts'
import type { ChapterRange } from './types.ts'
import type { SessionEventLike } from './types.ts'

export interface ComposeConfig {
  /** Merge threshold τ in [0,1]: collections merge while overlap score ≥ τ. */
  mergeThreshold: number
  /** Estimated-token cap per chapter; overshoot forces a split. */
  chapterLimit: number
}

export interface ComposeResult {
  chapters: ChapterRange[]
  notes: string[]
  /** Span events belonging to turns that did not complete inside the span. */
  unarchivedSeqs: number[]
}

const union = (a: readonly string[], b: readonly string[]): Set<string> => new Set([...a, ...b])
const inter = (a: readonly string[], b: readonly string[]): number => {
  const set = new Set(a)
  return b.reduce((n, v) => n + (set.has(v) ? 1 : 0), 0)
}

/**
 * Overlap score in [0,1]: path matches weigh 2× (same file ≈ same task),
 * command and term matches 1×; denominator is the union, so a collection
 * with mostly NEW signal scores low against the running chapter.
 */
export function signatureScore(a: CollectionSignature, b: CollectionSignature): number {
  const num = 2 * inter(a.paths, b.paths) + inter(a.commands, b.commands) + inter(a.terms, b.terms)
  const den = 2 * union(a.paths, b.paths).size + union(a.commands, b.commands).size + union(a.terms, b.terms).size
  if (den === 0) return 0
  return num / den
}

const messagesOf = (events: readonly SessionEventLike[], lo: number, hi: number): EngineMessage[] =>
  events
    .filter((e) => e.seq >= lo && e.seq <= hi && (e.type === 'user/message' || e.type === 'assistant/message'))
    .map((e) => {
      const d = (e.data ?? {}) as Record<string, unknown>
      const message = (d.message ?? d) as Record<string, unknown>
      const content = Array.isArray(message.content)
        ? (message.content as { type?: string; text?: string }[])
          .filter((b) => b.type === 'text')
          .map((b) => ({ type: 'text', ...(b.text !== undefined ? { text: b.text } : {}) }))
        : []
      return { role: e.type === 'assistant/message' ? 'assistant' : 'user', content }
    })

/**
 * Compose the span [spanStart, spanEnd] of `events` into topic-sequential
 * chapters from `collections` (the session's stored per-turn signatures).
 *
 * Returns no chapters when the span holds no COMPLETED collections — the
 * caller then falls back to its legacy size-based behavior rather than
 * archiving nothing-and-claiming-to.
 */
export function composeChapters(
  events: readonly SessionEventLike[],
  spanStart: number,
  spanEnd: number,
  collections: readonly CollectionSignature[],
  config: ComposeConfig,
): ComposeResult {
  const notes: string[] = []
  const inSpan = (c: CollectionSignature): boolean =>
    c.seqs.length > 0 && c.seqs[0]! >= spanStart && c.seqs[c.seqs.length - 1]! <= spanEnd
  const usable = collections.filter(inSpan).sort((a, b) => a.seqs[0]! - b.seqs[0]!)
  if (usable.length === 0) {
    const unarchived = events.filter((e) => e.seq >= spanStart && e.seq <= spanEnd).map((e) => e.seq)
    notes.push('no completed collections in span — legacy segmentation applies')
    return { chapters: [], notes, unarchivedSeqs: unarchived }
  }

  const covered = new Set<number>(usable.flatMap((c) => c.seqs))
  const unarchivedSeqs = events
    .filter((e) => e.seq >= spanStart && e.seq <= spanEnd && !covered.has(e.seq))
    .map((e) => e.seq)
  if (unarchivedSeqs.length > 0) {
    notes.push(
      `incomplete turn content (seqs ${unarchivedSeqs[0]}..${unarchivedSeqs[unarchivedSeqs.length - 1]}) `
      + 'stays live — a chapter only archives completed turns',
    )
  }

  interface Running { first: CollectionSignature; last: CollectionSignature; paths: Set<string>; commands: Set<string>; terms: Set<string>; size: number; startSeq: number; endSeq: number }
  const runningOf = (c: CollectionSignature): Running => ({
    first: c, last: c, paths: new Set(c.paths), commands: new Set(c.commands), terms: new Set(c.terms),
    size: c.size, startSeq: c.seqs[0]!, endSeq: c.seqs[c.seqs.length - 1]!,
  })
  const scoreAgainst = (c: CollectionSignature, r: Running): number =>
    Math.max(signatureScore(c, r.first), signatureScore(c, r.last))

  const chapters: ChapterRange[] = []
  let running = runningOf(usable[0]!)
  for (const c of usable.slice(1)) {
    const merge = scoreAgainst(c, running) >= config.mergeThreshold && running.size + c.size <= config.chapterLimit
    if (merge) {
      for (const p of c.paths) running.paths.add(p)
      for (const q of c.commands) running.commands.add(q)
      for (const t of c.terms) running.terms.add(t)
      running.size += c.size
      running.last = c
      running.endSeq = c.seqs[c.seqs.length - 1]!
    } else {
      close()
      running = runningOf(c)
    }
  }
  close()

  function close(): void {
    const lo = running.startSeq
    const hi = running.endSeq
    const identity = deriveIdentity(messagesOf(events, lo, hi), false)
    const pathsHint = [...running.paths].slice(0, 3).join(', ')
    chapters.push({
      title: identity.title,
      summary: `${identity.summary}${pathsHint !== '' ? ` · ${pathsHint}` : ''}`,
      startSeq: lo,
      endSeq: hi,
    })
  }
  return { chapters, notes, unarchivedSeqs }
}
