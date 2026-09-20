import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEnrichInput, parseEnrichResult, applyEnrich } from '../../src/enrich.ts'

test('input assembly: capped parts, stable shape, hard total budget', () => {
  const input = buildEnrichInput(
    { title: 'x'.repeat(500) },
    { requests: ['r1', 'r2', 'r3', 'r4'], firstAssistant: 'a'.repeat(3000), lastAssistant: 'b' },
    'body '.repeat(3000),
  )
  assert.ok(input.length <= 8100, `budget: ${input.length}`)
  assert.ok(input.includes('REQUEST 2') && !input.includes('REQUEST 4'), 'last three requests only')
  assert.ok(input.includes('[truncated]'), 'caps are explicit, never silent')
})

test('validator: fences and prose tolerated; malformed or empty schemas rejected', () => {
  const good = '{"title": "T", "summary": "S sentence.", "topics": ["Auth", "retrieval  pipeline", "a".repeat(1)]}'
  assert.ok(parseEnrichResult('here you go:\n```json\n' + good.replace('"a".repeat(1)', '"x"') + '\n```\nthanks') !== null)
  assert.equal(parseEnrichResult('no json at all'), null)
  assert.equal(parseEnrichResult('{"title":"T","summary":"S"}'), null, 'missing topics')
  assert.equal(parseEnrichResult('{"title":"","summary":"S","topics":["a"]}'), null, 'blank title')
  assert.equal(parseEnrichResult('{"title":"T","summary":"S","topics":[123, "",  "   "]}'), null, 'no usable topic')
})

test('topics: cleaned, deduped, bounded to 10; title/summary clamped', () => {
  const many = Array.from({ length: 25 }, (_, i) => `Topic-${i} ["weird"]`)
  const r = parseEnrichResult(JSON.stringify({ title: 'T'.repeat(500), summary: 'S'.repeat(2000), topics: many }))!
  assert.equal(r.topics.length, 10)
  assert.ok(r.topics[0] === 'topic-0 weird'.replace(' ', ' '), `got ${r.topics[0]}`)
  assert.ok(!r.topics[0]!.includes('"') && !r.topics[0]!.includes('['))
  assert.ok(r.title.length <= 160 && r.summary.length <= 600)
})

test('applyEnrich: null result is a pure no-op; same values+model idempotent; new model updates provenance chain', () => {
  const base = { title: 'det', summary: 'ds', topics: ['tp'] }
  assert.deepEqual(applyEnrich(base, null, 'm1', 't1'), { values: base, changed: false }, 'failure ladder keeps deterministic')
  const r = { title: 'model title', summary: 'model summary', topics: ['alpha'] }
  const first = applyEnrich(base, r, 'm1', 't1')
  assert.ok(first.changed && first.values.generated?.title[0]?.by === 'model')
  const second = applyEnrich(first.values, r, 'm1', 't2')
  assert.equal(second.changed, false, 're-run same model+values = no-op (exit criterion: idempotent)')
  const third = applyEnrich(first.values, { ...r, title: 'better' }, 'm2', 't3')
  assert.ok(third.changed && third.values.title === 'better')
  assert.equal(third.values.generated?.title.length, 2, 'chain grows newest-first, one entry per model')
  assert.ok(third.values.generated?.title[0]?.by === 'model' && (third.values.generated?.title[0] as { model?: string }).model === 'm2')
  assert.ok((third.values.generated?.title[1] as { model?: string }).model === 'm1', 'previous author retained')
})
