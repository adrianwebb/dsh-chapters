/**
 * ChaptersCompactionEngine — the cordis-facing adapter over the pure
 * engine-core logic. Mounted INSIDE a preset realm's compaction group (never
 * the host plane beside `basic`: two engines double-fire across planes,
 * FINDINGS § Phase 0b), it overrides exactly the sanctioned hook plus the two
 * entry points whose results the finalizer needs.
 *
 * Everything decision-shaped lives in engine-core.ts, where it is
 * harness-free testable. This file is glue: service resolution, durable
 * reads/writes, and the never-break-the-caller containment the base's own
 * listeners already model.
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { extractSignature, turnSpanOf } from './signature.ts'
import { appendCollection } from './registry.ts'
import type { SessionEventLike } from './types.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import {
  CHAPTERS_PROVIDER, DETERMINISTIC_MODEL, buildFinalizedChapter, buildFinalizedChapters,
  findOpenCompactionId, planSummarize, reconstructShadowedSeqs, scanChaptersSummaries,
  type EngineConfig, type EngineSession, type SummarizeInputLike, type SummarizeResultLike,
} from './engine-core.ts'
import { composeChapters } from './compose.ts'
import type { ChapterRange } from './types.ts'
import { appendChapters, isFinalized, markFinalized, rememberPlan, reserve } from './registry.ts'
import type { SessionState } from './registry.ts'
import { acquireChapterStore, makeAllocator, makeArchiveFs, type ChapterStoreHandle } from './store.ts'
import { createSyncScheduler, makeCollectionsReader, projectForCwd, readToken, DEFAULT_CLONE_DIR } from './sync.ts'
import { writeArchive } from './archive.ts'
import type { RegistryStore } from './store.ts'

/** Row config: the base's keys (so realm rows validate) plus the archive's own. */
export interface ChaptersRowConfig extends BasicCompactionConfig {
  artifactStoreRoot?: string
  chapterTokenTarget?: number
  toolResultDeferFloorTokens?: number
  mergeThreshold?: number
  chapterLimit?: number
  syncDebounceMs?: number
}

/**
 * Per-turn deterministic signature listener (knowledge-repo.md §4.1), as a
 * plain factory so the LOGIC is unit-testable against the real host Session
 * shape without a full cordis Service context. Never-break containment: the
 * handler reports through `warn`, it never throws into the session.
 *
 * r28 found the load-bearing fact: the host Session is a CLASS exposing
 * snapshotEvents() — a `.events` property does not exist, and the first cut
 * read `.events`, no-op'd silently in every real boot, and passed its L0
 * test because the test stubbed the shape that does not exist.
 */
export function makeSignatureListener(deps: {
  store: () => Promise<{ store: import('./store.ts').RegistryStore }>
  warn: (error: unknown) => void
  onCollected?: (id: string, sig: { seqs: number[]; paths: string[]; terms: string[]; size: number }) => void
}): (session: unknown, event: unknown) => void {
  // Per-session promise chain: the store write is a read-modify-append, so
  // two turn-ends landing the same tick must serialize or the second put
  // clobbers the first's collection (real sessions are minutes apart, but
  // burst steer/resume exists; the queue makes the listener honest anyway).
  const chains = new Map<string, Promise<void>>()
  return (session, event) => {
    try {
      if ((event as { type?: string })?.type !== 'turn/end') return
      const id = (session as { id?: string } | undefined)?.id
      const events = (session as { snapshotEvents?: () => readonly SessionEventLike[] } | undefined)?.snapshotEvents?.()
      if (id === undefined || events === undefined) return
      const endSeq = (event as { seq?: number }).seq
      if (endSeq === undefined) return
      const span = turnSpanOf(events, endSeq)
      if (span.length === 0) return
      const sig = extractSignature(span)
      deps.onCollected?.(id, sig)
      const job = (): Promise<void> => deps.store().then(({ store }) => {
        const state = store.get(id)
        return state.then((st) => store.put(id, appendCollection(st, sig)))
      }).then(() => undefined).catch(deps.warn)
      const prev = chains.get(id)
      const next = prev === undefined ? job() : prev.then(job)
      chains.set(id, next)
      void next.finally(() => { if (chains.get(id) === next) chains.delete(id) })
    } catch (error) {
      deps.warn(error)
    }
  }
}

/**
 * Pull-on-first-turn (§5.1) as a plain factory, same testability discipline
 * as the signature listener. Process-scoped "first turn seen" — a resumed
 * old session pulling once more is harmless and bounded.
 */
export function makeFirstTurnPullListener(deps: { pull: (cwd: string) => Promise<unknown> }): (session: unknown, event: unknown) => void {
  const pulled = new Set<string>()
  return (session, event) => {
    try {
      if ((event as { type?: string })?.type !== 'turn/start') return
      const id = (session as { id?: string } | undefined)?.id
      const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      if (id === undefined || cwd === undefined || pulled.has(id)) return
      pulled.add(id)
      void deps.pull(cwd).catch(() => undefined)
    } catch {
      // never break the session path (§5.3)
    }
  }
}

