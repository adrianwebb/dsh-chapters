/**
 * search.ts — the deterministic scorer (record §8): topic hits outrank title
 * hits outrank summary hits, recency breaks ties, and packing respects the
 * AGENT-requested token budget with total-vs-shown transparency.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { searchKnowledge, scoreEntry, loadCorpus } from '../../src/search.ts'
import type { IndexEntry } from '../../src/indexing.ts'

const NOW = 1_750_000_000_000

test('scoreEntry: topic hits outrank title hits outrank summary hits; recency adds a bounded bonus', () => {
  const base: IndexEntry = { path: 'chapters/K/s/a.md', title: 'auth work', topics: ['auth'], kind: 'chapter', mtime: NOW }
  // topic hits (2x) outrank title/summary hits (1x each)
  assert.ok(scoreEntry({ ...base, topics: ['auth'] }, ['auth'], NOW, '') > scoreEntry({ ...base, topics: [], title: 'auth flow' }, ['auth'], NOW, ''))
  // title and summary are equal-weight (1x)
  assert.equal(scoreEntry({ ...base, topics: [], title: 'auth flow' }, ['auth'], NOW, ''), scoreEntry({ ...base, topics: [], title: 'other' }, ['auth'], NOW, 'auth stuff'))
  // a 1x hit beats a no-hit at equal recency
  assert.ok(scoreEntry({ ...base, topics: [], title: 'auth flow' }, ['auth'], NOW, '') > scoreEntry({ ...base, topics: [], title: 'zzz' }, ['auth'], NOW, ''))
  // recency adds a bounded bonus (30-day tiers)
  assert.ok(scoreEntry({ ...base, topics: [], mtime: NOW }, ['auth'], NOW, '') > scoreEntry({ ...base, topics: [], mtime: NOW - 400 * 86400000 }, ['auth'], NOW, ''))
})

const writeCorpus = (): string => {
  const dir = fs.mkdtempSync('/tmp/chapters-search-')
  const ch = path.join(dir, 'chapters', 'K', 's')
  fs.mkdirSync(ch, { recursive: true })
  fs.writeFileSync(path.join(ch, '001-auth.md'), '---\ntitle: "Auth flow"\ntopics: ["auth", "src/auth/x.ts"]\nsummary: the auth flow\n---\nbody\n')
  fs.writeFileSync(path.join(ch, '002-billing.md'), '---\ntitle: "Billing"\ntopics: ["billing"]\nsummary: billing notes\n---\nbody\n')
  return dir
}

test('searchKnowledge: ranks topic hits first and packs to the requested budget', () => {
  const dir = writeCorpus()
  const out = searchKnowledge(dir, 'auth', 500, { now: NOW })
  assert.ok(out.total >= 1)
  assert.equal(out.results[0]!.title, 'Auth flow')
  assert.ok(out.budget.used <= 500)
  assert.match(out.line, /Auth flow/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('searchKnowledge: the project scope filters to the caller project; unknown query is an empty result, not an error', () => {
  const dir = writeCorpus()
  const scoped = searchKnowledge(dir, 'auth', 500, { now: NOW, projectKey: 'OTHER' })
  assert.equal(scoped.total, 0)
  const unscoped = searchKnowledge(dir, 'zzz-no-match', 500, { now: NOW })
  assert.equal(unscoped.total, 0)
  assert.deepEqual(loadCorpus(dir).entries.map((e) => e.kind).sort(), ['chapter', 'chapter'])
  fs.rmSync(dir, { recursive: true, force: true })
})
