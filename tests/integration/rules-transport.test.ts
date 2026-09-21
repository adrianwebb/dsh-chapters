/**
 * P3 S1: rule files + curation facts travel the SAME transport as chapters,
 * over a real bare pool — and the commit gate change is pinned: a sync whose
 * only change is an appended rule-status fact (copied === 0) MUST commit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, DEFAULT_CLONE_DIR, type ProjectRecord } from '../../src/sync.ts'
import { renderRuleFile, appendRuleStatusFact } from '../../src/rules.ts'
import { searchKnowledge } from '../../src/search.ts'

const proj = (cwd: string, remote: string, h: string): ProjectRecord => ({
  projectKey: 'PKR', slug: 'r', remote, harnessId: h, linkedAt: 'x', cwd,
})

test('rules publish; fact-only passes commit; B sees the rule in the mirror and in search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rulestr-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  const b = path.join(root, 'machine-b')
  const ruleRel = path.join('.dsh-chapters', 'rules', 'hA', '001-security-no-token-logging.md')
  fs.mkdirSync(path.dirname(path.join(a, ruleRel)), { recursive: true })
  fs.writeFileSync(path.join(a, ruleRel), renderRuleFile({
    number: 1, category: 'security', title: 'No token logging', sourceSession: 'sA',
    at: '2026-09-20T00:00:00Z', body: 'Never log raw tokens or bearer headers.\n',
  }))
  const r1 = await runSync({ cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(a, pool, 'hA'), force: true })
  assert.ok(r1.ok, r1.detail)
  assert.ok(fs.existsSync(path.join(pool, 'HEAD')))

  // fact written AFTER the first push: the next pass copies NOTHING but must commit
  appendRuleStatusFact(path.join(a, DEFAULT_CLONE_DIR), 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  const r2 = await runSync({ cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(a, pool, 'hA'), force: true })
  assert.ok(r2.ok, r2.detail)
  assert.ok((r2.steps ?? []).some((x) => x.startsWith('published 0') && true) , r2.steps?.join(' / '))
  const steps2 = (r2.steps ?? []).join(' / ')
  assert.ok(/committed \d+ path/.test(steps2), `fact-only pass must commit, steps: ${steps2}`)

  // B clones the pool and finds both artifacts
  fs.mkdirSync(b)
  const rb = await runSync({ cwd: b, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(b, pool, 'hB'), force: true })
  assert.ok(rb.ok, rb.detail)
  const cloneB = path.join(b, DEFAULT_CLONE_DIR)
  assert.ok(fs.existsSync(path.join(cloneB, 'rules', 'PKR', 'hA', '001-security-no-token-logging.md')), 'rule file crossed the pool')
  assert.ok(fs.existsSync(path.join(cloneB, 'edits', 'hA', 'curation.jsonl')), 'fact crossed the pool')
  // index picked it up as kind:rule
  const hits = searchKnowledge(cloneB, 'bearer token logging', 600, { projectKey: 'PKR' })
  assert.ok(hits.results.some((h) => h.kind === 'rule'), JSON.stringify(hits.results.map((h) => [h.kind, h.title])))
  // a THIRD machine sees the rule file but NO core status (hA facts are hA's)
  const c = path.join(root, 'machine-c'); fs.mkdirSync(c)
  const rc = await runSync({ cwd: c, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(c, pool, 'hC'), force: true })
  assert.ok(rc.ok, rc.detail)
  const { buildRulesSection } = await import('../../src/rules.ts')
  const secC = buildRulesSection(path.join(c, DEFAULT_CLONE_DIR), { projectKey: 'PKR', harnessId: 'hC', budgetTokens: 1200 })
  assert.ok(secC.kind === 'ok' && !secC.text.includes('CORE RULES'), 'machine C: category index yes, core no')
  const secA = buildRulesSection(path.join(a, DEFAULT_CLONE_DIR), { projectKey: 'PKR', harnessId: 'hA', budgetTokens: 1200 })
  assert.ok(secA.kind === 'ok' && secA.text.includes('Never log raw tokens'), 'machine A: its own approval is effective')
  fs.rmSync(root, { recursive: true, force: true })
})