export class ChaptersCompactionEngine extends BasicCompactionEngine {
  // Base inject is ['llm','tokenMeter','sessions']; subclassing INHERITS statics,
  // so re-declare with what the chapter flow adds (r12's crash, FINDINGS).
  static inject = ['llm', 'tokenMeter', 'sessions', 'storageDomain']

  static override Config = z.object({
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    // Mirrors the base's modelPolicy shape (compaction-basic/src/index.ts:79-90)
    // exactly: a narrower schema here could strip per-model ratios before
    // super's resolveConfig sees them. Stage 3 probe asserts survival.
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: z.number(),
      retainRatio: z.number(),
      retainTokens: z.number().step(1).min(0),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
    })),
    auto: z.boolean(),
    artifactStoreRoot: z.string(),
    chapterTokenTarget: z.number().step(1).min(1),
    toolResultDeferFloorTokens: z.number().step(1).min(0),
    // The composition knobs ride the same row so the engine path and the fork
    // path honor one configuration (found undeclared 2026-09-18: destructured
    // by the constructor, stripped by the schema).
    mergeThreshold: z.number().default(0.3),
    chapterLimit: z.number().step(1).min(1).default(8000),
    syncDebounceMs: z.number().step(1).min(0).default(30000),
  })

  private readonly chaptersConfig: EngineConfig
  private storePromise: Promise<ChapterStoreHandle> | null = null

  constructor(ctx: Context, config: ChaptersRowConfig = {}) {
    // The base's resolveConfig rejects unknown keys at runtime (measured r18:
    // `BasicCompactionConfig: unknown key "artifactStoreRoot"`) — the archive's
    // own keys are peeled off and held here; the base receives exactly its
    // documented shape. (The loader does not strip them for us either.)
    const {
      artifactStoreRoot, chapterTokenTarget, toolResultDeferFloorTokens,
      mergeThreshold, chapterLimit, syncDebounceMs, ...baseConfig
    } = config
    super(ctx, baseConfig)
    this.chaptersConfig = {
      artifactStoreRoot: artifactStoreRoot ?? '.dsh-chapters',
      chapterTokenTarget: chapterTokenTarget ?? 8000,
      toolResultDeferFloorTokens: toolResultDeferFloorTokens ?? 200,
      mergeThreshold: mergeThreshold ?? 0.3,
      chapterLimit: chapterLimit ?? 8000,
    }
    this.syncDebounceMs = syncDebounceMs ?? 30000
    this.#listenForSignatures()
    this.#listenForFirstTurnPull()
    ctx.logger?.info?.('dsh-chapters: engine constructed for a mount (signature listener live)')
  }

  /**
   * Per-turn deterministic signatures at turn/end (knowledge-repo §4.1):
   * synchronous extraction, async store append, and never-break containment —
   * a signature failure must never touch the compaction path (AGENTS hard
   * rule: the listener reports, it never throws into the session). The base
   * engine's own listeners model the same shape.
   */
  /** The realm's own scheduler (§5): same code as the host plane's; the file
   * lock and debounce keep the two honest against each other. */
  private syncDebounceMs = 30000
  private schedulerPromise: Promise<import('./sync.ts').SyncScheduler> | null = null
  #scheduler(): Promise<import('./sync.ts').SyncScheduler> {
    this.schedulerPromise ??= this.store().then(({ store }) => createSyncScheduler({
      storeRoot: this.chaptersConfig.artifactStoreRoot,
      cloneDir: DEFAULT_CLONE_DIR,
      debounceMs: this.syncDebounceMs,
      // The realm never AUTO-links (linking is the host command's job); it
      // reads what the project table knows.
      resolveProject: (cwd) => projectForCwd(store.projects(), cwd),
      tokenFor: (cwd, projectKey) => readToken(cwd, this.chaptersConfig.artifactStoreRoot, projectKey),
      collectionsFor: makeCollectionsReader(store.sessions.bind(store), this.chaptersConfig.artifactStoreRoot),
    }))
    return this.schedulerPromise
  }

  /** §5.1: a new session pulls before its first turn — the corpus is fresh. */
  #listenForFirstTurnPull(): void {
    try {
      this.ctx.on('session/event', makeFirstTurnPullListener({
        pull: (cwd) => this.#scheduler().then((s) => s.pullFor(cwd)),
      }))
    } catch {
      // L0 ctx without an event bus: same containment rule as signatures.
    }
  }

  #listenForSignatures(): void {
    try {
      this.ctx.on('session/event', makeSignatureListener({
        store: () => this.store(),
        warn: (error) => { this.ctx.logger?.warn?.(`dsh-chapters: signature capture failed (${String(error)})`) },
        onCollected: (id, sig) => {
          this.ctx.logger?.info?.(`dsh-chapters: signature collected for ${id} (${sig.seqs.length} events, ${sig.paths.length} paths, ${sig.size} est tokens)`)
        },
      }))
    } catch {
      // A non-cordis ctx (L0 construction) has no event bus — signatures are
      // optional there by design; the compaction path is unaffected.
    }
  }

  /** Lazy, once. `storageDomain` is a host-plane singleton the realm resolves;
   * acquire (never bare-open): a mounted tools-plugin may already own the reservation. */
  private store(): Promise<ChapterStoreHandle> {
    this.storePromise ??= (async () => {
      const sd = (this.ctx as unknown as { get?: (n: string) =>
        { open: (s: unknown) => Promise<unknown>; get?: (name: string) => unknown } | undefined }).get?.('storageDomain')
      if (sd === undefined) throw new Error('chapters: storageDomain service absent — cannot archive')
      return acquireChapterStore(sd as never)
    })()
    return this.storePromise
  }

  // ------------------------------------------------------------ the sanctioned hook

  protected override async summarize(
    input: SummarizeInputLike,
    agent: unknown,
    _signal?: AbortSignal,
  ): Promise<SummarizeResultLike> {
    const session = (agent as { session: EngineSession }).session
    const cwd = (session as unknown as { header?: { cwd?: string } }).header?.cwd ?? null
    const cid = findOpenCompactionId(session)

    if (cid === null || cwd === null || input.messages.length === 0) {
      // Degraded but honest: compaction proceeds with a plain deterministic
      // digest; NO chapter path is cited, so nothing can dangle. A distinct
      // provider tag keeps the finalizer's scan from claiming this record.
      return {
        summary: [{ type: 'text', text: `Compacted ${input.messages.length} messages (deterministic digest; no chapter: ${cwd === null ? 'no workspace cwd' : cid === null ? 'no open transaction' : 'empty region'}).` }],
        provider: `${CHAPTERS_PROVIDER}-degraded`,
        model: DETERMINISTIC_MODEL,
      }
    }

    const { store } = await this.store()
    const state = await store.get(session.id)

    // Topic-sequential composition inside AUTO compaction (r29 — the record's
    // §4.2 applied where sessions actually meet pressure, not only at the
    // fork). Reconstruction maps the prepared region back to log seqs; any
    // uncertainty (no Session mapping API, no collections, ambiguous match,
    // thrown anywhere) falls to the legacy single-chapter plan, which is the
    // behavior that has always been correct.
    let composition: readonly ChapterRange[] | null = null
    try {
      const seqs = reconstructShadowedSeqs(session, input)
      if (seqs !== null && state.collections.length > 0) {
        const spanStart = seqs[0]!
        const spanEnd = seqs[seqs.length - 1]!
        const spanEvents = seqs
          .map((seq) => session.eventAt(seq))
          .filter((e): e is NonNullable<typeof e> => e !== undefined) as unknown as SessionEventLike[]
        const composed = composeChapters(spanEvents, spanStart, spanEnd, state.collections, {
          mergeThreshold: this.chaptersConfig.mergeThreshold,
          chapterLimit: this.chaptersConfig.chapterLimit,
        })
        if (composed.chapters.length > 0) {
          const chs: ChapterRange[] = [...composed.chapters]
          // Compaction SHADOWS the whole selected span — unlike the fork, its
          // span need not end on a turn boundary. Absorb head/tail strays so
          // nothing is ever shadowed unarchived.
          if (chs[0]!.startSeq > spanStart) chs[0] = { ...chs[0]!, startSeq: spanStart }
          const lastIdx = chs.length - 1
          if (chs[lastIdx]!.endSeq < spanEnd) chs[lastIdx] = { ...chs[lastIdx]!, endSeq: spanEnd }
          composition = chs
        }
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-chapters: compaction composition fell back to legacy (${String(error)})`)
    }

    const { plan, state: next } = planSummarize(session, state, input, this.chaptersConfig, reserve, cid, composition)
    const stored = rememberPlan(next, cid, {
      number: plan.numbers[0]!, path: plan.chapter.path, title: plan.chapter.title, summary: plan.chapter.summary,
      ...(plan.chapters !== undefined ? { chapters: plan.chapters } : {}),
    })
    await store.put(session.id, stored) // reservation + manifest durable BEFORE the text cites them
    return { summary: [{ type: 'text', text: plan.tocText }], provider: CHAPTERS_PROVIDER, model: DETERMINISTIC_MODEL }
  }

  // ------------------------------------------------------------ entry points (finalize after commit)

  override async compactIfNeeded(
    agent: Agent, trigger: CompactionTrigger, signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    // Finalization runs whether super resolves OR throws: the pressure retry
    // loop can commit one compaction and then reject on a later attempt (shrink
    // floor — measured r19: 3 reserved plans, 1 finalized, zero errors, because
    // success-path-only finalization skipped the committed record). The scan is
    // session-based and idempotent; the original error is rethrown untouched.
    let result: CompactionResult | null
    try {
      result = await super.compactIfNeeded(agent, trigger, signal)
    } catch (error) {
      await this.#finalizeGuarded(agent)
      throw error
    }
    if (result !== null) await this.#finalizeGuarded(agent)
    return result
  }

  override async compactNow(
    agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    let result: CompactionResult | null
    try {
      result = await super.compactNow(agent, signal, sourceCommandId)
    } catch (error) {
      await this.#finalizeGuarded(agent)
      throw error
    }
    if (result !== null) await this.#finalizeGuarded(agent)
    return result
  }

  /**
   * Finalization failure must never break a committed compaction (the surface
   * is already correct and the log holds everything needed to retry) — it
   * warns, and the per-session reconciliation scan retries it on next touch.
   */
  async #finalizeGuarded(agent: Agent): Promise<void> {
    const session = agent.session as unknown as EngineSession
    try {
      await this.#finalizeAllOutstanding(session)
    } catch (error) {
      const message = `dsh-chapters: chapter finalization deferred (session ${session.id}): ${String((error as Error)?.stack ?? error)}`
      this.ctx.logger?.warn?.(message)
      // Headless profiles route ctx.logger where the operator cannot see it
      // (measured r19: every useful warn vanished). Mirror engine failures to
      // an append file when the operator opts in — diagnostics seam, not a tunable.
      const sink = process.env.DSH_CHAPTERS_ENGINE_ERRORS
      if (sink !== undefined) {
        try {
          appendFileSync(sink, `[${new Date().toISOString()}] ${message}\n`)
        } catch { /* diagnostics must never mask the real failure */ }
      }
    }
  }

  /** Every provider-tagged summary without a finalized manifest, oldest first. */
  async #finalizeAllOutstanding(session: EngineSession): Promise<void> {
    const { store } = await this.store()
    const state = await store.get(session.id)
    for (const found of scanChaptersSummaries(session)) {
      if (isFinalized(state, found.compactionId)) continue
      await this.#finalizeOne(session, store, found.compactionId, found.shadowedSeqs)
    }
  }

  async #finalizeOne(
    session: EngineSession,
    store: RegistryStore,
    compactionId: string,
    shadowedSeqs: readonly number[],
  ): Promise<void> {
    const state = await store.get(session.id)
    if (isFinalized(state, compactionId)) return
    const plan = state.plans[compactionId]
    const numbers = state.reservations[`compaction:${compactionId}`]
    if (plan === undefined || numbers === undefined) {
      throw new Error(`chapters: no durable plan/reservation for ${compactionId} (summarize never committed its manifest)`)
    }
    const cwd = (session as unknown as { header?: { cwd?: string } }).header?.cwd
    if (cwd === undefined) throw new Error('chapters: session has no cwd — nowhere reachable to write')

    const renderedList = buildFinalizedChapters(session, shadowedSeqs, {
      tocText: '', numbers, chapter: plan, ...(plan.chapters !== undefined ? { chapters: plan.chapters } : {}),
    }, this.chaptersConfig)

    const fs = makeArchiveFs(cwd)
    const wrote = await writeArchive({
      fs,
      allocator: makeAllocator(store, session.id),
      storeRoot: this.chaptersConfig.artifactStoreRoot,
      rootSessionId: state.rootSession,
      chapters: renderedList,
      attemptId: `compaction:${compactionId}`,
    })
    if (wrote.records.length !== renderedList.length) {
      // read-back failed or went missing — leaving this UNFINALIZED is the
      // point: the reconciliation scan will retry; nothing lies in the TOC.
      throw new Error(`chapters: write did not verify for ${compactionId}: ${wrote.warnings.join('; ')}`)
    }
    // Every record of this compaction carries the full shadowed span: they
    // jointly account for what the surface replacement hid (legacy single-
    // chapter behavior generalized).
    const records = wrote.records.map((r) => ({ ...r, shadowedSeqs: [...shadowedSeqs] }))
    let next: SessionState = appendChapters(state, records)
    next = markFinalized(next, compactionId, numbers)
    await store.put(session.id, next)
    // §5.1: compaction finalization is a push point (debounced).
    const cwdNow = (session as unknown as { header?: { cwd?: string } }).header?.cwd
    if (cwdNow !== undefined) void this.#scheduler().then((s) => s.schedule(cwdNow, 'archive:compaction')).catch(() => undefined)
    for (const w of wrote.warnings) this.ctx.logger?.warn?.(`dsh-chapters: ${w}`)
  }
}

export default ChaptersCompactionEngine
