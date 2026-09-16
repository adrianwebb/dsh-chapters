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
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import {
  CHAPTERS_PROVIDER, DETERMINISTIC_MODEL, buildFinalizedChapter, findOpenCompactionId,
  planSummarize, scanChaptersSummaries,
  type EngineConfig, type EngineSession, type SummarizeInputLike, type SummarizeResultLike,
} from './engine-core.ts'
import { appendChapters, isFinalized, markFinalized, rememberPlan, reserve } from './registry.ts'
import type { SessionState } from './registry.ts'
import { chapterDomainSpec, makeAllocator, makeArchiveFs, makeDomainStore, type DomainLike } from './store.ts'
import { writeArchive } from './archive.ts'
import type { RegistryStore } from './store.ts'

/** Row config: the base's keys (so realm rows validate) plus the archive's own. */
export interface ChaptersRowConfig extends BasicCompactionConfig {
  artifactStoreRoot?: string
  chapterTokenTarget?: number
  toolResultDeferFloorTokens?: number
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
  })

  private readonly chaptersConfig: EngineConfig
  private storePromise: Promise<{ domain: DomainLike; store: RegistryStore }> | null = null

  constructor(ctx: Context, config: ChaptersRowConfig = {}) {
    // The base's resolveConfig rejects unknown keys at runtime (measured r18:
    // `BasicCompactionConfig: unknown key "artifactStoreRoot"`) — the archive's
    // own keys are peeled off and held here; the base receives exactly its
    // documented shape. (The loader does not strip them for us either.)
    const {
      artifactStoreRoot, chapterTokenTarget, toolResultDeferFloorTokens, ...baseConfig
    } = config
    super(ctx, baseConfig)
    this.chaptersConfig = {
      artifactStoreRoot: artifactStoreRoot ?? '.dsh-chapters',
      chapterTokenTarget: chapterTokenTarget ?? 8000,
      toolResultDeferFloorTokens: toolResultDeferFloorTokens ?? 200,
    }
  }

  /** Lazy, once. `storageDomain` is a host-plane singleton the realm resolves. */
  private store(): Promise<{ domain: DomainLike; store: RegistryStore }> {
    this.storePromise ??= (async () => {
      const sd = (this.ctx as { get?: (n: string) => { open: (s: unknown) => Promise<DomainLike> } }).get?.('storageDomain')
      if (sd === undefined) throw new Error('chapters: storageDomain service absent — cannot archive')
      const domain = await sd.open(chapterDomainSpec)
      return { domain, store: makeDomainStore(domain) }
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
    const { plan, state: next } = planSummarize(session, state, input, this.chaptersConfig, reserve, cid)
    const stored = rememberPlan(next, cid, { number: plan.numbers[0]!, path: plan.chapter.path, title: plan.chapter.title, summary: plan.chapter.summary })
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

    const rendered = buildFinalizedChapter(session, shadowedSeqs, {
      tocText: '', numbers, chapter: plan,
    }, this.chaptersConfig)

    const fs = makeArchiveFs(cwd)
    const wrote = await writeArchive({
      fs,
      allocator: makeAllocator(store, session.id),
      storeRoot: this.chaptersConfig.artifactStoreRoot,
      rootSessionId: state.rootSession,
      chapters: [rendered],
      attemptId: `compaction:${compactionId}`,
    })
    if (wrote.records.length !== 1) {
      // read-back failed or went missing — leaving this UNFINALIZED is the
      // point: the reconciliation scan will retry; nothing lies in the TOC.
      throw new Error(`chapters: write did not verify for ${compactionId}: ${wrote.warnings.join('; ')}`)
    }
    const record = { ...wrote.records[0]!, shadowedSeqs: [...shadowedSeqs] }
    let next: SessionState = appendChapters(state, [record])
    next = markFinalized(next, compactionId, numbers)
    await store.put(session.id, next)
    for (const w of wrote.warnings) this.ctx.logger?.warn?.(`dsh-chapters: ${w}`)
  }
}

export default ChaptersCompactionEngine
