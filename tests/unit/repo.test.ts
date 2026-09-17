/**
 * repo.ts — project identity (record §2.3) and layout (§2.2). The property
 * that matters most is tested directly: the same project, four URL forms,
 * every machine → one key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  canonicalizeRemote,
  projectKeyFromRemote,
  parseGitConfigRemoteUrl,
  readProjectRemote,
  resolveProject,
  repoPaths,
  uuidv5,
  NAMESPACE_OID,
} from '../../src/repo.ts'

const FORMS = [
  'https://github.com/Adrian/Repo.git',
  'git@github.com:adrian/repo.git',
  'ssh://git@github.com/adrian/repo/',
  'https://github.com/adrian/repo',
]

test('canonicalization: four forms of the same remote → one canonical', () => {
  const canon = new Set(FORMS.map(canonicalizeRemote))
  assert.equal(canon.size, 1)
  assert.equal([...canon][0], 'github.com/adrian/repo')
})

test('canonicalization: the host is identity (two hosts, same path → two keys)', () => {
  assert.notEqual(projectKeyFromRemote('https://github.com/adrian/repo'), projectKeyFromRemote('https://gitlab.com/adrian/repo'))
})

test('projectKey: stable across forms and calls; UUIDv5 shape; version nibble 5; variant 10xx', () => {
  const keys = new Set(FORMS.map(projectKeyFromRemote))
  assert.equal(keys.size, 1)
  const key = [...keys][0]!
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('uuidv5: deterministic, name-sensitive, namespace-validated', () => {
  const ns = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
  assert.equal(uuidv5(ns, 'a/b'), uuidv5(ns, 'a/b'))
  assert.notEqual(uuidv5(ns, 'a/b'), uuidv5(ns, 'a/c'))
  assert.throws(() => uuidv5('not-a-uuid', 'x'), /namespace/)
})

const CONFIG_TEXT = `
# comment
; another
[core]
	repositoryformatversion = 0
	filemode = true
[remote "origin"]
	url = https://github.com/adrian/repo.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[remote "upstream"]
	url = https://github.com/other/repo.git
[branch "main"]
	remote = origin
`

test('parseGitConfigRemoteUrl: origin wins, even when not first listed', () => {
  assert.equal(parseGitConfigRemoteUrl(CONFIG_TEXT), 'https://github.com/adrian/repo.git')
  const noOrigin = CONFIG_TEXT.replace('[remote "origin"]\n\turl = https://github.com/adrian/repo.git\n', '')
  assert.equal(parseGitConfigRemoteUrl(noOrigin), 'https://github.com/other/repo.git')
  assert.equal(parseGitConfigRemoteUrl(CONFIG_TEXT.replace(/\[remote[^\]]*\][^\[]*/g, '')), null)
})

function withTmpDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-test-'))
  try { fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('readProjectRemote: .git directory with config', () => {
  withTmpDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.git'))
    fs.writeFileSync(path.join(cwd, '.git', 'config'), CONFIG_TEXT)
    assert.deepEqual(readProjectRemote(cwd), { remote: 'https://github.com/adrian/repo.git', source: 'remote' })
  })
})

test('readProjectRemote: .git file with a gitdir: pointer (relative worktree form)', () => {
  withTmpDir((cwd) => {
    // real worktree shape: the MAIN repo lives elsewhere; .git in the
    // checkout is a FILE pointing at main/.git/worktrees/<name>/
    fs.mkdirSync(path.join(cwd, 'main', '.git', 'worktrees', 'wt'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'main', '.git', 'worktrees', 'wt', 'config'), CONFIG_TEXT)
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: main/.git/worktrees/wt\n')
    assert.deepEqual(readProjectRemote(cwd), { remote: 'https://github.com/adrian/repo.git', source: 'remote' })
  })
})

test('readProjectRemote: non-git workspace → null (caller decides the path-derived key)', () => {
  withTmpDir((cwd) => {
    assert.equal(readProjectRemote(cwd), null)
  })
})

test('resolveProject: override > discovered remote > path-derived (flagged)', () => {
  withTmpDir((cwd) => {
    const noGit = resolveProject(cwd)
    assert.equal(noGit.projectKeySource, 'path-derived')
    assert.equal(noGit.remote, null)
    assert.equal(noGit.projectKey, uuidv5(NAMESPACE_OID, cwd))
    fs.mkdirSync(path.join(cwd, '.git'))
    fs.writeFileSync(path.join(cwd, '.git', 'config'), CONFIG_TEXT)
    const viaRemote = resolveProject(cwd)
    assert.equal(viaRemote.projectKeySource, 'remote')
    assert.equal(viaRemote.projectKey, projectKeyFromRemote('https://github.com/adrian/repo.git'))
    const overridden = resolveProject(cwd, 'override-key')
    assert.deepEqual(overridden, { projectKey: 'override-key', projectKeySource: 'override', remote: null })
  })
})

test('repoPaths: layout matches record §2.2', () => {
  const p = repoPaths('KEY', 'harness-1', 'session-1')
  assert.equal(p.projectYml, path.join('project.yml'))
  assert.equal(p.chaptersDir, path.join('chapters', 'KEY', 'session-1'))
  assert.equal(repoPaths('KEY', 'harness-1').chaptersDir, path.join('chapters', 'KEY'))
  assert.equal(p.artifactsDir, path.join('artifacts', 'KEY'))
  assert.equal(p.collectionsFile('s1'), path.join('collections', 'KEY', 's1.jsonl'))
  assert.equal(p.indexDir, path.join('index'))
  assert.equal(p.indexManifest, path.join('index', 'manifest.json'))
  assert.equal(p.curationFile, path.join('edits', 'harness-1', 'curation.jsonl'))
  assert.equal(p.rulesDir, path.join('rules', 'KEY'))
  assert.equal(p.vocabularyJson, path.join('topics', 'vocabulary.json'))
})
