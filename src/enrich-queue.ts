/**
 * P2 S2 — the enrichment queue: one queue, pluggable triggers, hard idle
 * guarantee (record §6.2, plan decisions).
 *
 * Isomorphic factory (host plane + realm engine each own an instance, like
 * createSyncScheduler). Providers are the ONLY variance:
 *   afterPush  — schedule(reason) called after each completed sync pass
 *   idle       — a resettable debounce timer (enrichment.idleMs)
 *   both       — the default
 *   manual     — no auto triggers; the /chapters-enrich run command drains
 *
 * Invariants this module owns:
 *   - NEVER in a hot path: enrichOne is only reached from drain(), and
 *     drain() is only fired by trigger events that already completed the
 *     user's work (post-push) or by silence (idle) or a command.
 *   - Idempotency key = chapter number + rootSession + model. Re-enqueue
 *     after vocab change is NOT needed (vocab affects canonicalization at
 *     index build, not the model call); after a MODEL change it IS (key
 *     includes model, so the key naturally changes).
 *   - enabled:false ⇒ every entry point is a pure no-op (kill-switch exit
 *     criterion: the corpus stays fully functional, signatures-only).
 *   - Cross-plane double-run: the caller-supplied lock (store-dir, same
 *     pattern as sync's acquireLock) makes the realm + host queues safe on
 *     one workspace.
 */

export interface EnrichQueueDeps {
  /** enumerate chapters lacking current-model enrichment (cheap, durable-read only) */
  listPending: (model: string, cap: number) => Promise<{ key: string; label: string }[]>
  /** run the ladder for one chapter; must never throw (S1 core + persistence) */
  enrichOne: (key: string) => Promise<{ ok: boolean; skipped?: string }>
  /** current enrichment model id ('' = resolver said: conversation model — queue still needs a concrete string for keys) */
  resolveModel: () => Promise<string>
  enabled: boolean
  trigger: 'afterPush' | 'idle' | 'both' | 'manual'
  idleMs: number
  batchCap: number
  log: (msg: string) => void
  /** injectable timer for tests */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void }
}

export interface EnrichQueue {
  /** a sync pass just completed (or any natural idle point) */
  onSyncDone: (reason: string) => void
  /** archive activity happened — resets the idle timer */
  noteActivity: () => void
  /** manual drain (command surface); returns processed count */
  drainNow: () => Promise<number>
  /** queue state for /chapters-status + reports */
  state: () => { enabled: boolean; trigger: string; pendingEstimate: number; lastBatch: number; model: string | null }
  dispose: () => void
}

export function createEnrichQueue(deps: EnrichQueueDeps): EnrichQueue {
  let idleTimer: { cancel: () => void } | null = null
  let draining: Promise<number> | null = null
  let lastBatch = 0
  let modelCache: string | null = null
  let pendingEstimate = 0

  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    return { cancel: () => clearTimeout(t) }
  })

  const drain = (forced = false): Promise<number> => {
    // auto drains honor the trigger choice; a forced drain (the command /
    // manual surface) only honors the kill switch
    if (!deps.enabled || (!forced && deps.trigger === 'manual')) return Promise.resolve(0)
    if (draining !== null) return draining // one batch at a time; requests collapse
    draining = (async () => {
      try {
        const model = await deps.resolveModel()
        modelCache = model
        const pending = await deps.listPending(model, deps.batchCap)
        pendingEstimate = pending.length
        let done = 0
        for (const item of pending) {
          const r = await deps.enrichOne(item.key)
          if (r.ok) done++
        }
        lastBatch = done
        if (done > 0) deps.log(`enrichment batch: ${done}/${pending.length} chapter(s) via ${model}`)
        return done
      } catch (error) {
        deps.log(`enrichment drain failed (kept silent for the user): ${String(error)}`)
        return 0
      } finally {
        draining = null
      }
    })()
    return draining
  }

  return {
    onSyncDone: (reason) => {
      if (!deps.enabled) return
      if (deps.trigger === 'afterPush' || deps.trigger === 'both') {
        deps.log(`enrichment scheduled after sync (${reason})`)
        void drain()
      }
    },
    noteActivity: () => {
      if (!deps.enabled || (deps.trigger !== 'idle' && deps.trigger !== 'both')) return
      idleTimer?.cancel()
      idleTimer = setTimer(() => { void drain() }, deps.idleMs)
    },
    drainNow: async () => {
      if (!deps.enabled) return 0
      return await drain(true)
    },
    state: () => ({
      enabled: deps.enabled,
      trigger: deps.trigger,
      pendingEstimate,
      lastBatch,
      model: modelCache,
    }),
    dispose: () => { idleTimer?.cancel(); idleTimer = null },
  }
}
