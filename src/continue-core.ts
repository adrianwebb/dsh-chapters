/**
 * chapters_continue — pure orchestration of a citation-linked continuation,
 * behind ports (docs/development.md § L0: this file imports no cordis and no
 * @deepseek-ai package; `src/tools.ts` adapts it).
 *
 * Order is the atomicity contract (docs/architecture.md § Atomicity):
 * validate ranges -> reserve -> write+verify files -> assemble the notice ->
 * budget preflight -> CREATE the child -> commit registry links. A crash before
 * creation leaves orphan files (harmless, numbers already spent); creation
 * without the commit is retried idempotently via attemptKey + linkChild.
 *
 * Budget honesty: allowance is a share of the window REMAINING after the
 * header, never of the whole window; the header is bounded by the last real
 * request's full prompt (conservative — over-counting errs toward loud
 * refusals, which is the designed direction). No usage yet -> the probe says
 * `headerBoundTokens: null` and the allowance conservatively assumes a zero
 * header only because a session with no requests cannot have a large TOC.
 */
import type { ChapterRange, RenderConfig, SessionEventLike, ToolResultOverride } from './types.ts'
import { chapterTopics } from './signature.ts'
import { estimateTokens, renderChapter, validateRanges } from './render.ts'
import { attemptKey, coverage, verifyChapter, writeArchive } from './archive.ts'
import type { ChapterRecord } from './archive.ts'
import { appendChapters, freshSession, linkChild, reserve } from './registry.ts'
import type { SessionState } from './registry.ts'
import { buildTocNotice } from './notice.ts'
import { deriveIdentity } from './engine-core.ts'

export interface ContinueArgs {
  callerSessionId: string
  /** The caller's own preset id, resolved by the adapter from its session observation. */
  callerPreset: string | null
  title: string
  handoffNote: string
  chapters: ChapterRange[]
  toolResultOverrides: ToolResultOverride[]
  /**
   * The knowledge-project line for the notice (record §8): `Project: <slug> ·
   * <key>` plus the search instruction. Set by the adapter from the linked
   * project; absent → the notice simply omits the section.
   */
  projectLine?: string
}

export interface ContinueConfig extends RenderConfig {
  artifactStoreRoot: string
  continuationBudgetRatio: number
  fallbackPreset: string
  /** Topic-sequential composition (record §4.2): merge while overlap ≥ τ. */
  mergeThreshold: number
  /** Estimated-token cap per composed chapter. */
  chapterLimit: number
}

export interface BudgetProbe {
  windowTokens: number | null
  headerBoundTokens: number | null
}

export interface ContinuePorts {
  /** The caller's durable events, oldest first (full log; the ceiling trims it). */
  readCallerEvents(): Promise<SessionEventLike[]>
  getState(sessionId: string): Promise<SessionState>
  putState(sessionId: string, state: SessionState): Promise<void>
  /** ArchiveFs anchored at the caller's workspace cwd (the read tool reaches it). */
  fs(): import('./archive.ts').ArchiveFs
  budgetProbe(): Promise<BudgetProbe>
  newId(): string
  /** agents.create + setup-mount + workspace attach; throws on kernel refusal. */
  createChild(input: {
    sessionId: string
    noticeEvent: SessionEventLike
    presetId: string
    title: string
  }): Promise<void>
  now(): number
}

export interface ContinueResult {
  ok: boolean
  childSessionId?: string
  presetUsed?: string
  chapters?: Array<{ number: number; path: string; startSeq: number; endSeq: number }>
  warnings?: string[]
  /** Numbers behind every outcome — AGENTS: refuse WITH the numbers. */
  budget?: { usedTokens: number; allowanceTokens: number; windowTokens: number | null; headerBoundTokens: number | null }
  reason?: string
}

export class Refusal extends Error {
  readonly result: ContinueResult
  constructor(result: ContinueResult) {
    super(result.reason ?? 'refused')
    this.result = result
  }
}

export interface NoticeEntry {
  number: number
  path: string
  title: string
  summary: string
  status: 'ok' | 'modified' | 'missing'
}

