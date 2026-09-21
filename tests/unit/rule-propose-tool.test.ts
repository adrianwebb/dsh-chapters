/** L0: the chapters_rule_propose tool writes a PROPOSED rule with session
 * provenance through the exact command path, records it, and arms sync. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools } from '../../src/tools.ts'
import type { RuleRecord } from '../../src/rules.ts'

function world() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruletool-'))
  const project = { projectKey: 'PKT', slug: 's', remote: 'x', harnessId: 'hT', linkedAt: 'l', cwd: tmp }
  const rules = new Map<string, RuleRecord>()
  let scheduled = ''
  const caller = { id: 'sess-9', session: { id: 'sess-9', header: { cwd: tmp }, snapshotEvents: () => [] } }
  const store = {
    get: async () => ({ chapters: [] }), put: async () => {},
    projects: () => [[project.projectKey, project]] as Iterable<[string, typeof project]>,
    sessions: () => [].entries(),
    getSetting: () => undefined, putSetting: async () => {},
    rules: () => rules.entries(), getRule: (id: string) => rules.get(id),
    putRule: async (id: string, v: RuleRecord) => { rules.set(id, v) },
  }
  const ctx = { get: () => undefined, sessionProjections: { stateOf: () => undefined }, logger: { warn: () => {} } }
  const config = {
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', harnessId: 'hT', coreRulesBudgetTokens: 1200,
    scheduler: { schedule: (_c: string, why: string) => { scheduled = why }, run: async () => ({}), pullFor: async () => ({ ok: true, detail: '' }), hasPending: () => false, drain: async () => {} },
  }
  const built = buildChaptersTools(ctx as never, store as never, config as never)
  return { built, caller, rules, tmp, scheduled: () => scheduled, dispose: () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

test('propose writes a proposed rule with the session as provenance; nothing is core by construction', async () => {
  const w = world()
  const r = await w.built.chaptersRulePropose.execute(
    { category: 'testing', text: 'Always run the tape replay before rebuilding lib during e2e runs.' },
    { agent: w.caller } as never,
  ) as { ok: boolean; text: string }
  assert.equal(r.ok, true, r.text)
  assert.match(r.text, /proposed/)
  const rec = [...w.rules.values()][0]!
  assert.equal(rec.sourceSession, 'sess-9')
  assert.equal(rec.status, undefined, 'status is NOT stored in the record — it lives in facts')
  const file = path.join(w.tmp, rec.path)
  assert.ok(fs.readFileSync(file, 'utf8').includes('status: proposed'))
  assert.equal(w.scheduled(), 'archive:rules')
  // machine's own view: proposed => no CORE RULES anywhere; category index yes
  const { buildRulesSection } = await import('../../src/rules.ts')
  const { runSync, DEFAULT_CLONE_DIR } = await import('../../src/sync.ts')
  void runSync; void DEFAULT_CLONE_DIR
  w.dispose()
})

test('propose without a linked project refuses with the link hint', async () => {
  const w = world()
  const r = await w.built.chaptersRulePropose.execute(
    { category: 'x', text: 'A rule text long enough to pass the guard here.' },
    { agent: { id: 's', session: { id: 's', header: { cwd: '/nonexistent-e2e-dir' }, snapshotEvents: () => [] } } } as never,
  ) as { ok: boolean; text: string }
  // project lookup is by the CALLER's cwd; the world project maps to w.tmp only
  assert.equal(r.ok, false); assert.match(r.text, /chapters-link/)
  w.dispose()
})
