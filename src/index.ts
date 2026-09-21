/**
 * dsh-chapters — cordis entry point (host plane). The ONLY host-facing function
 * plugin; engine logic lives in engine.ts (mounted per preset realm), every
 * decision in the pure modules (docs/development.md § L0).
 *
 * Responsibilities:
 *  1. Install the `chapters` preset into `$DSH_HOME/.agent-presets/` on boot
 *     (write-if-missing; user edits are never overwritten). Profile `!!js` has
 *     no `require` (measured r20), so copying is the delivery mechanism.
 *  2. Open the dsh_chapters storage domain and register chapters_segment /
 *     chapters_continue (src/tools.ts adapts them to the pure core).
 *  3. Witness/dev diagnostics.
 *
 * Protocol notes (each measured, docs/contract.md):
 *  - function plugin: named exports `name` / `inject` / `Config` / `apply`;
 *    NO default export (mixing forms makes the Loader discard the namespace).
 *  - Config uses schemastery (default import) — plain specs are for tool
 *    parameters, zod for domain records; never mix.
 */
import { writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { appendChapters, reserve } from './registry.ts'
import { acquireChapterStore, makeDomainStore } from './store.ts'
import type { ChapterRecord } from './archive.ts'
import { registerChaptersTools } from './tools.ts'
import { registerHostCommands } from './commands.ts'
import { createEnrichWiring } from './enrich-wire.ts'
import { rulesCommand, type RulesIo } from './rules-commands.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSyncScheduler, makeCollectionsReader, projectForCwd, readToken, DEFAULT_CLONE_DIR, type SyncScheduler } from './sync.ts'
import { resolveProject } from './repo.ts'

/** The cordis surface this entry touches; widened in later stages. */
interface HostCtx {
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  get?: (name: string) => unknown
  effect?: (fn: () => void, label?: string) => void
  agents?: unknown
  tools?: { register(def: unknown): () => void }
  sessionProjections?: { stateOf(session: unknown, key: string): unknown }
  llm?: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow?: number } } | undefined>
    stream?: (opts: unknown) => AsyncIterable<unknown>
  }
}

export interface Config {
  installChaptersPreset: boolean
  artifactStoreRoot: string
  chapterTokenTarget: number
  toolResultDeferFloorTokens: number
  continuationBudgetRatio: number
  fallbackPreset: string
  mergeThreshold: number
  chapterLimit: number
  harnessId: string
  /** §12: the project's knowledge repo URL ('' = rely on /chapters-link). */
  knowledgeRemote: string
  /** §12: wins over the §2.3 derivation. */
  projectKeyOverride: string
  /** §12: coalesce window for post-archive pushes. */
  syncDebounceMs: number
  /** §12: default pack size for chapters_search. */
  searchDefaultMaxTokens: number
  /** P2 §12: enrichment kill switch (auto triggers live on the realm plane;
   * the host plane's queue is manual-only so nothing ever double-runs). */
  enrichmentEnabled: boolean
  /** 'provider/model' or '' = conversation/stored route (record §6). */
  enrichmentModel: string
  enrichmentIdleMs: number
  enrichmentBatchCap: number
  /** P2 §6.3 vocabulary pass (shadow by default). */
  vocabApply: boolean
  vocabCoMin: number
  vocabOverlapMin: number
  /** P3 §7.3: budget for the notice's core-rules section (refuse, never clip). */
  coreRulesBudgetTokens: number
  /** P3 §8: search bonus for effective-core rules (per-machine status). */
  rulesCoreBonus: number
}

export const Config = Schema.object({
  // The preset is how the engine reaches real sessions (preset realm mount);
  // turning this off means opting into manual preset authoring instead.
  installChaptersPreset: Schema.boolean().default(true),
  artifactStoreRoot: Schema.string().default('.dsh-chapters'),
  chapterTokenTarget: Schema.number().default(8000),
  toolResultDeferFloorTokens: Schema.number().default(200),
  // Share of the window REMAINING after the header bound — never of the
  // whole window (docs/architecture.md § Budgets).
  continuationBudgetRatio: Schema.number().default(0.25),
  fallbackPreset: Schema.string().default('chapters'),
  // Topic-sequential composition (record §4.2) for the model-free fork path.
  mergeThreshold: Schema.number().default(0.3),
  chapterLimit: Schema.number().default(8000),
  // Per-machine identity for the knowledge repo (commit author + per-harness
  // token scoping, record §2.1). The hostname is the honest default; override
  // per machine when two sessions on one box must be told apart.
  harnessId: Schema.string().default(hostname()),
  // Knowledge repo (record §12): '' leaves linking to /chapters-link; a URL
  // auto-links every workspace on its first archive event.
  knowledgeRemote: Schema.string().default(''),
  projectKeyOverride: Schema.string().default(''),
  syncDebounceMs: Schema.number().default(30000),
  searchDefaultMaxTokens: Schema.number().default(400),
  enrichmentEnabled: Schema.boolean().default(true),
  enrichmentModel: Schema.string().default(''),
  enrichmentIdleMs: Schema.number().default(60000),
  enrichmentBatchCap: Schema.number().default(5),
  vocabApply: Schema.boolean().default(false),
  vocabCoMin: Schema.number().default(3),
  vocabOverlapMin: Schema.number().default(0.5),
  coreRulesBudgetTokens: Schema.number().default(1200),
  rulesCoreBonus: Schema.number().default(0.15),
}) as Schema<Config>