/** The child's whole content: honest preamble, in-flight note, flat index, back-links. */
export function assembleNotice(input: {
  title: string
  handoffNote: string
  entries: readonly NoticeEntry[]
  rootSession: string
  parentSession: string
  storeRoot: string
  projectLine?: string
}): string {
  const lines = [
    `# Continuation: ${input.title}`,
    ...(input.projectLine !== undefined && input.projectLine !== '' ? ['', input.projectLine] : []),
    '',
    'This session continues an archived conversation. Chapters are verbatim Markdown in the workspace;',
    'every byte remains retrievable — inline, or at artifact paths cited inside a chapter. Read a chapter',
    'by its path with the read tool when the detail matters. The previous session stays intact.',
    '',
    '## In flight',
    input.handoffNote.trim().length > 0 ? input.handoffNote.trim() : '(none stated)',
    '',
    '## Chapters',
  ]
  for (const e of input.entries) {
    const mark = e.status === 'ok' ? '' : ` ⚠ ${e.status} since archived`
    lines.push(`${e.number}. [${e.title}](${e.path}) — ${e.summary}${mark}`)
  }
  lines.push('', `Ancestry: root ${input.rootSession}; parent ${input.parentSession}; archive under ${input.storeRoot}/.`)
  return lines.join('\n')
}

/** The budget formula with its refusal numbers, kept apart for direct testing. */
export function preflight(input: {
  noticeTokens: number
  budget: BudgetProbe
  ratio: number
}): { ok: true; budget: NonNullable<ContinueResult['budget']> } | { ok: false; budget: NonNullable<ContinueResult['budget']> } {
  const window = input.budget.windowTokens
  if (window === null) {
    const budget = { usedTokens: input.noticeTokens, allowanceTokens: 0, windowTokens: null, headerBoundTokens: input.budget.headerBoundTokens }
    return { ok: false, budget }
  }
  const remaining = Math.max(0, window - (input.budget.headerBoundTokens ?? 0))
  const allowance = Math.floor(remaining * input.ratio)
  const budget = { usedTokens: input.noticeTokens, allowanceTokens: allowance, windowTokens: window, headerBoundTokens: input.budget.headerBoundTokens }
  return input.noticeTokens <= allowance ? { ok: true, budget } : { ok: false, budget }
}

/** Ancestor ids root-first, via registry links; cycles refuse, never hang. */
async function ancestryPath(ports: ContinuePorts, sessionId: string, limit = 1000): Promise<string[]> {
  const walk: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = sessionId
  while (cursor !== null) {
    if (seen.has(cursor) || walk.length >= limit) throw new Refusal({ ok: false, reason: `registry ancestry cycle/limit at ${cursor}` })
    seen.add(cursor)
    walk.unshift(cursor)
    cursor = (await ports.getState(cursor)).parentSession
  }
  return walk
}

export async function runContinue(
  ports: ContinuePorts,
  args: ContinueArgs,
  config: ContinueConfig,
): Promise<ContinueResult> {
  // ---- 1. Facts: ceiling and ranges.
  const allEvents = await ports.readCallerEvents()
  const lastTurnEnd = [...allEvents].reverse().find((e) => e.type === 'turn/end')
  if (lastTurnEnd === undefined) {
    throw new Refusal({ ok: false, reason: 'no completed turn to archive — the conversation has not reached a turn/end boundary' })
  }
  const ceiling = lastTurnEnd.seq
  try {
    validateRanges(args.chapters, ceiling)
  } catch (error) {
    throw new Refusal({ ok: false, reason: `ranges refused: ${(error as Error).message}` })
  }
  const below = allEvents.filter((e) => e.seq <= ceiling)
  const gaps = coverage(args.chapters, ceiling).gaps
  const warnings: string[] = gaps.map(
    (g) => `seqs ${g.from}-${g.to} fall outside the supplied ranges — NOT archived (gaps are reported, never silent)`,
  )

  // ---- 2. Render + reserve + write (idempotent per attempt key).
  const callerState = await ports.getState(args.callerSessionId)
  const renderConfig: RenderConfig = {
    toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
    chapterTokenTarget: config.chapterTokenTarget,
  }
  const rendered = args.chapters.map((range) => renderChapter(below, range, renderConfig, args.toolResultOverrides, chapterTopics(below, range.startSeq, range.endSeq)))
  warnings.push(...rendered
    .filter((r) => r.stats.overTarget)
    .map((r) => `chapter "${r.range.title}" is ${r.stats.estimatedTokens} est tokens over chapterTokenTarget — split at the next continuation, never clip`))
  const fs = ports.fs()
  const wrote = await writeArchive({
    fs,
    allocator: {
      async reserve(attemptId, count) {
        const fresh = await ports.getState(args.callerSessionId)
        const r = reserve(fresh, attemptId, count)
        await ports.putState(args.callerSessionId, r.state)
        return r.numbers
      },
    },
    storeRoot: config.artifactStoreRoot,
    rootSessionId: callerState.rootSession,
    chapters: rendered,
    attemptId: attemptKey(args.callerSessionId, ceiling),
  })
  warnings.push(...wrote.warnings)

  // ---- 3. Cumulative flat index over the ancestor path, integrity-verified.
  const entries = await collectEntries(ports, args.callerSessionId, wrote.records, warnings)

  // ---- 4/5. Notice + budget gate, create the child, commit.
  return await finishChild(ports, config, args, callerState, entries, warnings, wrote.records)
}

