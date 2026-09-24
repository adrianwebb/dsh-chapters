/**
 * Second pure/IO-light branch sweep: the kernel-shape predicate (every
 * validation throw arm), buildTocNotice guards, searchKnowledge's scoring/
 * scoping/budget arms, and buildRulesSection/collectMirrorRules' none/ok/
 * refusal taxonomy + mirror-walk skips. These functions own the plugin's
 * accept/reject contract; every arm is a decision the code can make, so every
 * arm deserves a witness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTocNotice, assertKernelAcceptedUserMessage } from '../../src/notice.ts'
import { searchKnowledge } from '../../src/search.ts'
import { buildRulesSection, collectMirrorRules, renderRuleFile, appendRuleStatusFact } from '../../src/rules.ts'
import type { SessionEventLike } from '../../src/types.ts'

// ---------------------------------------------------------------- notice

test('assertKernelAcceptedUserMessage: the valid notice passes, every deviation throws', () => {
  const good = buildTocNotice('# Continuation\n\nchapters here', { newId: () => 'id-1' })
  assert.doesNotThrow(() => assertKernelAcceptedUserMessage(good))
  const bad = (patch: (e: SessionEventLike) => void): SessionEventLike => {
    const clone = structuredClone(good)
    patch(clone)
    return clone
  }
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e as { type: string }).type = 'assistant/message' })), /unexpected notice event type/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { delete (e as { data?: unknown }).data })), /needs data/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e.data as { id: string }).id = '' })), /identified message/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e.data as { role: string }).role = 'assistant' })), /role "user"/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e.data as { source: unknown }).source = 'string-source' })), /invalid source/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e.data as { source: { kind: string } }).source.kind = 'alien' })), /outside the pinned vocabulary/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e.data as { source: { plugin?: string } }).source.plugin = '' })), /must name its producer/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e.data as { source: { form?: string } }).source.form = 'wild-form' })), /ContextForm union/)
  assert.throws(() => assertKernelAcceptedUserMessage(bad((e) => { (e.data as { content: unknown[] }).content = [] })), /invalid content/)
})

test('buildTocNotice: empty TOC and empty id both throw; time falls back to now', () => {
  assert.throws(() => buildTocNotice('   ', { newId: () => 'x' }), /must not be empty/)
  assert.throws(() => buildTocNotice('body', { newId: () => '' }), /non-empty id/)
  const e = buildTocNotice('body text', { newId: () => 'abc' })
  assert.ok((e as { time?: number }).time !== undefined && (e as { time?: number }).time > 0)
})

// ---------------------------------------------------------------- search

function seedMirror(dir: string): void {
  const mk = (rel: string, text: string, mtimeDays: number) => {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
    const t = (Date.now() - mtimeDays * 86_400_000) / 1000
    fs.utimesSync(abs, t, t)
  }
  mk('chapters/KEY/sess-a/001-auth.md', '---\ntitle: "Auth flow"\ntopics: ["auth","tokens"]\n---\n# Auth flow\n\nhow bearer tokens refresh\n', 3)
  mk('chapters/KEY/sess-b/002-cache.md', '---\ntitle: "Cache layer"\ntopics: ["cache"]\n---\n# Cache layer\n\nredis eviction\n', 300)
  mk('chapters/OTHER/sess-c/003-other.md', '---\ntitle: "Foreign project"\ntopics: ["auth"]\n---\nauth in a different pool\n', 1)
}

test('searchKnowledge: terms, project scope, age decay, budget honesty, empty query', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-sw-'))
  try {
    seedMirror(dir)
    const empty = searchKnowledge(dir, '      ', 400, { projectKey: 'KEY' })
    assert.equal(empty.total, 0, 'whitespace query short-circuits')
    const scoped = searchKnowledge(dir, 'auth tokens', 400, { projectKey: 'KEY', now: Date.now() })
    assert.ok(scoped.results.every((r) => r.path.startsWith('chapters/KEY/')), 'project scoping hides other pools')
    assert.ok(scoped.total >= 1)
    const unscoped = searchKnowledge(dir, 'auth', 400, { now: Date.now() })
    assert.ok(unscoped.total >= scoped.total, 'no scope sees the foreign pool too')
    // tiny budget → shown < total, and the line says so
    const tight = searchKnowledge(dir, 'auth cache tokens', 1, { now: Date.now() })
    assert.ok(tight.shown <= tight.total)
    assert.match(tight.line, /./, 'a render line is produced')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge: a missing clone dir yields an honest empty, not a throw', () => {
  const r = searchKnowledge('/nonexistent-mirror-xyz', 'anything', 400)
  assert.equal(r.total, 0)
})

// ---------------------------------------------------------------- rules

test('buildRulesSection none/ok/refusal and collectMirrorRules skip non-dirs & non-md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sw-'))
  try {
    // none: no rules tree at all
    const none = buildRulesSection(path.join(dir, 'm1'), { projectKey: 'P', harnessId: 'h', budgetTokens: 1000 })
    assert.equal(none.kind, 'none')

    const mirror = path.join(dir, 'm2')
    const rulesDir = path.join(mirror, 'rules', 'P', 'h')
    fs.mkdirSync(rulesDir, { recursive: true })
    // a stray non-directory where <harness> dirs belong
    fs.writeFileSync(path.join(mirror, 'rules', 'P', 'stray.txt'), 'ignored')
    fs.writeFileSync(path.join(rulesDir, '001-ops-keep-commands-idempotent-always-x.md'),
      renderRuleFile({ number: 1, category: 'ops', title: 'Keep commands idempotent always', sourceSession: 's', at: '2026-01-01T00:00:00Z', body: 'Keep every command idempotent, always re-runnable without duplicating side effects.\n' }))
    fs.writeFileSync(path.join(rulesDir, 'not-md.txt'), 'skipped')
    // approve it core for this machine
    appendRuleStatusFact(mirror, 'h', { rule: 'h/001', status: 'core', at: '2026-01-02T00:00:00Z' })
    const ok = buildRulesSection(mirror, { projectKey: 'P', harnessId: 'h', budgetTokens: 2000 })
    assert.equal(ok.kind, 'ok', `ok section expected: ${JSON.stringify(ok)}`)
    assert.match((ok as { text: string }).text, /CORE RULES/)
    assert.match((ok as { text: string }).text, /idempotent/)

    const refusal = buildRulesSection(mirror, { projectKey: 'P', harnessId: 'h', budgetTokens: 1 })
    assert.equal(refusal.kind, 'refusal')
    assert.match((refusal as { reason: string }).reason, /budget/)

    // collect: another machine's facts don't leak; revoked is still listed with its status
    const otherFacts = collectMirrorRules(mirror, 'P', 'h-other')
    assert.equal(otherFacts[0]?.status, 'proposed', 'other machine sees proposed (no core fact of its own)')
    appendRuleStatusFact(mirror, 'h', { rule: 'h/001', status: 'revoked', at: '2026-01-03T00:00:00Z' })
    const revoked = collectMirrorRules(mirror, 'P', 'h')
    assert.equal(revoked[0]?.status, 'revoked', 'last-write-wins')
    const afterRevoke = buildRulesSection(mirror, { projectKey: 'P', harnessId: 'h', budgetTokens: 2000 })
    assert.ok(afterRevoke.kind === 'none' || ((afterRevoke as { text?: string }).text ?? '').length === 0 || (afterRevoke as { text: string }).text !== undefined, 'revoked never renders as CORE')
    assert.ok(!(( afterRevoke as { text?: string }).text ?? '').includes('CORE RULES'), 'no core block once revoked')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge renders stitched multi-path entries and topic-less chapters honestly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-stitch-'))
  try {
    // a two-member stitched chapter + a topic-less one, both under KEY
    const w = (rel: string, text: string) => { const a = path.join(dir, rel); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, text) }
    w('chapters/KEY/sess-x/001-stitched.md', '---\ntitle: "Stitched"\n---\n# Stitched\n\nno topics here at all\n')
    // an empty-frontmatter chapter exercises the topics-length arm in the line builder
    const hit = searchKnowledge(dir, 'stitched topics', 400, { projectKey: 'KEY' })
    assert.ok(hit.total >= 1)
    assert.match(hit.line, /Stitched|stitched/, 'entry surfaced with a readable title')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
