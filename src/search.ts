/**
 * Knowledge search (knowledge-repo.md §8): a DETERMINISTIC scorer over the
 * mirrored corpus (the clone is the corpus — it holds local + pulled files),
 * packed to a token budget the AGENT chooses (it knows its window; we
 * measure with the project's one estimator). No model in the loop, ever —
 * reproducible, inspectable, and free.
 */
import fs from 'node:fs'
import path from 'node:path'
import { entryFromChapter, type IndexEntry } from './indexing.ts'
import { estimateTokens } from './render.ts'
import { stitchFragments } from './indexing.ts'

export interface SearchResult {
  score: number
  date: string
  kind: 'chapter' | 'rule'
  title: string
  path: string
  /** S5 stitch view: every member file behind a coherented entry. */
  paths?: string[]
  topics: string[]
}

export interface SearchOutcome {
  results: SearchResult[]
  /** Every match found (results may be a packed prefix of this). */
  total: number
  shown: number
  budget: { requested: number; used: number; remaining: number }
  line: string
}

const DAY = 24 * 60 * 60 * 1000

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9/._-]+/).filter((t) => t.length >= 2 && t !== 'the' && t !== 'and')

const recencyBonus = (mtime: number | undefined, now: number): number => {
  if (mtime === undefined) return 0
  const ageDays = (now - mtime) / DAY
  if (ageDays <= 30) return 1
  if (ageDays <= 180) return 0.5
  return 0
}

/** Term-hit score: topic hits 2x, title 1x, summary 1x. Zero = no match, full stop. */
export function baseScore(entry: IndexEntry, terms: readonly string[], summary: string): number {
  let score = 0
  for (const t of terms) {
    if (entry.topics.some((topic) => topic.toLowerCase().includes(t))) score += 2
    if (entry.title.toLowerCase().includes(t)) score += 1
    if (summary.toLowerCase().includes(t)) score += 1
  }
  return score
}

/**
 * The full score: term hits plus a recency tie-break. Recency ONLY breaks
 * ties between real matches — a fresh mtime must never rank an entry that
 * matches no term (that would surface unrelated fresh files on any query).
 */
export function scoreEntry(entry: IndexEntry, terms: readonly string[], now: number, summary: string): number {
  const base = baseScore(entry, terms, summary)
  return base === 0 ? 0 : base + recencyBonus(entry.mtime, now)
}

/** Load the corpus from a clone directory: chapters + rules, frontmatter-parsed. */
export function loadCorpus(cloneDir: string): { entries: IndexEntry[]; summaries: Map<string, string> } {
  const entries: IndexEntry[] = []
  const summaries = new Map<string, string>()
  // rel paths mirror the REPO layout (chapters/<key>/…, rules/<key>/…) so
  // search results are directly readable paths and project scoping is a
  // prefix match on the second path segment.
  const collect = (top: string, kind: 'chapter' | 'rule') => {
    const root = path.join(cloneDir, top)
    if (!fs.existsSync(root)) return
    const walk = (dir: string, rel: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p, rel === '' ? e.name : path.join(rel, e.name)); continue }
        if (e.name.endsWith('.md')) {
          const relPath = rel === '' ? e.name : path.join(rel, e.name)
          const text = fs.readFileSync(p, 'utf8')
          const entry = entryFromChapter(path.join(top, relPath), text, fs.statSync(p).mtimeMs)
          entries.push({ ...entry, kind })
          const fm = /^---[\s\S]*?summary:\s*(.*)$/m.exec(text)
          if (fm !== null) summaries.set(entry.path, fm[1]!.trim().replace(/^"|"$/g, ''))
        }
      }
    }
    walk(root, '')
  }
  collect('chapters', 'chapter')
  collect('rules', 'rule')
  return { entries: stitchFragments(entries), summaries } // S5: search sees stitched views too
}

/**
 * The search itself: score, sort (score desc, then path for determinism),
 * format lines `score | date | kind | title | path (topics: …)`, and pack
 * lines to the requested token budget. The agent sees `total` vs `shown` so
 * it can re-request with a larger budget — no silent truncation.
 */
export function searchKnowledge(
  cloneDir: string,
  query: string,
  maxTokens: number,
  opts: { now?: number; projectKey?: string } = {},
): SearchOutcome {
  const now = opts.now ?? Date.now()
  const terms = tokenize(query)
  if (terms.length === 0) {
    return { results: [], total: 0, shown: 0, budget: { requested: maxTokens, used: 0, remaining: maxTokens }, line: '' }
  }
  const { entries, summaries } = loadCorpus(cloneDir)
  const scoped = opts.projectKey !== undefined
    ? entries.filter((e) => e.path.startsWith(`chapters/${opts.projectKey}`) || e.path.startsWith(`rules/${opts.projectKey}`))
    : entries
  const scored = scoped
    .map((e) => ({ e, score: scoreEntry(e, terms, now, summaries.get(e.path) ?? '') }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.e.path < b.e.path ? -1 : 1))
  const results: SearchResult[] = scored.map((s) => ({
    score: Number(s.score.toFixed(2)),
    date: s.e.mtime !== undefined ? new Date(s.e.mtime).toISOString().slice(0, 10) : '----',
    kind: s.e.kind,
    title: s.e.title,
    path: s.e.path,
    ...(s.e.paths !== undefined ? { paths: s.e.paths } : {}),
    topics: s.e.topics,
  }))
  const lines: string[] = []
  let used = 0
  for (const r of results) {
    const line = `${r.score.toFixed(2)} | ${r.date} | ${r.kind} | ${r.title} | ${r.path}${r.paths !== undefined && r.paths.length > 1 ? ` [+${r.paths.length - 1} stitched part(s)]` : ''}${r.topics.length > 0 ? ` (topics: ${r.topics.join(', ')})` : ''}`
    const cost = estimateTokens(line)
    if (lines.length > 0 && used + cost > maxTokens) break
    lines.push(line)
    used += cost
  }
  return {
    results: results.slice(0, lines.length),
    total: results.length,
    shown: lines.length,
    budget: { requested: maxTokens, used, remaining: Math.max(0, maxTokens - used) },
    line: lines.join('\n'),
  }
}