/** Ancestors' committed records (root-first) plus fresh records; verified, numbered for display. */
async function collectEntries(
  ports: ContinuePorts,
  callerSessionId: string,
  freshRecords: readonly ChapterRecord[],
  warnings: string[],
): Promise<NoticeEntry[]> {
  const fs = ports.fs()
  const pathIds = await ancestryPath(ports, callerSessionId)
  const priorRecords: ChapterRecord[] = []
  for (const id of pathIds) {
    const st = await ports.getState(id)
    // Registry order is insertion order = authoring order within a session;
    // sessions walk root-first, so reading order IS causal order.
    priorRecords.push(...st.chapters)
  }
  const seenPaths = new Set<string>()
  const cited: ChapterRecord[] = []
  for (const record of [...priorRecords, ...freshRecords]) {
    if (seenPaths.has(record.path)) continue // a retry re-wrote the same path: cite once
    seenPaths.add(record.path)
    cited.push(record)
  }
  const entries: NoticeEntry[] = []
  for (const record of cited) {
    const status = await verifyChapter(fs, record)
    if (status !== 'ok') warnings.push(`${record.path}: ${status} since archived — marked in the TOC, not silently trusted`)
    entries.push({ number: entries.length + 1, path: record.path, title: record.title, summary: record.summary, status })
  }
  return entries
}

/** Fields both continue and fork need to create the child. */
export type FinishArgs = Pick<ContinueArgs, 'callerSessionId' | 'callerPreset' | 'title' | 'handoffNote'>

/** Shared tail of both flows: notice -> budget gate -> create (invariant 2) -> commit. */
async function finishChild(
  ports: ContinuePorts,
  config: ContinueConfig,
  args: FinishArgs,
  callerState: SessionState,
  entries: readonly NoticeEntry[],
  warnings: string[],
  commitRecords: readonly ChapterRecord[],
): Promise<ContinueResult> {
  // ---- Notice text, then the budget gate (measure the WHOLE notice).
  const noticeText = assembleNotice({
    title: args.title,
    handoffNote: args.handoffNote,
    entries,
    rootSession: callerState.rootSession,
    parentSession: args.callerSessionId,
    storeRoot: config.artifactStoreRoot,
  })
  const budget = preflight({
    noticeTokens: estimateTokens(noticeText),
    budget: await ports.budgetProbe(),
    ratio: config.continuationBudgetRatio,
  })
  if (!budget.ok) {
    throw new Refusal({
      ok: false,
      reason: budget.budget.windowTokens === null
        ? 'cannot resolve the model context window for this caller — refusing to create an unbounded continuation (check agentDefaultModel selection / adapter metadata)'
        : `continuation over budget: notice ~${budget.budget.usedTokens} tokens > allowance ${budget.budget.allowanceTokens} (${config.continuationBudgetRatio} × (window ${budget.budget.windowTokens} − header bound ${budget.budget.headerBoundTokens ?? 'unmeasured'})). Shorten the handoff note or split the archive.`,
      budget: budget.budget,
      warnings,
    })
  }

  // ---- Create the child (one synthetic event at seq 0 — invariant 2), then commit.
  const noticeEvent = buildTocNotice(noticeText, { newId: ports.newId, time: ports.now() })
  const childId = `ch-${ports.newId()}`
  const presetId = args.callerPreset ?? config.fallbackPreset
  try {
    await ports.createChild({ sessionId: childId, noticeEvent, presetId, title: args.title })
  } catch (error) {
    throw new Refusal({ ok: false, reason: `child creation refused: ${(error as Error).message}`, warnings })
  }
  if (commitRecords.length > 0) {
    const callerFresh = await ports.getState(args.callerSessionId)
    await ports.putState(args.callerSessionId, appendChapters(callerFresh, commitRecords))
  }
  await ports.putState(childId, linkChild(freshSession(childId), args.callerSessionId, callerState.rootSession))

  return {
    ok: true,
    childSessionId: childId,
    presetUsed: presetId,
    chapters: commitRecords.map((r) => ({ number: r.number, path: r.path, startSeq: r.startSeq, endSeq: r.endSeq })),
    warnings,
    budget: budget.budget,
  }
}

