/**
 * Engine core — the deterministic logic behind ChaptersCompactionEngine, as
 * pure functions over minimal structural types. NO cordis, NO @deepseek-ai
 * imports: this file runs under `node --test` with no harness, which is where
 * the two scariest engine-path bugs get caught — a lost TOC bullet (silently
 * unreachable chapter) and a mis-resolved citation (wrong text archived).
 *
 * The correlation model (docs/host-compaction-seam.md + FINDINGS § Phase 0b):
 *   summarize()  — sees region CONTENT (no seqs); reserves numbers keyed by the
 *                  OPEN transaction's compactionId (found by scanning the log:
 *                  the last `compaction/start` without a matching `end` — the
 *                  durable lock guarantees uniqueness) and emits the TOC text
 *                  citing deterministic paths.
 *   finalize()   — post-commit, from authoritative CompactionResult.shadowedSeqs,
 *                  renders bodies from the DURABLE LOG, following each
 *                  `tool/result` replacement's `sourceEventSeqs` chain back to
 *                  the pre-prune original. Never from summarize's input.
 *
 * Checkpoint merge-forward: the next compaction's span usually includes the
 * previous checkpoint node (r12 measured it). Its TOC bullets are extracted
 * and re-emitted; an embedded LLM-style summary (a host `basic` checkpoint
 * from before this engine was mounted) is carried verbatim ONCE — honest,
 * bounded, and never silently dropped.
 */
import type { RenderedChapter } from './types.ts'
import type { SessionEventLike } from './types.ts'
import type { ChapterRecord } from './archive.ts'
import { estimateTokens, renderChapter, renderIndex } from './render.ts'
import { slugify } from './archive.ts'
import type { SessionState } from './registry.ts'

/** provider tag written into `compaction/summary` — our event-scan discriminator. */
export const CHAPTERS_PROVIDER = 'dsh-chapters'
export const DETERMINISTIC_MODEL = 'deterministic'

/** Framing tags the host's summarizer wraps checkpoints in (compaction-basic summarizer.ts:21-22). */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** One TOC bullet, as re-parsed from prior checkpoints — the accumulation unit. */
export interface TocBullet {
  title: string
  path: string
  summary: string
}

export interface EngineConfig {
  /** Workspace-relative archive root; must be reachable by the `read` tool. */
  artifactStoreRoot: string
  chapterTokenTarget: number
  toolResultDeferFloorTokens: number
}

export const ENGINE_CONFIG_DEFAULTS: EngineConfig = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
}

// ---------------------------------------------------------------- input/output vocabulary
// Structural restatements of @deepseek-ai/dsh-compaction-basic's SummarizationInput /
// SummaryResult (the npm package does not export those types from its root entry).
// test/engine-core.test.ts drift-guards them against the installed d.ts.

export interface SummarizeInputLike {
  readonly tools?: readonly unknown[]
  readonly messages: readonly EngineMessage[]
}

export interface EngineMessage {
  readonly role: string
  readonly content?: readonly { type: string; text?: string }[]
}

export interface SummarizeResultLike {
  summary: { type: 'text'; text: string }[]
  provider: string
  model: string
}

// ---------------------------------------------------------------- minimal session surface

/** The slice of `Session` the core reads. Kept small so fakes are honest. */
export interface EngineSession {
  readonly id: string
  readonly seq: number
  eventAt(seq: number): EngineSessionEvent | undefined
}

export interface EngineSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly sourceEventSeqs?: readonly number[]
  readonly data?: Record<string, unknown>
}

// ---------------------------------------------------------------- text helpers

