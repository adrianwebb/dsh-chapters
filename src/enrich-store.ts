/**
 * P2 S3 — provenance persistence (record §2.4/§6.2): the ONLY sanctioned
 * chapter-file mutation in the system.
 *
 * A chapter file = YAML frontmatter + verbatim body. Enrichment may rewrite
 * frontmatter fields it owns (title/summary/topics/generated); the body is
 * untouchable, so EVERY write re-verifies the body hash before committing
 * and refuses, loudly, on any mismatch. Frontmatter edits are LINE-BASED
 * minimal replacements (order and unknown lines preserved — the file's own
 * renderer stays the authority on shape); the write is atomic (tmp+rename);
 * provenance chains grow, never truncate.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const FM_DELIM = '---'

export interface ChapterDoc {
  /** raw frontmatter lines (between the --- fences), verbatim */
  fmLines: string[]
  body: string
}

export function parseChapterFile(text: string): ChapterDoc {
  if (!text.startsWith(`${FM_DELIM}\n`)) throw new Error('chapter file lacks frontmatter')
  let endLine = -1
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FM_DELIM) { endLine = i; break }
  }
  if (endLine === -1) throw new Error('unterminated frontmatter')
  return { fmLines: lines.slice(1, endLine), body: lines.slice(endLine + 1).join('\n') }
}

export const bodyHash = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')

/** replace-or-append one top-level key; block values arrive as multi-line strings */
function setFmLine(lines: string[], key: string, value: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l))
  const replacement = value.split('\n').map((l, i) => (i === 0 ? `${key}: ${l}` : l))
  if (start === -1) return [...lines, ...replacement]
  let end = start + 1
  while (end < lines.length && /^\s/.test(lines[end]!)) end++
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)]
}

/**
 * Apply minimal frontmatter updates, body-guaranteed. expectedBodySha256
 * comes from the registry record; the file may also declare bodySha256 — any
 * disagreement between available sources is a loud refusal, no write.
 */
export function updateChapterFrontmatter(
  filePath: string,
  updates: Record<string, string>,
  expectedBodySha256?: string,
): { changed: boolean; body: string } {
  const text = fs.readFileSync(filePath, 'utf8')
  const doc = parseChapterFile(text)
  const hash = bodyHash(doc.body)
  // self-consistency: a declared bodySha256 that no longer matches the body
  // means on-disk corruption — refuse before anything else
  // render.ts anchors the body hash under 'sha256:' — accept either name as
  // the declared guard value
  const declared = doc.fmLines.find((l) => /^(?:bodySha256|sha256):/.test(l))?.split(': ')[1]?.trim()
  if (declared !== undefined && declared !== hash) {
    throw new Error(`refusing to touch ${filePath}: declared body hash ${declared.slice(0, 12)}… != computed ${hash.slice(0, 12)}… — body altered on disk`)
  }
  if (expectedBodySha256 !== undefined && expectedBodySha256 !== hash) {
    throw new Error(`refusing to rewrite ${filePath}: body hash ${hash.slice(0, 12)}… != registry ${expectedBodySha256.slice(0, 12)}… — the verbatim body must never change`)
  }
  let fm = doc.fmLines
  let changed = false
  for (const [k, v] of Object.entries(updates)) {
    const next = setFmLine(fm, k, v)
    if (next.join('\n') !== fm.join('\n')) { fm = next; changed = true }
  }
  if (!changed) return { changed: false, body: doc.body }
  // every sanctioned write carries a body anchor; render.ts names it sha256
  if (!fm.some((l) => /^(?:bodySha256|sha256):/.test(l))) fm = setFmLine(fm, 'sha256', hash)
  const nextText = `${FM_DELIM}\n${fm.join('\n')}\n${FM_DELIM}\n${doc.body}`
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`)
  fs.writeFileSync(tmp, nextText)
  fs.renameSync(tmp, filePath)
  return { changed: true, body: doc.body }
}

/** YAML-ish serializer for the provenance chain (nested block, newest first) */
export function renderGeneratedBlock(chain: { by: string; model?: string; at?: string }[]): string {
  const inner = chain.map((m) => m.by === 'model' ? `\n    - by: model\n      model: ${m.model}\n      at: ${m.at ?? ''}` : '\n    - by: deterministic')
  return inner.join('')
}