export const name = 'dsh-chapters'

export const inject = ['storageDomain', 'tools', 'agents', 'llm', 'sessionProjections']

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')

export async function apply(ctx: HostCtx, config: Config): Promise<void> {
  if (config.installChaptersPreset) installChaptersPreset(ctx)

  let domain: import('./store.ts').DomainLike | undefined
  try {
    const storageDomain = ctx.get?.('storageDomain') as
      { open: (s: unknown) => Promise<import('./store.ts').DomainLike>; get?: (n: string) => import('./store.ts').DomainLike | undefined } | undefined
    if (storageDomain === undefined) throw new Error('storageDomain absent')
    const handle = await acquireChapterStore(storageDomain)
    domain = handle.domain
    const store = handle.store
    // No close effect here: the facility's own disposer closes domains still
    // open at facility unmount (its documented teardown), and a close effect
    // on the apply fiber fires when THAT fiber is disposed — mid-run, which
    // closed the domain under later commands (r35 caught it). One opener, and
    // the closer is the facility's unmount, not our fiber.
    void handle.owner
    // P2: host-plane enrichment wiring — command surface + status only
    // (trigger forced manual; the realm engine owns auto drains).
    const enrich = createEnrichWiring({
      store,
      cwd: () => undefined,
      config: {
        enabled: config.enrichmentEnabled,
        model: config.enrichmentModel,
        trigger: 'manual',
        idleMs: config.enrichmentIdleMs,
        batchCap: config.enrichmentBatchCap,
      },
      fetch: async (prompt, route) => {
        if (route === null) throw new Error('no enrichment route resolvable (set /chapters-enrich model … or run a turn first)')
        const llm = ctx.llm
        if (llm?.stream === undefined) throw new Error('llm.stream absent')
        const assembler = new BlockAssembler()
        for await (const chunk of llm.stream({
          provider: route.provider, model: route.model,
          messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-chapters' } })],
          maxTokens: 900,
          purpose: 'compaction',
        })) assembler.push(chunk as never)
        return (assembler.blocks() as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      },
      conversationRoute: () => null,
      log: (m) => ctx.logger?.info?.(`dsh-chapters: ${m}`),
      warn: (m) => ctx.logger?.warn?.(`dsh-chapters: ${m}`),
    })
    const scheduler = createScheduler(store, domain, config, undefined, (cwd, ok) => {
      enrich.rememberCwd(cwd)
      if (ok) enrich.queue.onSyncDone('afterPush')
    })
    registerChaptersTools(ctx as never, store, {
      artifactStoreRoot: config.artifactStoreRoot,
      chapterTokenTarget: config.chapterTokenTarget,
      toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
      continuationBudgetRatio: config.continuationBudgetRatio,
      fallbackPreset: config.fallbackPreset,
      mergeThreshold: config.mergeThreshold,
      chapterLimit: config.chapterLimit,
      searchMaxTokens: config.searchDefaultMaxTokens,
      scheduler,
    })
    registerHostCommands(ctx as never, domain, {
      artifactStoreRoot: config.artifactStoreRoot,
      harnessId: config.harnessId,
      scheduler,
      enrich,
      rules: (cwd, args) => rulesCommand({
        cwd: () => cwd,
        storeRoot: config.artifactStoreRoot,
        harnessId: config.harnessId,
        store,
        projectFor: (c) => projectForCwd(store.projects(), c),
        mirrorDir: (c) => join(c, DEFAULT_CLONE_DIR),
        syncNow: async (c) => { try { await scheduler.run(c, 'rules') } catch { /* status file records it */ } },
        now: () => new Date(),
      } satisfies RulesIo, args),
    })
  } catch (error) {
    // Tools are the whole user-facing surface short of the engine: a failure
    // here is loud, never a silently missing tool. Loud means the operator
    // actually sees it — the realm logger routes to boot stdout (r19/r35 twice
    // burned by a warn nobody could read; the DSH_CHAPTERS_ERRORS sink env is
    // the engine's precedent).
    const message = `dsh-chapters: tool/command registration FAILED (${String(error)})`
    ctx.logger?.warn?.(message)
    console.error(message)
  }

  ctx.logger?.info?.('dsh-chapters: mounted (preset install + tools registered)')

  const marker = process.env.DSH_CHAPTERS_WITNESS
  if (marker === undefined) return
  setTimeout(() => { witness(ctx, marker, domain) }, 500).unref?.()
}

/**
 * The §5 sync loop for the host plane. Auto-link (when `knowledgeRemote` is
 * configured) happens lazily inside resolveProject: a workspace's first
 * archive event finds a project record, so nothing network-shaped runs
 * before anything archives.
 */
export function createScheduler(
  store: import('./store.ts').RegistryStore,
  domain: import('./store.ts').DomainLike,
  config: Config,
  debounceOverride?: number,
  onSyncDone?: (cwd: string, ok: boolean) => void,
): SyncScheduler {
  return createSyncScheduler({
    storeRoot: config.artifactStoreRoot,
    cloneDir: DEFAULT_CLONE_DIR,
    debounceMs: debounceOverride ?? config.syncDebounceMs,
    vocab: { apply: config.vocabApply, coMin: config.vocabCoMin, overlapMin: config.vocabOverlapMin },
    ...(onSyncDone !== undefined ? { onSyncDone } : {}),
    resolveProject: (cwd) => {
      const found = projectForCwd(store.projects(), cwd)
      if (found !== undefined) return found
      if (config.knowledgeRemote === '') return undefined
      try {
        const resolved = resolveProject(cwd,
          config.projectKeyOverride !== '' ? config.projectKeyOverride : undefined,
          config.knowledgeRemote)
        const rec = {
          projectKey: resolved.projectKey,
          slug: (resolved.remote ?? config.knowledgeRemote).split('/').pop()!.replace(/\.git$/, ''),
          remote: config.knowledgeRemote,
          harnessId: config.harnessId,
          linkedAt: new Date().toISOString(),
          cwd,
        }
        domain.table('projects').put(rec.projectKey, rec)
        return rec
      } catch {
        return undefined
      }
    },
    tokenFor: (cwd, projectKey) => readToken(cwd, config.artifactStoreRoot, projectKey),
    collectionsFor: makeCollectionsReader(store.sessions.bind(store), config.artifactStoreRoot),
  })
}

// ---------------------------------------------------------------- preset install

const PRESET_ID = 'chapters'
const USER_PRESET_DIR = '.agent-presets' // kernel constant: presets/agent-presets/src/discovery.ts

function installChaptersPreset(ctx: HostCtx): void {
  const srcDir = join(PKG_ROOT, 'presets', PRESET_ID)
  if (!existsSync(srcDir)) return
  const dstDir = dshHomePath(USER_PRESET_DIR, PRESET_ID)
  if (existsSync(join(dstDir, 'preset.yml'))) return // user-owned from here on; never clobber
  try {
    mkdirSync(join(dshHomePath(), USER_PRESET_DIR), { recursive: true })
    cpSync(srcDir, dstDir, { recursive: true })
    ctx.logger?.info?.(`dsh-chapters: installed the "${PRESET_ID}" preset to ${dstDir} — pick it in the preset menu for chapter-form compaction (standard keeps LLM summaries)`)
  } catch (error) {
    ctx.logger?.info?.(`dsh-chapters: preset install FAILED (${String(error)})`)
  }
}

// ---------------------------------------------------------------- dev witness

async function witness(ctx: HostCtx, marker: string, preopened?: import('./store.ts').DomainLike): Promise<void> {
  const WITNESS_SESSION = 'dsh-chapters-witness'
  const out: Record<string, unknown> = { at: new Date().toISOString() }
  try {
    out.storageDomainPresent = ctx.get?.('storageDomain') !== undefined
    out.presetsInstalled = existsSync(dshHomePath(USER_PRESET_DIR, PRESET_ID, 'preset.yml'))
    const storageDomain = ctx.get?.('storageDomain') as { open: (s: unknown) => Promise<import('./store.ts').DomainLike>; get?: (n: string) => import('./store.ts').DomainLike | undefined }
    const store = preopened !== undefined ? makeDomainStore(preopened) : (await acquireChapterStore(storageDomain!)).store
    const prior = await store.get(WITNESS_SESSION)
    out.priorChapters = prior.chapters.length
    if (prior.chapters.length === 0) {
      const reserved = reserve(prior, 'witness@1', 1)
      const record: ChapterRecord = {
        number: reserved.numbers[0] ?? 1,
        path: `.dsh-chapters/${WITNESS_SESSION}/chapters/001-witness.md`,
        title: 'witness', summary: `first boot ${new Date().toISOString()}`,
        startSeq: 0, endSeq: 0, topics: [], messages: 0, sha256: '0'.repeat(64), estimatedTokens: 0, artifacts: [],
      }
      await store.put(WITNESS_SESSION, appendChapters(reserved.state, [record]))
    } else {
      await store.put(WITNESS_SESSION, prior)
    }
    out.storedChapters = (await store.get(WITNESS_SESSION)).chapters.length
  } catch (error) {
    out.error = String(error)
  }
  writeFileSync(marker, JSON.stringify(out, null, 2))
}
