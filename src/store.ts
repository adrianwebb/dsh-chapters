/**
 * The storage-domain adapter: zod schemas, the durable spec, and the ports
 * that connect the pure registry (registry.ts) and pure archive writer
 * (archive.ts) to host persistence and the filesystem. This is glue next to
 * `src/index.ts` — thin by policy; every decision lives in the pure layer.
 *
 * Keying: one record per SESSION id (`sessions` table), because chapters are
 * keyed by creating session, not a linear chain id — siblings branching from
 * one ancestor cannot collide, and the flat TOC is built by walking links
 * (registry.ancestorPath), never by a directory scan.
 *
 * Concurrency, honestly: read-modify-write per key. Same-session archive
 * flows are serialized by their own reserve-before-write ordering, and a
 * session has exactly one write handle (the kernel refuses a second, measured
 * r3). Cross-process same-key writes are last-writer-wins on the JSON
 * backend — acceptable for MVP, worth revisiting before multi-host chains.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ArchiveFs, ChapterRecord, NumberAllocator } from './archive.ts'
import { appendChapters, freshSession, reserve, type SessionState } from './registry.ts'

// ---------------------------------------------------------------- schemas + spec

const chapterRecordSchema = z.object({
  number: z.number().int().positive(),
  path: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative(),
  shadowedSeqs: z.array(z.number().int().nonnegative()).optional(),
  sha256: z.string().min(16),
  estimatedTokens: z.number().int().nonnegative(),
  artifacts: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().min(16),
    bytes: z.number().int().nonnegative(),
  })),
})

const sessionStateSchema = z.object({
  parentSession: z.string().nullable(),
  rootSession: z.string().min(1),
  nextChapterNumber: z.number().int().positive(),
  chapters: z.array(chapterRecordSchema),
  reservations: z.record(z.string(), z.array(z.number().int().positive())).default({}),
  plans: z.record(z.string(), z.object({
    number: z.number().int().positive(),
    path: z.string().min(1),
    title: z.string(),
    summary: z.string(),
  })).default({}),
  finalized: z.record(z.string(), z.array(z.number().int().positive())).default({}),
})

/** Durable declaration of the dsh_chapters registry domain. */
export const chapterDomainSpec = defineDomain({
  name: 'dsh_chapters',
  version: 0,
  tables: {
    sessions: domainTable<string, SessionState>(sessionStateSchema),
  },
})

/** Minimal structural type of `ctx.storageDomain.open(spec)` we rely on. */
export interface DomainLike {
  table(name: 'sessions'): {
    get(key: string): SessionState | undefined
    put(key: string, value: SessionState): Promise<void>
    entries(): IterableIterator<[string, SessionState]>
    readonly size: number
  }
  close(): Promise<void>
}

// ---------------------------------------------------------------- registry ports

/** Read-modify-write seam over one domain. */
export interface RegistryStore {
  get(sessionId: string): Promise<SessionState>
  put(sessionId: string, state: SessionState): Promise<void>
}

export function makeDomainStore(domain: DomainLike): RegistryStore {
  const table = domain.table('sessions')
  return {
    async get(sessionId) {
      const raw = table.get(sessionId)
      return raw ?? freshSession(sessionId)
    },
    async put(sessionId, state) {
      await table.put(sessionId, state)
    },
  }
}

/**
 * The NumberAllocator archive.ts asks for, bound to one author session.
 * Reserve-before-write per docs/architecture.md § Atomicity; retries reuse
 * numbers through registry.reserve's attempt-keyed idempotence.
 */
export function makeAllocator(store: RegistryStore, sessionId: string): NumberAllocator {
  return {
    async reserve(attemptId: string, count: number): Promise<number[]> {
      const state = await store.get(sessionId)
      const next = reserve(state, attemptId, count)
      await store.put(sessionId, next.state)
      return next.numbers
    },
  }
}

/** The commit-point write: verified chapter records into the session state. */
export async function commitChapters(
  store: RegistryStore,
  sessionId: string,
  records: readonly ChapterRecord[],
): Promise<void> {
  const state = await store.get(sessionId)
  const next = appendChapters(state, records)
  if (next !== state) await store.put(sessionId, next)
}

/**
 * One domain, one opener: `DomainFacility.open` throws `already-open` for a
 * reserved name and never releases the reservation except via `Domain.close()`
 * (r27b proved the multi-opener lottery: plugin-apply, the realm engine, and
 * any probe all targeting dsh_chapters — whoever raced first won and everyone
 * else's compaction failed). Acquire = try open; on already-open, adopt the
 * live handle via `facility.get` and claim NO close ownership.
 */
export interface ChapterStoreHandle {
  store: RegistryStore
  /** true only for the fiber that actually opened — that one registers the disposer. */
  owner: boolean
}

export async function acquireChapterStore(
  storageDomain: { open: (spec: unknown) => Promise<DomainLike>; get?: (name: string) => DomainLike | undefined },
): Promise<ChapterStoreHandle> {
  try {
    return { store: makeDomainStore(await storageDomain.open(chapterDomainSpec)), owner: true }
  } catch (error) {
    if (!/already[- ]open/i.test(String((error as Error)?.message ?? error))) throw error
    const existing = storageDomain.get?.(chapterDomainSpec.name)
    if (existing === undefined) throw error
    return { store: makeDomainStore(existing), owner: false }
  }
}

// ---------------------------------------------------------------- filesystem port

const join = (...parts: string[]): string =>
  parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/')

/**
 * ArchiveFs over node:fs, anchored at one base dir (the session workspace).
 * Plugins are trusted same-process code — the sandbox governs TOOLS, not
 * this path — so node:fs is legitimate here; `ctx.fs` stays untouched.
 * `read` maps ENOENT to undefined; anything else propagates: a permission
 * error must not look like a missing file.
 */
export function makeArchiveFs(baseDir: string): ArchiveFs {
  const abs = (p: string): string => join(baseDir, p)
  return {
    async write(p, content) {
      const target = abs(p)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    },
    async read(p) {
      try {
        return await readFile(abs(p), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async exists(p) {
      return (await this.read(p)) !== undefined
    },
  }
}

/**
 * "Add <store-root>/ to .gitignore on first write and say so" — silently
 * polluting a user's tree is its own small bug (docs/architecture.md §
 * Storage). Returns a human line for the tool result's warnings.
 */
export async function ensureStoreGitignore(
  fs: ArchiveFs,
  storeRoot: string,
): Promise<string> {
  const current = await fs.read('.gitignore')
  const entry = `${storeRoot.replace(/\/+$/, '')}/`
  if (current !== undefined && current.split('\n').some((line) => line.trim() === entry)) {
    return `${entry} already in .gitignore`
  }
  const updated = (current ?? '') + (current !== undefined && !current.endsWith('\n') ? '\n' : '') +
    `\n# dsh-chapters archive (verbatim chapter store; see README)\n${entry}\n`
  await fs.write('.gitignore', updated)
  return `added ${entry} to .gitignore — say so: the plugin wrote into the repo root`
}
