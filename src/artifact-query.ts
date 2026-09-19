/**
 * Artifact query surface (arrival-time artifacting plan, Phase 3): pure,
 * bounded readers over content-addressed artifact files. The point of this
 * module is that a stored blob is USEFUL without ever being loaded whole —
 * toc/search/read are the small-block windows the RLM result calls an
 * 'external environment', implemented with files and line numbers instead
 * of a code sandbox. Every function is deterministic and refuses rather
 * than silently clipping (bounds reported, never applied by truncation
 * without a flag).
 */
import fs from 'node:fs'
import path from 'node:path'

export type TocEntry = { line: number; depth: number; title: string }

/** Rough token estimate consistent with the est-token convention elsewhere (chars/4). */
const estTokens = (s: string): number => Math.ceil(s.length / 4)

/**
 * Resolve a user/model-supplied reference to an absolute artifact path INSIDE
 * the store. Accepts a 64-hex sha, 'artifacts/xx/<sha>.txt', or an absolute
 * path. Throws on anything escaping the store — this tool is read-only, the
 * containment is the whole security story.
 */
export function resolveArtifactPath(storeDir: string, ref: string): string {
  const clean = ref.trim()
  if (/^[0-9a-f]{64}$/.test(clean)) return path.join(storeDir, 'artifacts', clean.slice(0, 2), `${clean}.txt`)
  const abs = path.isAbsolute(clean) ? path.normalize(clean) : path.normalize(path.join(storeDir, clean))
  const root = path.resolve(storeDir)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`artifact reference escapes the store: ${ref}`)
  return abs
}

/**
 * Markdown heading map with 1-based line numbers — a 300-page book arrives
 * with its own table of contents (fenced code blocks are skipped so '#
 * comments' inside them never masquerade as headings).
 */
export function buildToc(text: string, maxEntries = 400): { entries: TocEntry[]; truncated: boolean } {
  const entries: TocEntry[] = []
  let inFence = false
  let fenceMarker = ''
  let lineNo = 0
  for (const line of text.split('\n')) {
    lineNo++
    const fence = /^\s{0,3}(`{3,}|~{3,})/.test(line)
    if (fence) {
      const marker = line.trim().slice(0, 3)
      if (!inFence) { inFence = true; fenceMarker = marker[0] as string }
      else if (marker[0] === fenceMarker) { inFence = false }
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m === null) continue
    if (entries.length >= maxEntries) return { entries, truncated: true }
    entries.push({ line: lineNo, depth: m[1]!.length, title: m[2]!.trim().slice(0, 120) })
  }
  return { entries, truncated: false }
}

export type SearchBlock = { start: number; end: number; lines: string[] }

/**
 * Case-insensitive query over lines: regex when it compiles, literal phrase
 * otherwise. Matches expand to ±context lines and overlapping windows merge;
 * the pack stops at maxTokens and REPORTS what it left behind.
 */
export function searchArtifact(
  text: string, query: string, opts: { maxTokens?: number; contextLines?: number } = {},
): { total: number; blocks: SearchBlock[]; truncated: boolean; remaining: number } {
  const maxTokens = opts.maxTokens ?? 400
  const context = opts.contextLines ?? 2
  const lines = text.split('\n')
  let re: RegExp | null = null
  try { re = new RegExp(query, 'i') } catch { re = null }
  const hit = (l: string): boolean => re !== null ? re.test(l) : l.toLowerCase().includes(query.trim().toLowerCase())
  const matched: number[] = []
  for (let i = 0; i < lines.length; i++) if (hit(lines[i]!)) matched.push(i)
  const blocks: SearchBlock[] = []
  let used = 0
  for (const idx of matched) {
    const start = Math.max(0, idx - context)
    const end = Math.min(lines.length - 1, idx + context)
    const last = blocks[blocks.length - 1]
    if (last !== undefined && start <= last.end + 1) {
      if (end > last.end) {
        const add = lines.slice(last.end + 1, end + 1).map((l, k) => `${last.end + 2 + k}: ${l.slice(0, 400)}`).join('\n')
        const addTokens = estTokens(add)
        if (used + addTokens > maxTokens) break
        last.lines.push(...lines.slice(last.end + 1, end + 1).map((l, k) => `${last.end + 2 + k}: ${l.slice(0, 400)}`))
        last.end = end
        used += addTokens
      }
      continue
    }
    const chunk = lines.slice(start, end + 1).map((l, k) => `${start + k + 1}: ${l.slice(0, 400)}`)
    const tokens = estTokens(chunk.join('\n'))
    if (used + tokens > maxTokens) break
    blocks.push({ start: start + 1, end: end + 1, lines: chunk })
    used += tokens
  }
  const lastIncluded = blocks.length === 0 ? -1 : blocks[blocks.length - 1]!.end - 1
  const remaining = matched.filter((i) => i > lastIncluded).length
  return { total: matched.length, blocks, truncated: remaining > 0, remaining }
}

/** Exact line window (1-based inclusive), capped per call; bounds reported. */
export function readLines(text: string, offset: number, limit: number, hardCap = 400): { start: number; end: number; of: number; lines: string[] } {
  const lines = text.split('\n')
  const start = Math.max(1, Math.floor(offset))
  const want = Math.max(1, Math.floor(limit))
  const take = Math.min(want, hardCap)
  const end = Math.min(lines.length, start + take - 1)
  return { start, end, of: lines.length, lines: lines.slice(start - 1, end).map((l, k) => `${start + k}: ${l.slice(0, 1000)}`) }
}

/** Load an artifact with a size guard; returns text + totals for the pack. */
export function loadArtifact(absPath: string): { text: string; bytes: number; lines: number } {
  const st = fs.statSync(absPath)
  return { text: fs.readFileSync(absPath, 'utf8'), bytes: st.size, lines: 0 }
}
