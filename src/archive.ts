/**
 * Archive writer — the first I/O layer, behind an injected fs so it stays testable without a harness.
 *
 * Ordering is the whole design here. Reserve numbers → write artifacts → write chapters → verify read-back
 * → return records for the registry. A crash must be able to leave an orphan file, but never a registry
 * entry or an index that points at a file which was not written. See docs/architecture.md § Atomicity.
 *
 * Deferral is a copy decision, not a data decision: the artifact is written whether or not the chapter body
 * also inlines it, so a wrong model judgement costs one `read` and never loses text.
 */
import type { ArtifactRef, RenderedChapter } from './types.ts'
import { sha256 } from './render.ts'

/** Minimal filesystem seam. `ctx.fs` is OPTIONAL in DSH, so absence must be a clean refusal upstream. */
export interface ArchiveFs {
  write(path: string, content: string): Promise<void>
  read(path: string): Promise<string | undefined>
  exists(path: string): Promise<boolean>
}

/** Number allocation through the registry, never by scanning a directory (races a concurrent sibling). */
export interface NumberAllocator {
  reserve(key: string, count: number): Promise<number[]>
}

export interface ChapterRecord {
  number: number
  path: string
  title: string
  summary: string
  startSeq: number
  endSeq: number
  /** Index topics (deterministic floor; P2 enrichment may relabel). */
  topics: string[]
  /**
   * The exact surface seqs archived, in surface order. Optional because
   * continuation-path ranges are numeric-contiguous (start/end suffice), but
   * engine-path spans replace across the log, where start/end are only span
   * bounds — the set is the truth about coverage. (`| undefined` so the
   * zod-inferred type satisfies `exactOptionalPropertyTypes` in store.ts.)
   */
  shadowedSeqs?: number[] | undefined
  /** Body sha256, used to detect on-disk tampering before the text is ever cited. */
  sha256: string
  estimatedTokens: number
  artifacts: Array<{ path: string; sha256: string; bytes: number }>
}

export interface WriteResult {
  records: ChapterRecord[]
  artifactPathsWritten: string[]
  /** Duplicate titles, retried attempts reusing numbers, or content that failed read-back. */
  warnings: string[]
}

/** Filesystem-safe, stable, and never empty. Title is display metadata; the number is the identity. */
export function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug.slice(0, 48) : 'chapter'
}

export const chapterFileName = (n: number, title: string): string =>
  `${String(n).padStart(3, '0')}-${slugify(title)}.md`

/** Idempotency key: the same source session + ceiling reuses reserved numbers instead of duplicating. */
export const attemptKey = (sourceSessionId: string, archiveCeiling: number): string =>
  `${sourceSessionId}@${archiveCeiling}`

/** Join without importing path, so the seam stays portable between ctx.fs and node:fs. */
const join = (...parts: string[]): string =>
  parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/')

export interface WriteInput {
  fs: ArchiveFs
  allocator: NumberAllocator
  /** Store root, relative to the session workspace so the `read` tool can reach it. */
  storeRoot: string
  /** Directory key — the root of the ancestry tree, not the per-fork id. One dir per tree. */
  rootSessionId: string
  chapters: readonly RenderedChapter[]
  /** Reuse a prior attempt's allocation when this is a retry of identical work. */
  attemptId: string
}

