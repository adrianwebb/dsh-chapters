import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rulesCommand, type RulesIo } from '../../src/rules-commands.ts'
import { renderRuleFile, collectMirrorRules } from '../../src/rules.ts'
import type { RuleRecord } from '../../src/rules.ts'
import type { ProjectRecord } from '../../src/sync.ts'

function harness(over: Partial<RulesIo> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rulecmd-'))
  const project: ProjectRecord = { projectKey: 'PKC', slug: 's', remote: 'x', harnessId: 'hA', linkedAt: 'l', cwd }
  const table = new Map<string, RuleRecord>()
  let syncs = 0
  const io: RulesIo = {
    cwd: () => cwd,
    storeRoot: '.dsh-chapters',
    harnessId: 'hA',
    store: {
      rules: () => table.entries(),
      getRule: (id) => table.get(id),
      putRule: async (id, v) => { table.set(id, v) },
    },
    projectFor: () => project,
    mirrorDir: () => path.join(cwd, '.dsh-knowledge'),
    syncNow: async () => { syncs += 1 },
    now: () => new Date('2026-09-20T12:00:00Z'),
    ...over,
  }
  return { io, cwd, table, syncCount: () => syncs, dispose: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('add: writes the file once, records in the domain, syncs, and echoes the approve line', async () => {
  const h = harness()
  const r = await rulesCommand(h.io, 'add security Never log raw tokens or bearer headers anywhere')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /rule hA\/001 proposed/)
  const file = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA', '001-security-never-log-raw-tokens-or-bearer-headers-a.md')
  assert.ok(fs.existsSync(file), fs.readdirSync(path.join(h.cwd, '.dsh-chapters', 'rules', 'hA')).join(','))
  assert.equal(h.table.get('hA/001')?.category, 'security')
  assert.equal(h.syncCount(), 1)
  const dup = await rulesCommand(h.io, 'add security Second rule text that is long enough')
  assert.match(dup.text, /002/) // number advanced
  h.dispose()
})

test('add refuses short text; everything refuses with no linked project', async () => {
  const h = harness()
  assert.equal((await rulesCommand(h.io, 'add security too short')).kind, 'error')
  const noProject = harness({ projectFor: () => undefined })
  assert.match((await rulesCommand(noProject.io, 'list')).text, /chapters-link/)
  h.dispose(); noProject.dispose()
})

test('approve writes a fact to the OWN edits dir (even for another machine\u2019s rule); revoke supersedes in list', async () => {
  const h = harness()
  // seed a foreign rule INTO THE MIRROR (as a pull would have delivered it)
  const foreign = path.join(h.cwd, '.dsh-knowledge', 'rules', 'PKC', 'hX', '004-deploy-checklist.md')
  fs.mkdirSync(path.dirname(foreign), { recursive: true })
  fs.writeFileSync(foreign, renderRuleFile({ number: 4, category: 'deploy', title: 'Blue-green only', sourceSession: 's', at: 'a', body: 'Deploy via blue-green only.\n' }))
  const ok = await rulesCommand(h.io, 'approve hX/004')
  assert.equal(ok.kind, 'success', ok.text)
  const facts = path.join(h.cwd, '.dsh-knowledge', 'edits', 'hA', 'curation.jsonl')
  assert.ok(fs.existsSync(facts), 'fact in MY edits dir, not hX\u2019s')
  assert.ok(fs.readFileSync(facts, 'utf8').includes('"rule":"hX/004","status":"core"'))
  const rules = collectMirrorRules(path.join(h.cwd, '.dsh-knowledge'), 'PKC', 'hA')
  assert.equal(rules.find((r) => r.id === 'hX/004')?.status, 'core')
  // effective for a DIFFERENT machine: still proposed
  const rulesB = collectMirrorRules(path.join(h.cwd, '.dsh-knowledge'), 'PKC', 'hB')
  assert.equal(rulesB.find((r) => r.id === 'hX/004')?.status, 'proposed')
  const bad = await rulesCommand(h.io, 'approve 999')
  assert.equal(bad.kind, 'error'); assert.match(bad.text, /unknown id/)
  const rev = await rulesCommand(h.io, 'revoke hX/004')
  assert.equal(rev.kind, 'success')
  const listed = await rulesCommand(h.io, 'list')
  assert.ok(!listed.text.includes('hX/004'), 'revoked hides from default list')
  const all = await rulesCommand(h.io, 'list --all')
  assert.match(all.text, /hX\/004\s+revoked/, all.text)
  h.dispose()
})

// ------------------------------------------------- audit rows (2026-09-23)

test('a disk-only rule file (killed before the domain write) is walked PAST, never a deadlock', async () => {
  // r39 residue class at the command surface: the number slot exists on disk
  // while the registry never got the record — add must find the next free
  // number (the old code refused forever).
  const h = harness()
  const dir = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA')
  fs.mkdirSync(dir, { recursive: true })
  const ghost = path.join(dir, '001-security-ghost-of-a-dead-rule-that-once-existed-a.md')
  fs.writeFileSync(ghost, renderRuleFile({ number: 1, category: 'security', title: 'ghost of a dead rule that once existed', sourceSession: 'x', at: '2026-01-01', body: 'ghost\n' }))
  const r = await rulesCommand(h.io, 'add security A fresh rule with plenty of length to pass')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /rule hA\/002 proposed/, 'the walk advanced past the disk ghost')
  assert.ok(fs.existsSync(ghost), 'the ghost bytes were never touched (write-once)')
  h.dispose()
})

test('list merges mirror and domain rules, and filters render distinct views', async () => {
  const h = harness()
  await rulesCommand(h.io, 'add security Always rotate bearer tokens before they expire daily')
  const all = await rulesCommand(h.io, 'list')
  assert.match(all.text, /hA\/001/, 'list shows the fresh rule')
  const proposed = await rulesCommand(h.io, 'list --proposed')
  assert.match(proposed.text, /hA\/001/, 'the unapproved rule is proposed')
  const approved = await rulesCommand(h.io, 'list --all')
  assert.match(approved.text, /hA\/001/)
  const cat = await rulesCommand(h.io, 'list --category performance')
  assert.ok(!cat.text.includes('hA/001'), 'a different category filter excludes it')
  const junk = await rulesCommand(h.io, 'frobnicate')
  assert.match(junk.text, /usage|add <category>/i, 'unknown verb answers with the help')
  h.dispose()
})

test('approve reports failure honestly when the mirror edits dir cannot be written', async () => {
  const h = harness()
  await rulesCommand(h.io, 'add security Never echo raw tokens inside any stored output')
  const mirror = path.join(h.cwd, '.dsh-knowledge')
  fs.mkdirSync(mirror, { recursive: true })
  fs.chmodSync(mirror, 0o500)
  try {
    const r = await rulesCommand(h.io, 'approve hA/001')
    assert.equal(r.kind, 'error', 'the failure is reported, not swallowed')
    assert.match(r.text, /approve failed/i)
  } finally {
    fs.chmodSync(mirror, 0o700)
  }
  h.dispose()
})