const messageText = (msg: EngineMessage | undefined): string =>
  (msg?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')

/** Every `<compacted-summary>…</compacted-summary>` block in the region, in order. */
export function extractCheckpointBlocks(messages: readonly EngineMessage[]): string[] {
  const blocks: string[] = []
  for (const msg of messages) {
    const text = messageText(msg)
    let from = 0
    for (;;) {
      const open = text.indexOf(SUMMARY_OPEN_TAG, from)
      if (open === -1) break
      const close = text.indexOf(SUMMARY_CLOSE_TAG, open)
      if (close === -1) { blocks.push(text.slice(open + SUMMARY_OPEN_TAG.length)); break }
      blocks.push(text.slice(open + SUMMARY_OPEN_TAG.length, close))
      from = close + SUMMARY_CLOSE_TAG.length
    }
  }
  return blocks
}

/** `N. [Title](path) — summary` as rendered by renderIndex; the accumulation format. */
const BULLET = /^\s*\d+\.\s+\[(.*?)\]\((.*?)\)\s+—\s+(.*)$/

/**
 * Merge-forward: parse prior bullets out of every checkpoint block. Lines that
 * are not our bullet format (e.g. an LLM summary produced by `basic` before
 * this engine took over) are returned as verbatim carry-overs — dropping them
 * would be exactly the loss this plugin exists to prevent.
 */
export function parseTocState(blocks: readonly string[]): {
  bullets: TocBullet[]
  carriedProse: string[]
} {
  const bullets: TocBullet[] = []
  const carriedProse: string[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    let blockHadBullets = false
    for (const line of block.split('\n')) {
      const m = BULLET.exec(line)
      if (m === null) continue
      blockHadBullets = true
      const bullet = { title: m[1]!, path: m[2]!, summary: m[3]! }
      if (seen.has(bullet.path)) continue // accumulation dedups by path; numbers may repeat across roots
      seen.add(bullet.path)
      bullets.push(bullet)
    }
    if (!blockHadBullets && block.trim().length > 0) carriedProse.push(block.trim())
  }
  return { bullets, carriedProse }
}

// ---------------------------------------------------------------- transaction scanning

/**
 * The open transaction's compactionId: the latest `compaction/start` with no
 * later `compaction/end` carrying the same id. The base appends the start
 * BEFORE awaiting summarize (region.ts:211) and the durable lock admits only
 * one open transaction per session — so a backward scan finds exactly it.
 */
export function findOpenCompactionId(session: EngineSession): string | null {
  const closed = new Set<string>()
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const ev = session.eventAt(seq)
    const raw = ev?.data?.compactionId
    const cid = typeof raw === 'string' && raw.length > 0 ? raw : null
    if (ev?.type === 'compaction/end' && cid !== null) { closed.add(cid); continue }
    if (ev?.type === 'compaction/start' && cid !== null && !closed.has(cid)) return cid
  }
  return null
}

/** All OUR finalized-or-not summary events (provider-tagged), oldest first. */
export function scanChaptersSummaries(session: EngineSession): Array<{ compactionId: string; summarySeq: number; shadowedSeqs: number[] }> {
  const out: Array<{ compactionId: string; summarySeq: number; shadowedSeqs: number[] }> = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const ev = session.eventAt(seq)
    if (ev?.type !== 'compaction/summary') continue
    if (ev.data?.provider !== CHAPTERS_PROVIDER) continue
    const cid = ev.data?.compactionId
    const shadowed = ev.data?.shadowedSeqs
    if (typeof cid !== 'string' || !Array.isArray(shadowed)) continue
    out.push({ compactionId: cid, summarySeq: seq, shadowedSeqs: shadowed.map(Number) })
  }
  return out
}

// ---------------------------------------------------------------- citation resolution

/**
 * Follow `tool/result` replacement chains to the first version (the un-pruned
 * original). Only single-cited tool results qualify — a compaction checkpoint
 * `user/message` also carries sourceEventSeqs, and following THOSE would pull
 * lifecycle bookkeeping into chapter bodies.
 */
export function resolveOriginalEvent(session: EngineSession, seq: number): EngineSessionEvent | undefined {
  let cursor = seq
  const guard = new Set<number>()
  for (;;) {
    if (guard.has(cursor)) throw new Error(`resolveOriginalEvent: citation cycle at seq ${cursor}`)
    guard.add(cursor)
    const ev = session.eventAt(cursor)
    if (ev === undefined) throw new Error(`resolveOriginalEvent: missing event at ${cursor}`)
    if (ev.type !== 'tool/result') return ev
    const cited = ev.sourceEventSeqs
    if (cited === undefined || cited.length !== 1) return ev
    cursor = cited[0]!
  }
}

// ---------------------------------------------------------------- planning

export interface SummarizePlan {
  /** TOC text for the checkpoint (what summarize returns). */
  tocText: string
  /** Chapter numbers reserved during planning — attemptId `compaction:${id}`. */
  numbers: number[]
  /** Everything finalize needs, since finalize cannot re-derive the title. */
  chapter: { title: string; summary: string; path: string }
}

