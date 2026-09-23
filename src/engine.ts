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
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { applyArrivalStubs, type ArrivalSessionShim } from './arrival.ts'
import { extractPlot } from './engine-core.ts'
import type { ChapterRange } from './types.ts'
import { appendChapters, isFinalized, markFinalized, rememberPlan, reserve } from './registry.ts'
import type { SessionState } from './registry.ts'
import { acquireChapterStore, makeAllocator, makeArchiveFs, type ChapterStoreHandle } from './store.ts'
import { createSyncScheduler, makeCollectionsReader, projectForCwd, readToken, DEFAULT_CLONE_DIR } from './sync.ts'
import { registerProvider } from './provider.ts'
import { createTreedxProvider } from './treedx/provider.ts'
import { createEnrichWiring, type EnrichWiring } from './enrich-wire.ts'
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
  toolResultArtifactTokens?: number
  elicitedPlot?: boolean
  // P2 enrichment (record §6): the realm plane owns the AUTO triggers.
  enrichmentEnabled?: boolean
  enrichmentModel?: string
  enrichmentTrigger?: 'afterPush' | 'idle' | 'both' | 'manual'
  enrichmentIdleMs?: number
  enrichmentBatchCap?: number
  // P2 §6.3 vocabulary pass (shadow by default: report, never write).
  vocabApply?: boolean
  vocabCoMin?: number
  vocabOverlapMin?: number
  // §15 amendment: TreeDX transport tunables (spikes/treedx/FINDINGS.md).
  treedxFetchTimeoutMs?: number
  treedxWorkspaceTtlSeconds?: number
  treedxLeaseRetries?: number
  treedxLeaseRetryDelayMs?: number
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
    toolResultArtifactTokens: z.number().step(1).min(256).default(8000),
    elicitedPlot: z.boolean().default(true),
    enrichmentEnabled: z.boolean().default(true),
    enrichmentModel: z.string().default(''),
    enrichmentTrigger: z.string().default('both'),
    enrichmentIdleMs: z.number().step(1).min(0).default(60000),
    enrichmentBatchCap: z.number().step(1).min(1).default(5),
    vocabApply: z.boolean().default(false),
    vocabCoMin: z.number().step(1).min(2).default(3),
    vocabOverlapMin: z.number().default(0.5),
    // §15 amendment: TreeDX transport tunables ride the same row so both
    // planes sync through identically-configured providers.
    treedxFetchTimeoutMs: z.number().step(1).min(1000).default(15000),
    treedxWorkspaceTtlSeconds: z.number().step(1).min(30).default(900),
    treedxLeaseRetries: z.number().step(1).min(0).default(3),
    treedxLeaseRetryDelayMs: z.number().step(1).min(0).default(1000),
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
      mergeThreshold, chapterLimit, syncDebounceMs, toolResultArtifactTokens, elicitedPlot,
      enrichmentEnabled, enrichmentModel, enrichmentTrigger, enrichmentIdleMs, enrichmentBatchCap,
      vocabApply, vocabCoMin, vocabOverlapMin,
      treedxFetchTimeoutMs, treedxWorkspaceTtlSeconds, treedxLeaseRetries, treedxLeaseRetryDelayMs,
      ...baseConfig
    } = config
    super(ctx, baseConfig)
    // The realm's module copy owns its own provider registry (cordis isolation
    // between planes): register the configured TreeDX transport HERE, exactly
    // as the host plane does in its apply(). Row defaults keep this correct
    // even when a preset omits every treedx key.
    registerProvider(createTreedxProvider({
      fetchTimeoutMs: treedxFetchTimeoutMs ?? 15000,
      workspaceTtlSeconds: treedxWorkspaceTtlSeconds ?? 900,
      leaseRetries: treedxLeaseRetries ?? 3,
      leaseRetryDelayMs: treedxLeaseRetryDelayMs ?? 1000,
    }))
    this.chaptersConfig = {
      artifactStoreRoot: artifactStoreRoot ?? '.dsh-chapters',
      chapterTokenTarget: chapterTokenTarget ?? 8000,
      toolResultDeferFloorTokens: toolResultDeferFloorTokens ?? 200,
      mergeThreshold: mergeThreshold ?? 0.3,
      chapterLimit: chapterLimit ?? 8000,
      toolResultArtifactTokens: toolResultArtifactTokens ?? 8000,
      elicitedPlot: elicitedPlot ?? true,
    }
    this.syncDebounceMs = syncDebounceMs ?? 30000
    this.vocabCfg = { apply: vocabApply ?? false, coMin: vocabCoMin ?? 3, overlapMin: vocabOverlapMin ?? 0.5 }
    this.enrichCfg = {
      enabled: enrichmentEnabled ?? true,
      model: enrichmentModel ?? '',
      trigger: (enrichmentTrigger ?? 'both') as 'afterPush' | 'idle' | 'both' | 'manual',
      idleMs: enrichmentIdleMs ?? 60000,
      batchCap: enrichmentBatchCap ?? 5,
    }
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
  private vocabCfg: { apply: boolean; coMin: number; overlapMin: number } = { apply: false, coMin: 3, overlapMin: 0.5 }
  private enrichCfg: { enabled: boolean; model: string; trigger: 'afterPush' | 'idle' | 'both' | 'manual'; idleMs: number; batchCap: number } =
    { enabled: false, model: '', trigger: 'both', idleMs: 60000, batchCap: 5 }
  private enrichPromise: Promise<EnrichWiring> | null = null
  private lastCwd: string | null = null
  private lastRoute: { provider: string; model: string } | null = null
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
      vocab: this.vocabCfg,
      // P2: a completed sync pass is the enrichment afterPush idle point.
      onSyncDone: (cwd, ok) => {
        void this.#enrich().then((w) => { w.rememberCwd(cwd); if (ok) w.queue.onSyncDone('afterPush') }).catch(() => undefined)
      },
    }))
    return this.schedulerPromise
  }

  /** P2 enrichment wiring (realm plane owns auto triggers; route + heartbeat
   * persist through the shared settings table, so the host command surface
   * and /chapters-status read one truth). Lazy; failures degrade silently —
   * the corpus simply stays signatures-only (kill-switch parity). */
  #enrich(): Promise<EnrichWiring> {
    this.enrichPromise ??= this.store().then(({ store }) => createEnrichWiring({
      store,
      cwd: () => this.lastCwd ?? undefined,
      config: this.enrichCfg,
      fetch: async (prompt, route) => {
        const r = route ?? this.lastRoute
        if (r === null || r.provider === '' || r.model === '') throw new Error('no auxiliary route yet')
        return await this.#auxComplete(prompt, r, 900)
      },
      conversationRoute: () => this.lastRoute,
      scheduler: { schedule: (cwd, why) => { void this.#scheduler().then((s) => s.schedule(cwd, why)).catch(() => undefined) } },
      log: (m) => this.ctx.logger?.info?.(`dsh-chapters: ${m}`),
      warn: (m) => this.ctx.logger?.warn?.(`dsh-chapters: ${m}`),
    }))
    return this.enrichPromise
  }

  /** one tools-free completion (shared plumbing: enrichment + plot). */
  async #auxComplete(prompt: string, route: { provider: string; model: string }, maxTokens: number, signal?: AbortSignal, sessionId?: string): Promise<string> {
    const llm = (this.ctx as unknown as { llm?: { stream: (o: unknown) => AsyncIterable<unknown> } }).llm
    if (llm === undefined) throw new Error('llm absent')
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: route.provider, model: route.model,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-chapters' } })],
      maxTokens,
      ...(sessionId !== undefined ? { sessionId } : {}),
      purpose: 'compaction',
      ...(signal !== undefined ? { signal } : {}),
    })) assembler.push(chunk as never)
    return (assembler.blocks() as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  }

  /** Capture workspace cwd + routed model at every compaction entry; arm the
   * idle timer (turn activity). Advisory only — never disturbs compaction. */
  #observeRoute(agent: unknown): void {
    try {
      const session = (agent as { session?: EngineSession & { id: string } }).session
      if (session === undefined) return
      const cwd = (session as unknown as { header?: { cwd?: string } }).header?.cwd
      if (cwd !== undefined) this.lastCwd = cwd
      const cfg = (session as unknown as { requestHeader?: () => { config?: { provider?: string; model?: string } } }).requestHeader?.()?.config
      if (cfg?.provider !== undefined && cfg?.model !== undefined) this.lastRoute = { provider: cfg.provider, model: cfg.model }
      void this.#enrich().then((w) => w.queue.noteActivity()).catch(() => undefined)
    } catch { /* observation is advisory */ }
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

    // Plot carriage (architecture.md amendment): the model's own forward-
    // maintained note survives the shadowing; when the agent never wrote one,
    // one BOUNDED elicited call over the region being condensed (tail-heavy,
    // ~8K chars in, ≤150 words out) — approved exception to zero-inference,
    // gated by config. Any failure degrades to no plot; it never breaks the
    // compaction path.
    let plot = extractPlot(input.messages)
    if (plot === null && this.chaptersConfig.elicitedPlot) plot = await this.#elicitPlot(agent, input, _signal)

    const { plan, state: next } = planSummarize(session, state, input, this.chaptersConfig, reserve, cid, composition, plot)
    const stored = rememberPlan(next, cid, {
      number: plan.numbers[0]!, path: plan.chapter.path, title: plan.chapter.title, summary: plan.chapter.summary,
      ...(plan.chapters !== undefined ? { chapters: plan.chapters } : {}),
    })
    await store.put(session.id, stored) // reservation + manifest durable BEFORE the text cites them
    return { summary: [{ type: 'text', text: plan.tocText }], provider: CHAPTERS_PROVIDER, model: DETERMINISTIC_MODEL }
  }

  // ------------------------------------------------------------ entry points (finalize after commit)

  /**
   * Arrival-time artifacting (architecture.md amendment): heads EVERY
   * compaction entry — pre-step pressure, overflow retries, manual compact —
   * so oversized tool results are stubbed at the tail node before the next
   * request composes (the base listener awaits this call before next(),
   * compaction-basic/lib/index.js:799-812). Never throws; degradation is
   * logged and the blob simply stays inline (today's behavior).
   */
  async #elicitPlot(agent: unknown, input: SummarizeInputLike, signal?: AbortSignal): Promise<string | null> {
    try {
      const session = (agent as { session: EngineSession & { id: string } }).session
      // tail-heavy flattening: the plan lives in what the model said RECENTLY
      let flat = ''
      for (let i = input.messages.length - 1; i >= 0 && flat.length < 8000; i--) {
        const m = input.messages[i] as { role?: string; content?: { type?: string; text?: string }[] }
        const text = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').slice(0, 1200)
        if (text.length > 0) flat = `${m.role ?? '?'}: ${text}\n${flat}`
      }
      const instruction = 'You maintain a plot note for a conversation about to be compacted. From the excerpt below, state in at most 60 words, on one line beginning exactly with "PLOT:", what the agent is mid-way through: objective, current hypothesis, immediate next step. No tools, no prose around the line.\n\nEXCERPT:\n' + flat.slice(-8000)
      // Unified auxiliary route (P2 decision): the enrichment resolver (override
      // > config > persisted heartbeat > live conversation route) serves plot
      // too; the summarization row fields remain a legacy prefix override.
      const w = await this.#enrich().catch(() => null)
      const shared = w?.auxRoute() ?? null
      const cfg = (this as unknown as { config?: { summarizationProvider?: string; summarizationModel?: string } }).config ?? {}
      const legacy = (typeof cfg.summarizationProvider === 'string' && cfg.summarizationProvider !== ''
        && typeof cfg.summarizationModel === 'string' && cfg.summarizationModel !== '')
        ? { provider: cfg.summarizationProvider, model: cfg.summarizationModel } : null
      const route = legacy ?? (shared !== null && shared.provider !== '' && shared.model !== '' ? shared : this.lastRoute)
      if (route === null) return null
      const text = await this.#auxComplete(instruction, route, 220, signal, session.id)
      const at = text.indexOf('PLOT:')
      if (at === -1) return null
      const para = text.slice(at + 5).split(/\n\s*\n/)[0]!.trim()
      return para.length === 0 ? null : para.slice(0, 900)
    } catch {
      return null
    }
  }

  async #arrive(agent: Agent): Promise<void> {
    const session = agent.session as unknown as ArrivalSessionShim & { header?: { cwd?: string } }
    const cwd = session.header?.cwd
    if (cwd === undefined || cwd === '') return
    const meter = (this.ctx as unknown as { tokenMeter?: { estimateMessage: (m: unknown) => number } }).tokenMeter
    if (meter === undefined) return
    const r = await applyArrivalStubs(session, {
      cwd,
      storeRoot: this.chaptersConfig.artifactStoreRoot,
      floorTokens: this.chaptersConfig.toolResultArtifactTokens,
      estimate: (m: unknown) => meter.estimateMessage(m),
    })
    if (r.detail !== undefined) this.ctx.logger?.warn?.(`dsh-chapters: arrival stubbing degraded (${r.detail})`)
  }

  override async compactIfNeeded(
    agent: Agent, trigger: CompactionTrigger, signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    this.#observeRoute(agent)
    await this.#arrive(agent)
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
    this.#observeRoute(agent)
    await this.#arrive(agent)
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
