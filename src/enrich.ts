/**
 * P2 S1 — the enrichment pass, pure core (record §6.1).
 *
 * One structured call per ARCHIVED chapter, input = the cheap slice the user
 * specified (user requests + first/last assistant message, capped, plus the
 * first ~200 tokens of the chapter body), output = validated JSON:
 *   {"title": "...", "summary": "...", "topics": ["...", ...]}
 *
 * No fs, no harness, no model here — the queue (S2) wires the fetcher. This
 * module guarantees the properties the record stakes:
 *   - VALIDATION BEFORE COMMIT: parseEnrichResult accepts nothing malformed;
 *   - NEVER BLOCKS OR BLANKS: applyEnrich(null) is a pure no-op — the
 *     deterministic title/summary/topics from P1 survive any model failure.
 */

export interface EnrichSlice {
  requests: string[]
  firstAssistant?: string
  lastAssistant?: string
}

export interface EnrichResult {
  title: string
  summary: string
  topics: string[]
}

export type GeneratedMark =
  | { by: 'deterministic' }
  | { by: 'model', model: string, at: string }

export interface GeneratedProvenance {
  title: GeneratedMark[]
  summary: GeneratedMark[]
  topics: GeneratedMark[]
}

export type EnrichableFields = 'title' | 'summary' | 'topics'

const TITLE_CAP = 160
const SUMMARY_CAP = 600
const TOPIC_MAX = 10
const TOPIC_LEN = 48
const PART_CAP = 1200
const TOTAL_IN_CAP = 8000
const BODY_HEAD_TOKENS = 200

export const ENRICH_MAX_TOKENS = 350

const INSTRUCTION =
  'You annotate one archived chapter of a coding-agent conversation for retrieval. '
  + 'Reply with ONLY one JSON object, no prose, no code fences, shaped exactly: '
  + '{"title": "<one descriptive sentence, <=120 chars>", "summary": "<2-3 informative sentences>", "topics": ["<lowercase short labels, 3 to 10>"]}. '
  + 'Topics are semantic labels (concepts, not file paths). Base everything strictly on the material below.'

/** cap a piece of the slice; truncation is EXPLICIT, never silent. */
function cap(text: string, n: number): string {
  const t = text.trim()
  if (t.length <= n) return t
  return t.slice(0, n) + ' …[truncated]'
}

/**
 * Assemble the model input: capped slice, stable order, hard total budget.
 * Deterministic — same chapter material always produces the same prompt,
 * which is what makes the queue's chapter+model idempotency key sound.
 */
export function buildEnrichInput(meta: { title: string }, slice: EnrichSlice, bodyHead: string): string {
  const parts: string[] = [INSTRUCTION, '', `CURRENT TITLE: ${cap(meta.title, TITLE_CAP)}`]
  if (slice.firstAssistant !== undefined) parts.push(`FIRST ASSISTANT: ${cap(slice.firstAssistant, PART_CAP)}`)
  if (slice.lastAssistant !== undefined) parts.push(`LAST ASSISTANT: ${cap(slice.lastAssistant, PART_CAP)}`)
  for (const [i, r] of slice.requests.slice(-3).entries()) parts.push(`REQUEST ${i + 1}: ${cap(r, PART_CAP)}`)
  parts.push('', 'CHAPTER BODY (opening):', cap(bodyHead, BODY_HEAD_TOKENS * 4))
  let text = parts.join('\n')
  if (text.length > TOTAL_IN_CAP) text = text.slice(0, TOTAL_IN_CAP) + '\n…[input truncated]'
  return text
}

/** label sanitizer: lowercase, bracket/quote-free, bounded; null if unusable. */
function cleanTopic(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase().replace(/["'`[\]{}()<>|\\]/g, '').replace(/\s+/g, ' ').trim()
  if (t.length === 0 || t.length > TOPIC_LEN) return null
  return t
}

/**
 * The validator. Tolerates code fences and surrounding prose (extracts the
 * first JSON object), then requires every field well-shaped. Returns null —
 * never throws — on ANY failure; the retry-then-keep-deterministic ladder is
 * the caller's loop by design.
 */
export function parseEnrichResult(text: string): EnrichResult | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m === null) return null
  let obj: unknown
  try { obj = JSON.parse(m[0]) } catch { return null }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  if (typeof o.title !== 'string' || typeof o.summary !== 'string' || !Array.isArray(o.topics)) return null
  const title = o.title.trim()
  const summary = o.summary.trim()
  if (title.length === 0 || summary.length === 0) return null
  const topics: string[] = []
  for (const t of o.topics) {
    const c = cleanTopic(t)
    if (c !== null && !topics.includes(c)) topics.push(c)
    if (topics.length >= TOPIC_MAX) break
  }
  if (topics.length === 0) return null
  return {
    title: title.slice(0, TITLE_CAP),
    summary: summary.slice(0, SUMMARY_CAP),
    topics,
  }
}

export interface CurrentValues {
  title: string
  summary: string
  topics: string[]
  generated?: Partial<GeneratedProvenance>
}

/**
 * Merge an enrichment result into the chapter's model-owned fields.
 * - result === null (ladder bottomed out) → PURE no-op, values + provenance
 *   untouched (deterministic P1 values survive forever).
 * - same values AND same newest model author → no-op (idempotent re-run).
 * - otherwise: fields update; each provenance chain grows newest-first, one
 *   entry per model (re-annotation by a newer model never erases history).
 * The verbatim BODY is not in this module's universe — callers may only
 * rewrite frontmatter fields (record §6.2), body hash-verified elsewhere.
 */
export function applyEnrich(
  current: CurrentValues,
  result: EnrichResult | null,
  model: string,
  at: string,
): { values: CurrentValues; changed: boolean } {
  if (result === null) return { values: current, changed: false }
  const sameValues = current.title === result.title
    && current.summary === result.summary
    && current.topics.join('\u0000') === result.topics.join('\u0000')
  const authoredBySame = (['title', 'summary', 'topics'] as const).every((f) => {
    const top = current.generated?.[f]?.[0]
    return top?.by === 'model' && (top as { model?: string }).model === model
  })
  if (sameValues && authoredBySame) return { values: current, changed: false }
  const gen: GeneratedProvenance = { title: [], summary: [], topics: [] }
  const mark: GeneratedMark = { by: 'model', model, at }
  for (const f of ['title', 'summary', 'topics'] as const) {
    const chain = current.generated?.[f] ?? []
    gen[f] = [mark, ...chain.filter((c) => !(c.by === 'model' && (c as { model?: string }).model === model))]
  }
  return { values: { ...current, title: result.title, summary: result.summary, topics: result.topics, generated: gen }, changed: true }
}
