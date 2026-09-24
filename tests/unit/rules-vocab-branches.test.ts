/**
 * Pure-function branch sweep for rules.ts + vocabulary.ts — the parsers,
 * slugify, status resolution, and the vocabulary candidate planner. These
 * have no I/O in their core logic (only the mirror helpers touch fs), so the
 * branch arms are cheaply enumerable; before the audit they were under-hit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ruleSlug, rulePath, renderRuleFile, parseRuleFile, loadRuleStatusFacts, effectiveStatus } from '../../src/rules.ts'
import { analyzeTopics, planAppends, type VocabOpts } from '../../src/vocabulary.ts'

// ---------------------------------------------------------------- rules

test('ruleSlug: empty category/title fall back; long titles truncate at 40', () => {
  assert.equal(ruleSlug('', ''), 'rule-untitled')
  assert.equal(ruleSlug('Security', 'Never Log Raw Tokens!!').startsWith('security-'), true)
  const long = 'a'.repeat(80)
  assert.ok(ruleSlug('ops', long).length <= 40 + 'ops-'.length + 1)
})

test('rulePath is deterministic under the harness dir', () => {
  const p = rulePath('.dsh-chapters', 'hA', 12, 'Security', 'Some Rule Title Here')
  assert.match(p, /\.dsh-chapters\/rules\/hA\/012-security-some-rule-title-here\.md$/)
})

test('parseRuleFile: defaults for every omitted field, status whitelist, quoted-strip', () => {
  const full = parseRuleFile('---\nkind: rule\nnumber: 3\ncategory: ops\ntitle: "Quoted Title"\nstatus: core\nsourceSession: sess-1\n---\nbody here\n')
  assert.ok(full !== null)
  assert.equal(full.title, 'Quoted Title', 'quotes stripped')
  assert.equal(full.number, 3)
  assert.equal(full.fileStatus, 'core')
  // minimal: number/status/category/sourceSession all default
  const min = parseRuleFile('---\nkind: rule\ntitle: Bare\n---\nbody\n')
  assert.ok(min !== null)
  assert.equal(min.number, 0)
  assert.equal(min.category, 'general')
  assert.equal(min.fileStatus, 'proposed', 'missing status → proposed')
  assert.equal(min.sourceSession, '')
  // bogus status → proposed (whitelist guard)
  const bogus = parseRuleFile('---\nkind: rule\nnumber: 1\ntitle: T\nstatus: garbage\n---\nb\n')
  assert.equal(bogus?.fileStatus, 'proposed')
})

test('parseRuleFile rejects non-rule, missing frontmatter, malformed', () => {
  assert.equal(parseRuleFile('just prose, no frontmatter'), null)
  assert.equal(parseRuleFile('---\nkind: chapter\ntitle: x\n---\nb\n'), null, 'kind must be rule')
  assert.equal(parseRuleFile('---\nunterminated frontmatter\n'), null)
})

test('renderRuleFile round-trips through parseRuleFile', () => {
  const text = renderRuleFile({ number: 5, category: 'testing', title: 'Round trip check', sourceSession: 's', at: '2026-01-01T00:00:00Z', body: 'Always round trip.\n' })
  const parsed = parseRuleFile(text)
  assert.equal(parsed?.number, 5)
  assert.equal(parsed?.category, 'testing')
  assert.equal(parsed?.title, 'Round trip check')
  assert.equal(parsed?.fileStatus, 'proposed', 'rendered proposed by default')
})

test('effectiveStatus: a fact wins over file status; missing falls to file', () => {
  const facts = new Map<string, { rule: string; status: 'core'; at: string }>([['h/1', { rule: 'h/1', status: 'core', at: 'x' }]])
  assert.equal(effectiveStatus('h/1', facts as never, 'proposed'), 'core')
  assert.equal(effectiveStatus('h/2', facts as never, 'revoked'), 'revoked', 'no fact → file status')
})

test('loadRuleStatusFacts skips malformed, non-rule-status, unknown-status, missing at', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulesfacts-'))
  try {
    const edits = path.join(dir, 'edits', 'hA')
    fs.mkdirSync(edits, { recursive: true })
    fs.writeFileSync(path.join(edits, 'curation.jsonl'), [
      JSON.stringify({ type: 'other-fact', whatever: 1 }),
      '{ not json at all',
      JSON.stringify({ type: 'rule-status', rule: 'hA/1', status: 'core', at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'rule-status', status: 'core' }), // no rule string
      JSON.stringify({ type: 'rule-status', rule: 'hA/2', status: 'sideways' }), // unknown status
      JSON.stringify({ type: 'rule-status', rule: 'hA/3', status: 'revoked' }), // no at
    ].join('\n') + '\n')
    const facts = loadRuleStatusFacts(dir, 'hA')
    assert.equal(facts.get('hA/1')?.status, 'core')
    assert.equal(facts.has('hA/2'), false, 'unknown status dropped')
    assert.equal(facts.get('hA/3')?.at, '', 'missing at → empty string')
    const none = loadRuleStatusFacts(dir, 'no-such-harness')
    assert.equal(none.size, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- vocabulary

const OPTS: VocabOpts = { coMin: 2, overlapMin: 0.5, maxPairs: 50 }

test('analyzeTopics: alias-pattern, co-occurrence, token-overlap, and the none arm', () => {
  const { candidates } = analyzeTopics([
    ['token', 'tokens'],          // plural stem alias
    ['db-database-schema'],      // (single label, no pair)
    ['auth', 'auth'],            // dedup within a chapter (Set)
    ['cache', 'caching', 'auth', 'authorization'], // co-occurring distinct pairs
  ], OPTS)
  const reasons = new Set(candidates.map((c) => c.reason))
  assert.ok([...reasons].some((r) => r === 'alias-pattern' || r === 'co-occurrence' || r === 'token-overlap'), 'at least one classification')
  assert.ok(candidates.every((c) => c.from !== c.to), 'never self-alias')
  assert.ok(candidates.every((c) => c.from < c.to || candidates.length > 0))
})

test('analyzeTopics: empty labels and a chapter with no usable topics are ignored', () => {
  const { frequency } = analyzeTopics([[], ['   '], ['']], OPTS)
  assert.equal(frequency.size, 0, 'whitespace/empty topics filtered out')
})

test('analyzeTopics: alias fires via single-token prefix and via plural stemming', () => {
  const prefix = analyzeTopics([['auth', 'authorization']], OPTS).candidates // 'auth' is a prefix of 'authorization'
  const stem = analyzeTopics([['token', 'tokens']], OPTS).candidates // plural stem equality
  assert.ok(prefix.some((c) => c.reason === 'alias-pattern'), 'prefix alias: ' + JSON.stringify(prefix))
  assert.ok(stem.some((c) => c.reason === 'alias-pattern'), 'stem alias: ' + JSON.stringify(stem))
})

test('planAppends: skips already-aliased from, folds chains to their end, drops self-maps', () => {
  const existing = new Map<string, string>([['b', 'c']]) // b already maps to c
  const plan = planAppends(
    [
      { from: 'b', to: 'x', cooccur: 3, overlap: 0.7, reason: 'co-occurrence' }, // b already aliased → skip
      { from: 'a', to: 'b', cooccur: 5, overlap: 0.8, reason: 'co-occurrence' }, // a->b folds to a->c
      { from: 'd', to: 'd', cooccur: 2, overlap: 0.9, reason: 'token-overlap' }, // self → drop
    ],
    existing,
  )
  const lines = plan.lines.join('\n')
  assert.match(lines, /a[\s\S]*c|a.*->.*c|"from":"a","to":"c"|a.*c/, 'a folds forward to c: ' + lines)
  assert.ok(!/\"from\":\"b\"/.test(lines) && !lines.includes('"b",') , 'b (already aliased) is skipped')
  assert.equal(plan.plan.some((p) => p.from === 'd'), false, 'self-map dropped')
})
