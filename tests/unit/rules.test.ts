import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderRuleFile, parseRuleFile, rulePath, buildRulesSection,
  appendRuleStatusFact, loadRuleStatusFacts, effectiveStatus, type MirrorRule,
} from '../../src/rules.ts'

function mirrorWith(rules: Array<{ harness: string; number: number; category: string; title: string; body: string }>): string {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  for (const r of rules) {
    const p = path.join(m, 'rules', 'PK', r.harness, `${String(r.number).padStart(3, '0')}-${r.category}.md`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, renderRuleFile({
      number: r.number, category: r.category, title: r.title,
      sourceSession: 'sess-x', at: '2026-09-20T00:00:00Z', body: r.body,
    }))
  }
  return m
}

test('rule file round-trips; written once as proposed; parse rejects non-rules', () => {
  const text = renderRuleFile({ number: 7, category: 'security', title: 'No token logging', sourceSession: 's1', at: 'a', body: 'Never log raw tokens.\n' })
  const parsed = parseRuleFile(text)!
  assert.equal(parsed.category, 'security')
  assert.equal(parsed.number, 7)
  assert.equal(parsed.fileStatus, 'proposed')
  assert.equal(parsed.body.trim(), 'Never log raw tokens.')
  assert.equal(parseRuleFile('---\ntitle: x\n---\nbody'), null, 'chapters are not rules')
  assert.ok(rulePath('.dsh-chapters', 'hA', 7, 'Security', 'No token logging!').endsWith('007-security-no-token-logging.md'))
})

test('effective status: own facts win, later fact supersedes, absent fact = file status', () => {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  assert.equal(effectiveStatus('hA/001', new Map(), 'proposed'), 'proposed')
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'core', at: 't1' })
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'revoked', at: 't2' })
  const facts = loadRuleStatusFacts(m, 'hA')
  assert.equal(effectiveStatus('hA/001', facts, 'proposed'), 'revoked', 'append-only order = last write wins')
  assert.equal(loadRuleStatusFacts(m, 'hB').size, 0, 'hB sees NO facts of hA — per-machine by construction')
})

test('section: none on empty corpus (the tape-preservation invariant)', () => {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  assert.deepEqual(buildRulesSection(m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 }), { kind: 'none' })
  const withRule = mirrorWith([{ harness: 'hA', number: 1, category: 'security', title: 'T', body: 'x' }])
  // proposed-only renders the CATEGORY INDEX but no CORE RULES block
  const sec = buildRulesSection(withRule, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 })
  assert.equal(sec.kind, 'ok')
  assert.ok(sec.kind === 'ok' && !sec.text.includes('CORE RULES') && sec.text.includes('security'), JSON.stringify(sec))
})

test('section: approved rules render verbatim + index; revoked vanish; other machines stay proposed', () => {
  const m = mirrorWith([
    { harness: 'hA', number: 1, category: 'security', title: 'Token policy', body: 'Never log raw tokens.' },
    { harness: 'hA', number: 2, category: 'style', title: 'Dead code', body: 'No commented-out code.' },
  ])
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  appendRuleStatusFact(m, 'hA', { rule: 'hA/002', status: 'revoked', at: 't' })
  const a = buildRulesSection(m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 })
  assert.ok(a.kind === 'ok')
  assert.ok(a.text.includes('CORE RULES') && a.text.includes('Never log raw tokens.'), a.text)
  assert.ok(!a.text.includes('No commented-out code.'), 'revoked rule is gone from the notice')
  assert.ok(!a.text.includes('style'), 'revoked category drops from the index')
  const b = buildRulesSection(m, { projectKey: 'PK', harnessId: 'hB', budgetTokens: 1200 })
  assert.ok(b.kind === 'ok' && !b.text.includes('CORE RULES'), 'machine B: NOTHING is core there — exit criterion 1')
})

test('overflow refuses with per-rule numbers and names no truncation', () => {
  const long = 'word '.repeat(500)
  const m = mirrorWith([{ harness: 'hA', number: 1, category: 'c', title: 'T', body: long }])
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  const r = buildRulesSection(m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 100 })
  assert.equal(r.kind, 'refusal')
  assert.ok(r.kind === 'refusal')
  assert.ok(r.total > r.cap && r.perRule.length === 1 && r.perRule[0]!.tokens > 100, JSON.stringify(r))
  assert.match(r.reason, /never clips/)
})
