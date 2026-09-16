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
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { appendChapters, reserve } from './registry.ts'
import { chapterDomainSpec, makeDomainStore } from './store.ts'
import type { ChapterRecord } from './archive.ts'
import { registerChaptersTools } from './tools.ts'

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
  }
}

export interface Config {
  installChaptersPreset: boolean
  artifactStoreRoot: string
  chapterTokenTarget: number
  toolResultDeferFloorTokens: number
  continuationBudgetRatio: number
  fallbackPreset: string
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
}) as Schema<Config>

export const name = 'dsh-chapters'

export const inject = ['storageDomain', 'tools', 'agents', 'llm', 'sessionProjections']

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')

export async function apply(ctx: HostCtx, config: Config): Promise<void> {
  if (config.installChaptersPreset) installChaptersPreset(ctx)

  let domain: import('./store.ts').DomainLike | undefined
  try {
    const storageDomain = ctx.get?.('storageDomain') as { open: (s: unknown) => Promise<import('./store.ts').DomainLike> } | undefined
    if (storageDomain === undefined) throw new Error('storageDomain absent')
    domain = await storageDomain.open(chapterDomainSpec)
    const store = makeDomainStore(domain)
    ctx.effect?.(() => { void domain?.close() }, 'dsh-chapters domain close')
    registerChaptersTools(ctx as never, store, {
      artifactStoreRoot: config.artifactStoreRoot,
      chapterTokenTarget: config.chapterTokenTarget,
      toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
      continuationBudgetRatio: config.continuationBudgetRatio,
      fallbackPreset: config.fallbackPreset,
    })
  } catch (error) {
    // Tools are the whole user-facing surface short of the engine: a failure
    // here is loud, never a silently missing tool.
    ctx.logger?.warn?.(`dsh-chapters: tool registration FAILED (${String(error)})`)
  }

  ctx.logger?.info?.('dsh-chapters: mounted (preset install + tools registered)')

  const marker = process.env.DSH_CHAPTERS_WITNESS
  if (marker === undefined) return
  setTimeout(() => { witness(ctx, marker, domain) }, 500).unref?.()
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
    const domain = preopened ?? await (ctx.get?.('storageDomain') as { open: (s: unknown) => Promise<import('./store.ts').DomainLike> }).open(chapterDomainSpec)
    const store = makeDomainStore(domain)
    const prior = await store.get(WITNESS_SESSION)
    out.priorChapters = prior.chapters.length
    if (prior.chapters.length === 0) {
      const reserved = reserve(prior, 'witness@1', 1)
      const record: ChapterRecord = {
        number: reserved.numbers[0] ?? 1,
        path: `.dsh-chapters/${WITNESS_SESSION}/chapters/001-witness.md`,
        title: 'witness', summary: `first boot ${new Date().toISOString()}`,
        startSeq: 0, endSeq: 0, sha256: '0'.repeat(64), estimatedTokens: 0, artifacts: [],
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