const HARNESS_PROSE = /^\s*(<system-reminder>|system reminder\b|current runtime context\.|\[workspace instructions?\b|this session is running under)/i

/** Deterministic title/summary from region content. Never model-authored (invariant 4 — the model is absent). */
export function deriveIdentity(messages: readonly EngineMessage[], hasCheckpoint: boolean): { title: string; summary: string } {
  // Title source: the first USER message that is actual human/agent prose.
  // Harness injections (system reminders, runtime-context snapshots) ride as
  // user messages too — an earlier fork titled a chapter "System reminder 1"
  // from a runtime snapshot that happened to open the span. Skip them; the
  // r29 command tests pin this behavior.
  const firstUser = messages.find((m) => m.role === 'user'
    && !messageText(m).includes(SUMMARY_OPEN_TAG)
    && !HARNESS_PROSE.test(messageText(m).trimStart()))
  const userCount = messages.filter((m) => m.role === 'user').length
  const assistantCount = messages.filter((m) => m.role === 'assistant').length
  const headLine = firstUser === undefined ? '' : messageText(firstUser).split('\n')[0]!.trim()
  const title = headLine.length > 0
    ? headLine.length > 72 ? `${headLine.slice(0, 72)}…` : headLine
    : hasCheckpoint ? 'Earlier history' : 'Conversation span'
  return {
    title,
    summary: `${userCount} user / ${assistantCount} assistant messages (${estimateTokens(
      messages.map(messageText).join(' '),
    )} est tokens)`,
  }
}

/** Workspace-relative chapter path for a reserved number. */
export const chapterPathFor = (config: EngineConfig, rootSession: string, number: number, title: string): string =>
  `${config.artifactStoreRoot.replace(/\/+$/, '')}/${rootSession}/chapters/${String(number).padStart(3, '0')}-${slugify(title)}.md`

/**
 * The summarize-time plan: merge prior bullets, derive this span's identity,
 * reserve numbers (attempt-keyed by the OPEN transaction's compactionId),
 * build the TOC. Pure given the state; the caller persists the returned
 * state change BEFORE this text can ever be cited.
 */
export function planSummarize(
  session: EngineSession,
  state: SessionState,
  input: SummarizeInputLike,
  config: EngineConfig,
  reserveFn: (state: SessionState, attemptId: string, count: number) => { state: SessionState; numbers: number[] },
  /** Required: the caller fails loudly when no `compaction/start` is open. */
  compactionId: string,
): { plan: SummarizePlan; state: SessionState } {
  const blocks = extractCheckpointBlocks(input.messages)
  const { bullets, carriedProse } = parseTocState(blocks)
  const identity = deriveIdentity(input.messages, blocks.length > 0)

  const attemptId = `compaction:${compactionId}`
  const reserved = reserveFn(state, attemptId, 1)
  const number = reserved.numbers[0]!
  const path = chapterPathFor(config, state.rootSession, number, identity.title)

  const allBullets = [...bullets, { title: identity.title, path, summary: identity.summary }]
  const index = renderIndex(allBullets)
  const quote = (p: string): string => p.split('\n').map((l) => `> ${l}`).join('\n')
  const parts: string[] = [
    `Chapter archive: ${allBullets.length} chapter(s) under ${config.artifactStoreRoot}/ — verbatim text; reload any with the read tool on its path.`,
    'Tool results shown as head+…+tail in the replaced history were archived in full; oversized ones are file references inside the chapter.',
    index,
  ]
  if (carriedProse.length > 0) {
    parts.push('Earlier summary carried forward (not chapter-formatted):', ...carriedProse.map(quote))
  }
  const tocText = parts.join('\n\n')

  return {
    plan: {
      tocText,
      numbers: reserved.numbers,
      chapter: { title: identity.title, summary: identity.summary, path },
    },
    state: reserved.state,
  }
}

// ---------------------------------------------------------------- finalization

/**
 * Post-commit: render the chapter body for one compaction from the durable
 * log (citation-resolved), and return the record to commit. The caller writes
 * files (via archive.writeArchive) and persists state; this stays pure over
 * the event data so the pruner-composition rule is testable.
 */
export function buildFinalizedChapter(
  session: EngineSession,
  shadowedSeqs: readonly number[],
  plan: SummarizePlan,
  config: EngineConfig,
): RenderedChapter {
  const events: SessionEventLike[] = shadowedSeqs.map((seq) => {
    const ev = resolveOriginalEvent(session, seq)
    if (ev === undefined) throw new Error(`buildFinalizedChapter: event vanished at ${seq}`)
    return ev as SessionEventLike
  })
  const startSeq = Math.min(...shadowedSeqs)
  const endSeq = Math.max(...shadowedSeqs)
  return renderChapter(events, {
    title: plan.chapter.title,
    summary: plan.chapter.summary,
    startSeq: Math.min(startSeq, ...events.map((e) => e.seq)),
    endSeq: Math.max(endSeq, ...events.map((e) => e.seq)),
  }, {
    chapterTokenTarget: config.chapterTokenTarget,
    toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
  })
}

/** The registry record shape written post-writeArchive for an engine chapter. */
export function engineRecord(plan: SummarizePlan, shadowedSeqs: readonly number[], rendered: RenderedChapter, writtenPath: string, sha256hex: string): ChapterRecord {
  return {
    number: plan.numbers[0]!,
    path: writtenPath,
    title: plan.chapter.title,
    summary: plan.chapter.summary,
    startSeq: rendered.range.startSeq,
    endSeq: rendered.range.endSeq,
    shadowedSeqs: [...shadowedSeqs],
    sha256: sha256hex,
    estimatedTokens: rendered.stats.estimatedTokens,
    artifacts: rendered.artifacts.map((a) => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })),
  }
}

/** Numbers the plan reserved, or null when the manifest disagrees (corruption). */
export function assertReservationMatchesPlan(state: SessionState, compactionId: string, plan: SummarizePlan): boolean {
  const got = state.reservations[`compaction:${compactionId}`]
  return got !== undefined && got.length === plan.numbers.length && got.every((n, i) => n === plan.numbers[i])
}