export async function writeArchive(input: WriteInput): Promise<WriteResult> {
  const { fs, allocator, storeRoot, rootSessionId, chapters } = input
  if (chapters.length === 0) throw new Error('writeArchive called with no chapters')

  const treeDir = join(storeRoot, rootSessionId)
  const warnings: string[] = []

  // 1. Reserve BEFORE touching the filesystem, so a crash cannot re-use a number.
  const numbers = await allocator.reserve(input.attemptId, chapters.length)
  if (numbers.length !== chapters.length) {
    throw new Error(`allocator returned ${numbers.length} numbers for ${chapters.length} chapters`)
  }

  const records: ChapterRecord[] = []
  const artifactPathsWritten: string[] = []
  const seenArtifact = new Map<string, string>()   // sha256 → path, for subtree dedup
  const seenFile = new Set<string>()

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!
    const number = numbers[i]!
    let fileName = chapterFileName(number, chapter.range.title)
    if (seenFile.has(fileName)) {
      // Same title, same number prefix — disambiguate rather than let one chapter overwrite another.
      fileName = fileName.replace(/\.md$/, `-${number}.md`)
      warnings.push(`title collision resolved for "${chapter.range.title}" → ${fileName}`)
    }
    seenFile.add(fileName)
    const chapterPath = join(treeDir, 'chapters', fileName)

    // 2. Artifacts first: the chapter body cites these paths, so they must exist before it does.
    for (const artifact of chapter.artifacts) {
      const existing = seenArtifact.get(artifact.sha256)
      if (existing !== undefined) continue                       // identical result in this batch
      if (await fs.exists(join(treeDir, artifact.path))) {        // identical result from an earlier fork
        seenArtifact.set(artifact.sha256, artifact.path)
        continue
      }
      await fs.write(join(treeDir, artifact.path), artifact.content)
      seenArtifact.set(artifact.sha256, artifact.path)
      artifactPathsWritten.push(join(treeDir, artifact.path))
    }

    // 3. The chapter itself.
    await fs.write(chapterPath, chapter.markdown)

    // 4. Read-back verification. A file that does not come back byte-identical is not citable.
    const readBack = await fs.read(chapterPath)
    if (readBack === undefined) {
      warnings.push(`read-back failed (missing): ${chapterPath}`)
      continue
    }
    // Hash the whole file, so verifyChapter() can re-check it with no knowledge of frontmatter layout.
    const bodyHash = sha256(chapter.markdown)
    if (readBack !== chapter.markdown) {
      warnings.push(`read-back mismatch, refusing to cite: ${chapterPath}`)
      continue
    }
    if (chapter.stats.unrenderedSeqs.length > 0) {
      warnings.push(`${chapterPath}: ${chapter.stats.unrenderedSeqs.length} event(s) rendered no output (${chapter.stats.unrenderedSeqs.join(', ')})`)
    }
    if (chapter.stats.overTarget) {
      warnings.push(`${chapterPath}: ${chapter.stats.estimatedTokens} tokens over chapterTokenTarget — split at the next boundary, do not clip`)
    }

    records.push({
      number,
      path: chapterPath,
      title: chapter.range.title,
      summary: chapter.range.summary,
      startSeq: chapter.range.startSeq,
      endSeq: chapter.range.endSeq,
      topics: chapter.topics,
      sha256: bodyHash,
      estimatedTokens: chapter.stats.estimatedTokens,
      artifacts: chapter.artifacts.map((a: ArtifactRef) => ({ path: join(treeDir, a.path), sha256: a.sha256, bytes: a.bytes })),
    })
  }

  return { records, artifactPathsWritten, warnings }
}

/** Coverage arithmetic: which seqs below the ceiling were NOT archived. Gaps are reported, never silent. */
export function coverage(
  records: readonly { startSeq: number; endSeq: number }[],
  archiveCeiling: number,
  archiveFloor = 0,
): { covered: number; gaps: Array<{ from: number; to: number }> } {
  const sorted = [...records].sort((a, b) => a.startSeq - b.startSeq)
  const gaps: Array<{ from: number; to: number }> = []
  // Start at the floor, not at the first chapter: a set that skips the opening of the conversation is
  // exactly the silent-history-loss this function exists to catch.
  let cursor = archiveFloor
  let covered = 0
  for (const r of sorted) {
    if (r.startSeq > cursor) gaps.push({ from: cursor, to: r.startSeq - 1 })
    cursor = Math.max(cursor, r.endSeq + 1)
    covered += r.endSeq - r.startSeq + 1
  }
  if (cursor <= archiveCeiling) gaps.push({ from: cursor, to: archiveCeiling })
  return { covered, gaps }
}

export type VerifyResult = 'ok' | 'modified' | 'missing'

/** Called before citing a chapter in an index. Detects accidental drift and single-shot injection. */
export async function verifyChapter(fs: ArchiveFs, record: ChapterRecord): Promise<VerifyResult> {
  const text = await fs.read(record.path)
  if (text === undefined) return 'missing'
  if (sha256(text) !== record.sha256) return 'modified'
  return 'ok'
}
