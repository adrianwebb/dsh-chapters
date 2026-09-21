import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { baseScore, searchKnowledge } from '../../src/search.ts'
import { renderRuleFile, appendRuleStatusFact } from '../../src/rules.ts'
import { buildIndexInClone } from '../../src/sync.ts'
import type { IndexEntry } from '../../src/indexing.ts'

const entry = (over: Partial<IndexEntry>): IndexEntry => ({ path: 'p', title: 'x', topics: [], kind: 'chapter', ...over })

test('category hits score between topics and title', () => {
  const withCat = baseScore(entry({ category: 'security', topics: ['other'] }), ['security'], '')
  const asTitle = baseScore(entry({ title: 'security matters' }), ['security'], '')
  const asTopic = baseScore(entry({ topics: ['security-x'] }), ['security'], '')
  assert.equal(withCat, 1.5)
  assert.ok(withCat > asTitle && withCat < asTopic, `${asTitle} < ${withCat} < ${asTopic}`)
})

test('effective-core rule outranks an equal chapter only for the approving machine', () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'score-r-'))
  const rp = path.join(clone, 'rules', 'PK', 'hA', '001-security-deploy-check.md')
  fs.mkdirSync(path.dirname(rp), { recursive: true })
  fs.writeFileSync(rp, renderRuleFile({ number: 1, category: 'security', title: 'Checklist policy', sourceSession: 's', at: 'a', body: 'Verify the rollback plan before any deploy.\n' }))
  const cp = path.join(clone, 'chapters', 'PK', 'sessX', '002-deploy-notes.md')
  fs.mkdirSync(path.dirname(cp), { recursive: true })
  fs.writeFileSync(cp, '---\ntitle: "Checklist debate"\ntopics: []\n---\n# c\n\nsome deployment chatter\n')
  buildIndexInClone(clone)
  appendRuleStatusFact(clone, 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  const a = searchKnowledge(clone, 'checklist', 600, { projectKey: 'PK', harnessId: 'hA', rulesCoreBonus: 0.15 })
  const b = searchKnowledge(clone, 'checklist', 600, { projectKey: 'PK', harnessId: 'hB', rulesCoreBonus: 0.15 })
  const firstRuleA = a.results[0]?.kind === 'rule'
  const firstRuleB = b.results[0]?.kind === 'rule'
  assert.notEqual(firstRuleA, firstRuleB, `A sees core-first=${firstRuleA}, B=${firstRuleB} — bonus must be per-machine`)
  assert.ok(a.results.some((r) => r.kind === 'rule'), 'rule present for A')
  fs.rmSync(clone, { recursive: true, force: true })
})
