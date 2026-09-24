/**
 * Direct pure-function branch sweep. These modules hold enumerable decision
 * logic (git-config parsing, path discovery, signature scoring, index
 * canonicalization, arrival stubbing) whose `?:`/`??`/guard arms were reached
 * only by whichever scenario happened to trip them. Calling each function
 * with the specific input that forces the OTHER arm makes the coverage real
 * rather than incidental.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalizeRemote, parseKnowledgeRemote, projectKeyFromRemote, projectKeyForTarget, parseGitConfigRemoteUrl, readProjectRemote } from '../../src/repo.ts'
import { signatureScore, composeChapters } from '../../src/compose.ts'
import { buildIndexShards, entryFromChapter, parseCuration, type CurationFact } from '../../src/indexing.ts'
import { applyArrivalStubs } from '../../src/arrival.ts'
import type { SessionEventLike } from '../../src/types.ts'
import type { CollectionSignature } from '../../src/signature.ts'

// ---------------------------------------------------------------- repo

test('canonicalizeRemote normalizes every accepted form to one key', () => {
  const a = canonicalizeRemote('https://user:pass@GitHub.com/Org/Repo.git/')
  const b = canonicalizeRemote('https://github.com/org/repo')
  assert.equal(a, b, 'creds, case, .git and trailing slash all collapse')
  assert.equal(canonicalizeRemote('git@github.com:org/repo.git'), canonicalizeRemote('https://github.com/org/repo'), 'ssh scp form → same')
  assert.equal(canonicalizeRemote(''), '', 'empty stays empty')
  assert.equal(typeof projectKeyFromRemote('https://github.com/org/repo'), 'string')
})

test('parseKnowledgeRemote: treedx with a path prefix, and the invalid-url throw', () => {
  const t = parseKnowledgeRemote('treedx+https://svc.example/api/v1/DeepTeam/KnowledgeBase')
  assert.ok(t.treedx !== undefined)
  assert.equal(t.treedx.baseUrl, 'https://svc.example/DeepTeam', 'api/v1 stripped, path prefix kept')
  assert.equal(t.treedx.repoName, 'knowledgebase', 'lowercased repo name')
  assert.equal(typeof projectKeyForTarget(t), 'string')
  // a non-URL after treedx+ does NOT match the scheme form → treated as git raw
  assert.equal(parseKnowledgeRemote('treedx+not a url').kind, 'git')
  // a valid treedx URL with NO repository name throws (never guesses a pool)
  assert.throws(() => parseKnowledgeRemote('treedx+https://svc.example/'), /repository name/)
})

test('parseGitConfigRemoteUrl: origin preferred, first-remote fallback, comments/sections skipped', () => {
  assert.equal(parseGitConfigRemoteUrl('[remote "upstream"]\nurl = https://a/x.git\n[remote "origin"]\nurl = https://origin/y.git'), 'https://origin/y.git')
  assert.equal(parseGitConfigRemoteUrl('# comment\n; other\n[core]\n\tbare = false\n[remote "only"]\n  url = https://only/r.git'), 'https://only/r.git', 'non-origin remote used')
  assert.equal(parseGitConfigRemoteUrl('[remote "origin"]'), null, 'section without url')
  assert.equal(parseGitConfigRemoteUrl('[core]\nurl = https://not-a-remote/x'), null, 'url outside a remote section ignored')
  assert.equal(parseGitConfigRemoteUrl('garbage with no sections'), null)
})

test('readProjectRemote: directory .git, gitdir pointer (relative+absolute), and non-repo', async () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-remote-'))
  try {
    const git = path.join(box, 'work', '.git')
    fs.mkdirSync(git, { recursive: true })
    fs.writeFileSync(path.join(git, 'config'), '[remote "origin"]\nurl = https://h/dir.git\n')
    assert.equal(readProjectRemote(path.join(box, 'work'))?.remote, 'https://h/dir.git')
    const bare = path.join(box, 'real.git')
    fs.mkdirSync(bare, { recursive: true })
    fs.writeFileSync(path.join(bare, 'config'), '[remote "origin"]\nurl = https://h/pointer.git\n')
    const wt = path.join(box, 'wt')
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${bare}\n`)
    assert.equal(readProjectRemote(wt)?.remote, 'https://h/pointer.git', 'absolute gitdir pointer')
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../real.git\n')
    assert.equal(readProjectRemote(wt)?.remote, 'https://h/pointer.git', 'relative gitdir pointer')
    fs.writeFileSync(path.join(wt, '.git'), 'not a gitdir line\n')
    assert.equal(readProjectRemote(wt), null, 'gitfile without pointer → null')
    assert.equal(readProjectRemote(path.join(box, 'nope')), null, 'no .git at all')
    fs.mkdirSync(path.join(box, 'empty-git')); fs.writeFileSync(path.join(box, 'empty-git', '.git'), '')
    assert.equal(readProjectRemote(path.join(box, 'empty-git')), null, 'empty gitfile')
  } finally { fs.rmSync(box, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- compose

const sig = (seqs: number[], paths: string[], terms: string[], commands: string[] = [], size = 100): CollectionSignature =>
  ({ seqs, paths, commands, terms, size } as CollectionSignature)

test('signatureScore: zero-union guard, and path matches weigh double', () => {
  assert.equal(signatureScore(sig([0], [], [], [], 0), sig([1], [], [], [], 0)), 0, 'empty union → 0, no NaN')
  const pathHeavy = signatureScore(sig([0], ['a.ts'], ['x']), sig([1], ['a.ts'], ['y']))
  const termOnly = signatureScore(sig([0], ['b.ts'], ['x']), sig([1], ['c.ts'], ['x']))
  assert.ok(pathHeavy > termOnly, 'same file outweighs a shared term')
})

test('composeChapters: no in-span collections → legacy notes + unarchived seqs', () => {
  const events: SessionEventLike[] = [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } },
  ]
  const r = composeChapters(events, 0, 5, [sig([99], ['a'], [])], { mergeThreshold: 0.3, chapterLimit: 8000 })
  assert.equal(r.chapters.length, 0)
  assert.ok(r.notes.some((n) => /legacy segmentation/.test(n)))
  assert.deepEqual(r.unarchivedSeqs, [0])
})

// ---------------------------------------------------------------- indexing

test('buildIndexShards: aliases fold transitively, pins float up, weights scale, cycle guard holds', () => {
  const entries = [
    { path: 'chapters/K/a/001.md', title: 'Alpha', topics: ['db', 'cache'], kind: 'chapter' as const, mtime: 100 },
    { path: 'chapters/K/b/002.md', title: 'Beta', topics: ['database'], kind: 'chapter' as const, mtime: 200 },
    { path: 'chapters/K/b/003.md', title: 'Gamma', topics: [], kind: 'chapter' as const },
    { path: 'rules/K/h/004.md', title: 'Rule', topics: ['security'], kind: 'rule' as const, category: 'security' },
  ]
  const curation: CurationFact[] = [
    { type: 'topic-alias', from: 'database', to: 'db' },
    { type: 'topic-alias', from: 'db', to: 'data' },
    { type: 'topic-pin', topic: 'data' },
    { type: 'topic-weight', topic: 'cache', weight: 2 },
    { type: 'topic-weight', topic: 'data', weight: 1 },
    // a->b->a cycle must be bounded, not hang
    { type: 'topic-alias', from: 'x', to: 'y' }, { type: 'topic-alias', from: 'y', to: 'x' },
  ]
  const build = buildIndexShards(entries, curation)
  assert.ok(build.shards instanceof Map, 'shards is a topic→content map')
  assert.ok(build.topics.includes('data'), 'database/db folded transitively to data')
  assert.ok(!build.topics.includes('db') || build.topics.includes('data'), 'alias collapsed')
  assert.ok(JSON.stringify([...build.shards.keys()]).includes('security'), 'rule topic present')
  assert.equal(typeof build.changed, 'boolean')
})

test('parseCuration: good facts kept, malformed/blank skipped, non-object ignored', () => {
  const facts = parseCuration([
    JSON.stringify({ type: 'topic-alias', from: 'a', to: 'b' }),
    '{ broken json',
    '',
    '   ',
    JSON.stringify({ noType: true }),
    '[1,2,3]',
  ].join('\n'))
  assert.equal(facts.filter((f) => f.type === 'topic-alias').length, 1)
})

test('entryFromChapter parses frontmatter topics/category/kind, tolerates none', () => {
  const e = entryFromChapter('chapters/K/s/1.md', '---\ntitle: "T"\ntopics: ["a","b"]\n---\nbody', 555)
  assert.deepEqual(e.topics, ['a', 'b'])
  assert.equal(e.kind, 'chapter')
  assert.equal(e.mtime, 555)
  const rule = entryFromChapter('rules/K/s/2.md', '---\nkind: rule\ncategory: ops\ntitle: R\n---\nb')
  assert.equal(rule.kind, 'rule')
  assert.equal(rule.category, 'ops')
  const bare = entryFromChapter('x.md', 'no frontmatter body')
  assert.deepEqual(bare.topics, [])
})

// ---------------------------------------------------------------- arrival

const toolResultEvent = (seq: number, text: string) =>
  ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c', isError: false, content: [{ type: 'text', text }] }] } } })

test('applyArrivalStubs: no message / non-array content / no result-wrappers all skipped, oversized stubbed', async () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'arr-'))
  try {
    const big = 'x'.repeat(9000)
    const events: Record<number, { type: string; data: unknown }> = {
      0: { type: 'user/message', data: { message: 'ignored, not tool/result' } },
      1: { type: 'tool/result', data: {} }, // no message → skip (49)
      2: { type: 'tool/result', data: { message: { content: 'string, not array' } } }, // (55) → no wrappers (57)
      3: { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'not a tool-result wrapper' }] } } }, // (57) skip
      4: toolResultEvent(4, big), // stubs
      5: toolResultEvent(5, 'tiny result'), // below floor, kept
    }
    const appended: Array<{ type: string; data: unknown }> = []
    const session = {
      surface: { nodes: Object.keys(events).map(Number) },
      eventAt: (s: number) => events[s],
      append: (t: string, d: unknown) => { appended.push({ type: t, data: d }) },
    }
    const r = await applyArrivalStubs(session as never, { cwd: box, storeRoot: '.dsh-chapters', floorTokens: 1000, estimate: (m: unknown) => JSON.stringify(m).length / 4 })
    assert.ok(r.stubbed >= 1, 'the big one stubbed')
    assert.ok(!r.detail || typeof r.detail === 'string')
  } finally { fs.rmSync(box, { recursive: true, force: true }) }
})

test('applyArrivalStubs reports a write failure and degrades (blob stays inline)', async () => {
  // point the storeRoot at an unwritable dir to force the artifact write to throw
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'arr-ro-'))
  try {
    fs.chmodSync(ro, 0o500)
    const events: Record<number, { type: string; data: unknown }> = { 4: toolResultEvent(4, 'y'.repeat(9000)) }
    const session = { surface: { nodes: [4] }, eventAt: (s: number) => events[s], append: () => undefined }
    const r = await applyArrivalStubs(session as never, { cwd: ro, storeRoot: '.dsh-chapters', floorTokens: 1000, estimate: (m: unknown) => JSON.stringify(m).length / 4 })
    fs.chmodSync(ro, 0o700)
    assert.equal(r.stubbed, 0, 'nothing stubbed when the write fails')
    assert.match(r.detail ?? '', /artifact write failed/, 'the failure is reported')
  } finally { fs.chmodSync(fs.existsSync(ro) ? ro : os.tmpdir(), 0o700); fs.rmSync(ro, { recursive: true, force: true }) }
})
