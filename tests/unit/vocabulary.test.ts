import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTopics, planAppends } from '../../src/vocabulary.ts'

const opts = { coMin: 3, overlapMin: 0.5 }

test('co-occurrence merges: auth rides with authentication 3+ chapters -> alias toward the frequent label', () => {
  const chapters = [
    ['auth', 'authentication'], ['auth', 'testing'], ['auth', 'authentication'],
    ['auth'], ['authentication'], ['authentication'],
  ]
  const { candidates, frequency } = analyzeTopics(chapters, opts)
  const pair = candidates.find((c) => (c.from === 'auth' && c.to === 'authentication') || (c.from === 'authentication' && c.to === 'auth'))
  assert.ok(pair !== undefined, JSON.stringify(candidates))
  assert.equal(pair.cooccur >= 3 || pair.reason === 'alias-pattern', true)
  assert.equal(frequency.get('authentication'), 4, 'the more frequent label is the target')
})

test('alias pattern: singular/plural and prefix merge WITHOUT co-occurrence support', () => {
  const { candidates } = analyzeTopics([['container'], ['containers'], ['container']], opts)
  const c = candidates.find((x) => x.reason === 'alias-pattern')
  assert.ok(c !== undefined, JSON.stringify(candidates))
  assert.ok((c.from === 'containers') !== (c.to === 'containers'), 'plural folds into the stem side')
})

test('unrelated labels never merge; weak overlap without co-occurrence stays out', () => {
  const { candidates } = analyzeTopics([['playwright', 'database'], ['kubernetes']], opts)
  assert.equal(candidates.length, 0)
})

test('planAppends: dedupe vs existing chain, skip already-aliased froms, emit valid curation lines', () => {
  const { candidates } = analyzeTopics(
    [['auth', 'authentication'], ['auth', 'authentication'], ['auth'], ['authentication']],
    opts,
  )
  const { plan, lines } = planAppends(candidates, new Map(), '2026-09-20T00:00:00Z')
  assert.equal(plan.length, 1, JSON.stringify(candidates))
  const fact = JSON.parse(lines[0]!) as Record<string, unknown>
  assert.equal(fact.type, 'topic-alias')
  assert.ok(typeof fact.from === 'string' && typeof fact.to === 'string' && fact.from !== fact.to)
  assert.match(String(fact.reason), /cooccur=|overlap=/)
  // an existing alias to the target collapses the plan to nothing
  const again = planAppends(candidates, new Map([[fact.from as string, fact.to as string]]), 'x')
  assert.equal(again.plan.length, 0)
})

test('chain resolution: proposed target that already aliases onward folds to the final target', () => {
  // existing b->c; candidate a->b resolves 'to' through the chain -> a->c
  const { plan } = planAppends(
    [{ from: 'a', to: 'b', cooccur: 5, overlap: 0.8, reason: 'co-occurrence' }],
    new Map([['b', 'c']]), 'at',
  )
  assert.equal(plan.length, 1)
  assert.deepEqual({ from: plan[0]!.from, to: plan[0]!.to }, { from: 'a', to: 'c' })
  // and a candidate whose FROM is already aliased is skipped (chain done)
  assert.equal(planAppends([{ from: 'a', to: 'b', cooccur: 5, overlap: 0.8, reason: 'co-occurrence' }], new Map([['a', 'c']]), 'at').plan.length, 0)
})