/**
 * chapters_fork: open a sibling line citing the SAME archive, archiving nothing
 * new. The point is branching (AGENTS "branchable — history can fork, not
 * just truncate"): parent and child keep working independently; no files are
 * written and no numbers reserved, so a fork is cheap and cannot orphan a
 * citation it did not already exist.
 */
export interface ForkArgs extends FinishArgs {}

export async function runFork(
  ports: ContinuePorts,
  args: ForkArgs,
  config: ContinueConfig,
): Promise<ContinueResult> {
  const warnings: string[] = []
  const callerState = await ports.getState(args.callerSessionId)
  const entries = await collectEntries(ports, args.callerSessionId, [], warnings)
  return await finishChild(ports, config, args, callerState, entries, warnings, [])
}

/**
 * Deterministic segmentation: split [0..anchorSeq] into chapter ranges WITHOUT
 * any model call — the fork-button backend (a button cannot wait for proposed
 * ranges, and auto mode must never paraphrase: invariant 4 holds, only
 * positions are computed here; titles/summaries derive from content lines).
 * Cuts land ONLY on `turn/end` boundaries; a segment closes at the first
 * boundary reaching ~90% of chapterTokenTarget, so overshoot is bounded.
 */
export function deriveRanges(
  events: readonly SessionEventLike[],
  anchorSeq: number,
  chapterTokenTarget: number,
  fromSeq = 0,
): { chapters: ChapterRange[]; notes: string[] } {
  const upto = events.filter((e) => e.seq <= anchorSeq)
  const boundaries = upto.filter((e) => e.type === 'turn/end' && e.seq >= fromSeq).map((e) => e.seq)
  if (boundaries.length === 0) {
    throw new Refusal({ ok: false, reason: fromSeq > 0
      ? `nothing new to archive: every completed turn at or before seq ${anchorSeq} is already in the archive (watermark ${fromSeq - 1})`
      : `no completed turn at or before seq ${anchorSeq} — nothing to branch from yet` })
  }
  const last = boundaries[boundaries.length - 1]!
  const notes: string[] = []
  if (last !== anchorSeq) {
    notes.push(`anchor ${anchorSeq} is not a turn boundary: segmentation ran to ${last}; later events belong to an unfinished turn (describe them in the handoff note)`)
  }
  const tokensBetween = (lo: number, hi: number): number => upto
    .filter((e) => e.seq >= lo && e.seq <= hi)
    .reduce((n, e) => n + Math.ceil(JSON.stringify(e.data ?? {}).length / 4), 0)

  const chapters: ChapterRange[] = []
  const cut = Math.max(1, Math.floor(chapterTokenTarget * 0.9))
  let start = fromSeq
  for (const b of boundaries) {
    const isLast = b === last
    if (isLast || tokensBetween(start, b) >= cut) {
      const seg = upto.filter((e) => e.seq >= start && e.seq <= b)
      const msgs: EngineMessageView[] = seg
        .filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
        .map((e) => {
          const d = e.data as { content?: { type: string; text?: string }[] } | undefined
          return { role: e.type === 'assistant/message' ? 'assistant' : 'user', content: d?.content ?? [] }
        })
      const identity = deriveIdentity(msgs, seg.some((e) => JSON.stringify(e.data ?? '').includes('<compacted-summary>')))
      chapters.push({
        title: `${identity.title} (${chapters.length + 1})`,
        summary: `events ${start}-${b}; ${identity.summary}`,
        startSeq: start,
        endSeq: b,
      })
      start = b + 1
    }
  }
  return { chapters, notes }
}

/** Structural view of the provider Message for deriveIdentity reuse. */
interface EngineMessageView {
  readonly role: string
  readonly content: readonly { type: string; text?: string }[]
}


/** The adapter surfaces refusals as tool output, never as crashes. */
export function refusalResult(error: unknown): ContinueResult | null {
  return error instanceof Refusal ? error.result : null
}
