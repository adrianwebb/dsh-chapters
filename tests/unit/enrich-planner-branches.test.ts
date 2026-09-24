/**
 * Third pure sweep: the enrichment validator/merger, the size-based range
 * planner, and the scoring helpers — every `null`-return, cap, and age band
 * is an explicit decision the code makes, and each deserves a witness.
 * (The ladder itself is pinned in enrich-wire.test.ts; this is the pure
 * material the ladder stands on.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEnrichInput, parseEnrichResult, applyEnrich, type CurrentValues } from '../../src/enrich.ts'
import { deriveRanges, refusalResult, Refusal } from '../../src/continue-core.ts'
import { baseScore, scoreEntry } from '../../src/search.ts'
import type { IndexEntry } from '../../src/indexing.ts'
import type { SessionEventLike } from '../../src/types.ts'

// ---------------------------------------------------------- parseEnrichResult

test('parseEnrichResult: the tolerant reader and its hard gates', () => {
  const good = parseEnrichResult('{"title":"Auth work","summary":"Bearer rotation","topics":["auth","tokens"]}')
  assert.ok(good !== null)
  assert.deepEqual(good.topics, ['auth', 'tokens'])
  // code fences + surrounding prose are extracted, not rejected
  assert.ok(parseEnrichResult('Sure! ```json\n{"title":"T","summary":"S here","topics":["x","y"]}\n``` hope that helps') !== null)
  // every rejection arm
  assert.equal(parseEnrichResult('no json at all here'), null)
  assert.equal(parseEnrichResult('{this, is, not, json}'), null)
  assert.equal(parseEnrichResult('["an","array"]'), null, 'non-object JSON rejected')
  assert.equal(parseEnrichResult('{"title":"T","summary":"S"}'), null, 'topics missing')
  assert.equal(parseEnrichResult('{"title":"  ","summary":"S","topics":["a"]}'), null, 'empty title')
  assert.equal(parseEnrichResult('{"title":"T","summary":"S","topics":["unusable \"quoted\""]}'), null, 'only-illegal topics → null')
  // caps clamp, never reject
  const long = parseEnrichResult(JSON.stringify({ title: 't'.repeat(300), summary: 's'.repeat(900), topics: Array.from({ length: 30 }, (_, i) => `topic${i}`) }))
  assert.ok(long !== null)
  assert.ok(long.title.length <= 160 && long.summary.length <= 600 && long.topics.length <= 10)
})

// ---------------------------------------------------------- applyEnrich

const cur = (over: Partial<CurrentValues> = {}): CurrentValues =>
  ({ title: 'given', summary: 'det summary', topics: ['src/a.ts'], ...over })

test('applyEnrich: null bottoms out as a PURE no-op; first model stamps provenance', () => {
  const noop = applyEnrich(cur(), null, 'm/1', 'at')
  assert.equal(noop.changed, false)
  assert.deepEqual(noop.values, cur(), 'values untouched byte-identically')
  const first = applyEnrich(cur(), { title: 'Fresh', summary: 'Better summary', topics: ['x'] }, 'm/1', '2026-01-01T00:00:00Z')
  assert.equal(first.changed, true)
  assert.equal(first.values.generated?.title[0]?.by, 'model')
  assert.equal(first.values.generated?.title[1]?.by, undefined, 'first model entry has no predecessor chain')
  // idempotent re-run by the same author: no-op
  const idem = applyEnrich(first.values, { title: 'Fresh', summary: 'Better summary', topics: ['x'] }, 'm/1', '2026-01-02T00:00:00Z')
  assert.equal(idem.changed, false, 'same values + same newest author')
  // a NEWER model re-annotating: chain grows newest-first, same-model duplicates pruned
  const second = applyEnrich(first.values, { title: 'Fresher', summary: 'Better summary', topics: ['x'] }, 'm/2', '2026-01-02T00:00:00Z')
  assert.equal(second.changed, true)
  assert.equal(second.values.generated?.title[0]?.by, 'model')
  assert.equal((second.values.generated?.title[0] as { model?: string }).model, 'm/2')
  assert.equal((second.values.generated?.title[1] as { model?: string }).model, 'm/1', 'history preserved newest-first')
})

// ---------------------------------------------------------- buildEnrichInput

test('buildEnrichInput: optional slices included only when present; hard budget holds', () => {
  const lean = buildEnrichInput({ title: 'T' }, { requests: [] }, 'body head text')
  assert.ok(!lean.includes('FIRST ASSISTANT') && !lean.includes('LAST ASSISTANT'), 'absent fields never appear')
  assert.ok(!lean.includes('REQUEST 1'))
  const rich = buildEnrichInput({ title: 'T' }, { requests: ['r1', 'r2', 'r3', 'r4'], firstAssistant: 'fa', lastAssistant: 'la' }, 'b')
  assert.ok(rich.includes('FIRST ASSISTANT') && rich.includes('LAST ASSISTANT'))
  assert.ok(rich.includes('REQUEST 1: r2') && rich.includes('REQUEST 3: r4'), 'the LAST 3 requests ride, renumbered from 1')
  assert.ok(!rich.includes('r1 '), 'oldest request dropped')
  // every field is capped at its own limit and truncation is EXPLICIT there
  const huge = buildEnrichInput({ title: 'T'.repeat(5000) }, { requests: ['x'.repeat(2000)], firstAssistant: 'y'.repeat(2000) }, 'z'.repeat(20000))
  assert.match(huge, /CURRENT TITLE: T+ …\[truncated\]/, 'per-field caps, not silent clips')
  assert.ok(huge.length <= 8000, 'the per-field caps make the 8K total-cut UNREACHABLE (dead defense)')
  // NOTE: the `text.length > TOTAL_IN_CAP` branch is provably dead — every
  // part is cap()'d (PART_CAP 1200, body 800, title 160) so the sum stays
  // under 8000. It is kept as a belt-and-braces guard; flagged here so the
  // reader knows the uncovered branch is intentional, not a testing gap.
})

// ---------------------------------------------------------- deriveRanges

const turn = (seq: number): SessionEventLike => ({ type: 'turn/end', seq, data: {} })
const msg = (seq: number, text: string, type = 'user/message'): SessionEventLike =>
  ({ type, seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })

test('deriveRanges: refusal arms read truthfully for both watermark states', () => {
  assert.throws(() => deriveRanges([msg(0, 'hello')], 0, 4000), /no completed turn/)
  assert.throws(() => deriveRanges([msg(0, 'hello'), turn(1)], 1, 4000, 2), /nothing new to archive/)
  // note emitted when the anchor sits inside an unfinished turn
  const events = [msg(0, 'a'), turn(1), msg(2, 'b'), msg(3, 'c')]
  const r = deriveRanges(events, 2, 4000)
  assert.equal(r.chapters.length, 1)
  assert.ok(r.notes.some((n) => /not a turn boundary/.test(n)))
  assert.equal(r.chapters[0].endSeq, 1, 'segmentation ran to the last real boundary')
  // multi-boundary splitting under a tiny target
  const many = [msg(0, 'x'.repeat(400)), turn(1), msg(2, 'y'.repeat(400)), turn(3), msg(4, 'z'), turn(5)]
  const split = deriveRanges(many, 5, 10)
  assert.ok(split.chapters.length >= 2, `tiny target forces cuts: ${split.chapters.length}`)
  // titles numbered by position, summaries carry the event span
  assert.match(split.chapters[0].title, /\(1\)$/)
  assert.match(split.chapters[0].summary, /^events \d+-\d+; /)
})

// ---------------------------------------------------------- refusalResult

test('refusalResult separates our refusals from foreign errors', () => {
  assert.equal(refusalResult(new Error('boom')), null)
  const ref = new Refusal({ ok: false, reason: 'because' })
  assert.equal(refusalResult(ref)?.reason, 'because')
})

// ---------------------------------------------------------- search scoring

const entry = (over: Partial<IndexEntry>): IndexEntry =>
  ({ path: 'chapters/K/s/1.md', title: 'Auth token rotation', topics: ['auth'], kind: 'chapter', ...over })

test('baseScore: topic×2, category×1.5, title×1, summary×1 — zeros stay zeros', () => {
  const terms = ['auth', 'rotation', 'deep']
  assert.equal(baseScore(entry({ topics: ['unrelated'] }), ['zzz'], ''), 0, 'no match is a hard zero')
  const s = baseScore(entry({}), terms, 'deep details here')
  assert.ok(s >= 2 + 1 + 1, 'topic + title + summary all land')
  const cat = baseScore(entry({ kind: 'rule', category: 'auth' }), ['auth'], '')
  assert.ok(cat > baseScore(entry({}), ['auth'], '')), 'category adds its 1.5'
})

test('scoreEntry recency bands: ≤30 days, ≤180, older, and missing mtime', () => {
  const now = Date.now()
  const DAY = 86_400_000
  const base = { terms: ['auth'], summary: '' }
  const fresh = scoreEntry(entry({ mtime: now - 2 * DAY }), base.terms, now, base.summary)
  const mid = scoreEntry(entry({ mtime: now - 100 * DAY }), base.terms, now, base.summary)
  const old = scoreEntry(entry({ mtime: now - 400 * DAY }), base.terms, now, base.summary)
  const noMtime = scoreEntry(entry({}), base.terms, now, base.summary)
  assert.ok(fresh > mid && mid > old, 'recency decays in bands')
  assert.ok(old < fresh && noMtime <= old + 0.0001, 'missing mtime gets no bonus')
})
