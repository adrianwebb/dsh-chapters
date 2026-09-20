/**
 * P2 S4 — the emergent vocabulary canonicalizer (record §6.3). Pure functions
 * over topic lists; the sync pass feeds it chapter topics and applies (or,
 * in shadow mode, merely reports) the merge candidates.
 *
 * No seed lists, no hand-editing expectation: plugin-owned curation entries,
 * every one carrying its signal + counts, written to
 * `edits/<harnessId>/curation.jsonl` — git-visible, revertible, and already
 * consumed by the index build (P1 plumbing).
 */

export interface VocabOpts {
  coMin: number       // co-occurrence count across chapters to trust a merge
  overlapMin: number  // token-set Jaccard threshold
}

export interface VocabCandidate {
  from: string
  to: string
  cooccur: number
  overlap: number
  reason: 'co-occurrence' | 'alias-pattern' | 'token-overlap'
}

const tokenize = (t: string): Set<string> =>
  new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((s) => s.length > 0))

const stem = (tok: string): string => (tok.length > 3 && tok.endsWith('s') ? tok.slice(0, -1) : tok)

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** one token is a prefix of the other, or equal after plural stemming */
const aliasPattern = (a: string, b: string): boolean => {
  const ta = [...tokenize(a)], tb = [...tokenize(b)]
  if (ta.length === 0 || tb.length === 0) return false
  const pa = ta[0]!, pb = tb[0]!
  if (ta.length === 1 && tb.length === 1) {
    if (pa !== pb && (pa.startsWith(pb) || pb.startsWith(pa))) return true
    if (stem(pa) === stem(pb) && pa !== pb) return true
  }
  return false
}

/**
 * Candidates over a corpus of per-chapter topic lists. Canonical direction:
 * the MORE FREQUENT label survives (`to`); alphabetical tie-break. Pairs
 * already aliased (either direction) are skipped by the caller — this module
 * only proposes, applying and deduping against existing entries is the pass.
 */
export function analyzeTopics(
  chapterTopics: string[][],
  opts: VocabOpts,
): { candidates: VocabCandidate[]; frequency: Map<string, number> } {
  const frequency = new Map<string, number>()
  const cooc = new Map<string, number>()
  for (const topics of chapterTopics) {
    const uniq = [...new Set(topics.map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0))]
    for (const t of uniq) frequency.set(t, (frequency.get(t) ?? 0) + 1)
    for (let i = 0; i < uniq.length; i++) {
      for (let k = i + 1; k < uniq.length; k++) {
        const key = [uniq[i]!, uniq[k]!].sort().join('\u0000')
        cooc.set(key, (cooc.get(key) ?? 0) + 1)
      }
    }
  }
  const labels = [...frequency.keys()].sort()
  const candidates: VocabCandidate[] = []
  for (let i = 0; i < labels.length; i++) {
    for (let k = i + 1; k < labels.length; k++) {
      const a = labels[i]!, b = labels[k]!
      const overlap = jaccard(tokenize(a), tokenize(b))
      const alias = aliasPattern(a, b)
      const co = cooc.get([a, b].sort().join('\u0000')) ?? 0
      const byFreq = (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0)
      const from = byFreq < 0 ? b : a
      const to = byFreq < 0 ? a : b
      let reason: VocabCandidate['reason'] | null = null
      if (alias) reason = 'alias-pattern'
      else if (co >= opts.coMin) reason = 'co-occurrence'
      else if (overlap >= opts.overlapMin) reason = 'token-overlap'
      if (reason === null) continue
      candidates.push({ from, to, cooccur: co, overlap: Number(overlap.toFixed(3)), reason })
    }
  }
  candidates.sort((x, y) => x.from < y.from ? -1 : x.from > y.from ? 1 : 0)
  return { candidates, frequency }
}

/**
 * The curation lines to append (topic-alias facts) given the aliases already
 * known. A 'from' already aliased (anywhere in the chain) is skipped, and
 * chains are resolved to their final target so we never write a->b when b
 * already maps to c (write a->c instead — deterministic, order-independent).
 */
export function planAppends(
  candidates: VocabCandidate[],
  existing: Map<string, string>,
  at: string,
): { lines: string[]; plan: VocabCandidate[] } {
  const resolve = (label: string, depth = 0): string => {
    if (depth > 10) return label
    const next = existing.get(label)
    return next === undefined || next === label ? label : resolve(next, depth + 1)
  }
  const plan: VocabCandidate[] = []
  const seen = new Map(existing)
  const lines: string[] = []
  for (const c of candidates) {
    // a RAW 'from' that already aliases is stale by definition (skip); the
    // target folds forward through known chains so we never write into the
    // middle of one (a->b when b->c exists becomes a->c)
    if (existing.has(c.from) || seen.has(c.from)) continue
    const to = resolve(c.to)
    const from = c.from
    if (from === to) continue
    seen.set(from, to)
    const entry = { ...c, from, to }
    plan.push(entry)
    // topic-alias matches the index layer's CurationFact; the reason/count
    // payload is carried alongside (parseCuration ignores unknown keys) so
    // every merge is self-documenting in git
    lines.push(JSON.stringify({ type: 'topic-alias', from, to, at, reason: `${entry.reason}: cooccur=${entry.cooccur} overlap=${entry.overlap}` }))
  }
  return { lines, plan }
}
