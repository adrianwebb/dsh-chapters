/**
 * The transport-provider seam (src/provider.ts) and the upstream-target
 * grammar (src/repo.ts: parseKnowledgeRemote / projectKeyForTarget) — the
 * §15 amendment "transport is pluggable; git is one provider", Phase A.
 * These rows pin the refactor's contract: default selection preserves every
 * pre-provider behavior, identity is stable per transport, and an unregistered
 * kind refuses LOUDLY (never silently falls back and syncs into the wrong pool).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectProvider, registerProvider, gitProvider, providerKindFor, type SyncProvider } from '../../src/provider.ts'
import { parseKnowledgeRemote, projectKeyForTarget } from '../../src/repo.ts'
import { parseProjectRecord } from '../../src/store.ts'

// ------------------------------------------------------------------ selection

test('a record with no kind resolves to the git provider (every pre-provider row)', () => {
  assert.equal(selectProvider({ remote: 'https://host/org/repo.git' }), gitProvider)
  assert.equal(selectProvider({ remote: './vendor/kb.git', kind: undefined }), gitProvider)
})

test('the git provider carries the six transport verbs + identity', () => {
  for (const verb of ['ensureClone', 'initLocal', 'removeMirror', 'stageAllAndCommit', 'pullFastForward', 'push'] as const) {
    assert.equal(typeof gitProvider[verb], 'function', verb)
  }
  assert.equal(gitProvider.kind, 'git')
  assert.match(gitProvider.describe({ projectKey: 'k', slug: 's', remote: 'https://h/r', harnessId: 'x', linkedAt: '', cwd: '/' }), /https:\/\/h\/r/)
})

test('an unregistered kind refuses with the remote named; unknown kinds never sync by accident', () => {
  assert.throws(() => selectProvider({ kind: 'treedx', remote: 'treedx+http://h/r' }), /not registered/)
  assert.throws(() => selectProvider({ kind: 'nope' as never, remote: 'x' }), /not registered/)
})

test('registerProvider is the extension point (treedx plugs in by kind)', () => {
  const fake: SyncProvider = {
    kind: 'treedx',
    describe: () => 'fake',
    async ensureClone() { return { ok: true, detail: 'fake' } },
    async initLocal() { return { ok: true, detail: 'fake' } },
    async removeMirror() { return { ok: true, detail: 'fake' } },
    async stageAllAndCommit() { return { ok: true, detail: 'fake' } },
    async pullFastForward() { return { ok: true, detail: 'fake' } },
    async push() { return { ok: true, detail: 'fake' } },
  }
  registerProvider(fake)
  assert.equal(selectProvider({ kind: 'treedx', remote: 'treedx+http://h/r' }), fake)
})

// ------------------------------------------------------------------ the grammar

test('git targets pass through untouched (https, ssh shape, local path)', () => {
  assert.deepEqual(parseKnowledgeRemote('https://github.com/o/r.git'), { kind: 'git', raw: 'https://github.com/o/r.git' })
  assert.equal(parseKnowledgeRemote('git@github.com:o/r.git').kind, 'git')
  assert.equal(parseKnowledgeRemote('./vendor/kb.git').kind, 'git')
})

test('treedx+ targets parse to baseUrl + canonical-lowercase repo name', () => {
  const t = parseKnowledgeRemote('treedx+http://127.0.0.1:4000/kb')
  assert.equal(t.kind, 'treedx')
  assert.equal(t.treedx?.baseUrl, 'http://127.0.0.1:4000')
  assert.equal(t.treedx?.repoName, 'kb')

  const api = parseKnowledgeRemote('treedx+https://treedx.example.com/api/v1/my-kb')
  assert.deepEqual(api.treedx, { baseUrl: 'https://treedx.example.com', repoName: 'my-kb' })

  assert.equal(parseKnowledgeRemote('treedx+http://h:4000/kb/').treedx?.repoName, 'kb')
  assert.equal(parseKnowledgeRemote('treedx+http://h:4000/My-KB').treedx?.repoName, 'my-kb', 'TreeDX names are canonical lowercase')
})

test('a treedx+ target without a repo name refuses — never guesses a pool', () => {
  assert.throws(() => parseKnowledgeRemote('treedx+http://127.0.0.1:4000'), /needs a repository name/)
  assert.throws(() => parseKnowledgeRemote('treedx+http:///api/v1'), /needs a repository name|not a valid URL/)
})

// ------------------------------------------------------------------ identity

test('projectKey for TreeDX: stable across spellings, distinct from a same-host git remote', () => {
  const a = projectKeyForTarget(parseKnowledgeRemote('treedx+http://127.0.0.1:4000/kb'))
  const b = projectKeyForTarget(parseKnowledgeRemote('treedx+http://127.0.0.1:4000/api/v1/kb/'))
  const c = projectKeyForTarget(parseKnowledgeRemote('treedx+http://127.0.0.1:4000/KB'))
  assert.equal(a, b, '/api/v1 and trailing slash are the same pool')
  assert.equal(a, c, 'case folds (TreeDX canonical names)')
  const gitSamePath = projectKeyForTarget(parseKnowledgeRemote('http://127.0.0.1:4000/kb'))
  assert.notEqual(a, gitSamePath, 'transport is part of identity: a server mirror of a git URL is a DIFFERENT pool')
  assert.match(a, /^[0-9a-f-]{36}$/, 'UUIDv5 shape, §2.3')
})

// ------------------------------------------------------------------ migration

test('a stored v2 project row (no kind) parses to kind git — zero migration', () => {
  const v2 = { projectKey: 'K', slug: 's', remote: 'https://h/r.git', harnessId: 'x', linkedAt: '2026-01-01T00:00:00Z', cwd: '/w' }
  const parsed = parseProjectRecord(v2)
  assert.equal(parsed.kind, 'git')
  assert.equal(parsed.repoId, undefined)
  const v3 = parseProjectRecord({ ...v2, kind: 'treedx', repoId: 'repo_abc' })
  assert.equal(v3.kind, 'treedx')
  assert.equal(v3.repoId, 'repo_abc')
})

// ------------------------------------------------------ the policy guardrail

test('providerKindFor: auto dispatches on the target; explicit must agree or refuse', () => {
  // 'auto' is pass-through — the scheme already decided
  assert.equal(providerKindFor('git', 'auto'), 'git')
  assert.equal(providerKindFor('treedx', 'auto'), 'treedx')
  // agreement is agreement
  assert.equal(providerKindFor('git', 'git'), 'git')
  assert.equal(providerKindFor('treedx', 'treedx'), 'treedx')
  // a contradiction THROWS — nothing silently reroutes into another pool
  assert.throws(() => providerKindFor('treedx', 'git'), /contradicts the remote target/)
  assert.throws(() => providerKindFor('git', 'treedx'), /no automatic fallback/)
  // and a policy that is not one of the three words refuses as unusable
  assert.throws(() => providerKindFor('git', 'sftp'), /not one of auto \| git \| treedx/)
})
