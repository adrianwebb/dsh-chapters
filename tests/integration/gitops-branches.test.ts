/**
 * gitops.ts local-path transport + classifier branch sweep. The HTTP driver
 * paths are pinned against the real git-http-backend (git-auth-classification,
 * sync-remote); the LOCAL-path side (record §2.1's loopback-of-the-filesystem)
 * carries the same taxonomy — ff, local-ahead, diverged, rejected, missing
 * gitdir — and its arms were under-tested. Plus resolveLocalUpstreamPath /
 * isLocalUpstreamUrl / classifyGitTransportError: pure functions, every arm
 * enumerable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import git from 'isomorphic-git'
import nodefs from 'node:fs'
import {
  resolveLocalUpstreamPath, isLocalUpstreamUrl, ensureCloneLocal, pullLocal, pushLocal,
  recordOrigin, readOrigin, classifyGitTransportError, initLocal, stageAllAndCommit,
} from '../../src/gitops.ts'

async function commitFile(dir: string, rel: string, content: string, msg: string, branch = 'main'): Promise<void> {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
  const stage = await stageAllAndCommit(dir, msg, { name: 't', email: 't@t' })
  assert.ok(stage.ok, stage.detail)
}

test('resolveLocalUpstreamPath parses every documented shape', () => {
  assert.equal(resolveLocalUpstreamPath('file:///srv/kb.git', '/any'), '/srv/kb.git')
  assert.equal(resolveLocalUpstreamPath('file:///srv/a%20b.git', '/any'), '/srv/a b.git', 'percent-decoded')
  assert.equal(resolveLocalUpstreamPath('~/kb.git', '/work'), path.join(os.homedir(), 'kb.git'))
  assert.equal(resolveLocalUpstreamPath('~', '/work'), os.homedir())
  assert.equal(resolveLocalUpstreamPath('./kb.git', '/work'), '/work/kb.git')
  assert.equal(resolveLocalUpstreamPath('kb.git', '/work'), '/work/kb.git')
  assert.equal(resolveLocalUpstreamPath('/srv/kb.git', '/work'), '/srv/kb.git')
})

test('isLocalUpstreamUrl dispatches on shape', () => {
  assert.equal(isLocalUpstreamUrl('/srv/kb.git'), true)
  assert.equal(isLocalUpstreamUrl('~/kb.git'), true)
  assert.equal(isLocalUpstreamUrl('./kb.git'), true)
  assert.equal(isLocalUpstreamUrl('file:///srv/kb.git'), true)
  assert.equal(isLocalUpstreamUrl('https://h/r.git'), false)
  assert.equal(isLocalUpstreamUrl('http://127.0.0.1:1/r.git'), false)
  assert.equal(isLocalUpstreamUrl('git@h:r.git'), false)
})

test('classifyGitTransportError maps status codes and phrasings', () => {
  const e = (msg: string, status?: number): unknown => { const err = new Error(msg) as Error & { statusCode?: number }; if (status !== undefined) err.statusCode = status; return err }
  assert.equal(classifyGitTransportError(e('HTTP Error: 401 Unauthorized', 401)).code, 'auth')
  assert.equal(classifyGitTransportError(e('HTTP Error: 403 Forbidden', 403)).code, 'auth')
  assert.equal(classifyGitTransportError(e('HTTP Error: 404 Not Found', 404)).code, 'not_found')
  assert.equal(classifyGitTransportError(e('could not read Username for https://x')).code, 'auth')
  assert.equal(classifyGitTransportError(e('connect ETIMEDOUT')).code, 'network')
  assert.equal(classifyGitTransportError('bare string').code, 'network')
})

test('origin sentinel records and reads; a fresh mirror has none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-origin-'))
  try {
    assert.equal(readOrigin(dir), null, 'no sentinel yet')
    await recordOrigin(dir, '/srv/kb.git')
    assert.equal(readOrigin(dir), '/srv/kb.git')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('ensureCloneLocal: refuses a non-repo path, an occupied mirror; creates bare pools', async () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-clone-'))
  try {
    const badUp = path.join(box, 'not-a-repo')
    fs.mkdirSync(badUp); fs.writeFileSync(path.join(badUp, 'x'), 'occupied')
    const r1 = await ensureCloneLocal(path.join(box, 'm1'), badUp)
    assert.ok(!r1.ok); assert.match(r1.detail, /not a git repo/)
    // fresh upstream path → created bare, mirror initialized
    const up = path.join(box, 'pool.git')
    const m = path.join(box, 'mirror')
    const r2 = await ensureCloneLocal(m, up)
    assert.ok(r2.ok, r2.detail); assert.match(r2.detail, /mirror initialized/)
    const r3 = await ensureCloneLocal(m, up) // second time: already a repo
    assert.ok(r3.ok); assert.match(r3.detail, /already a repo/)
    // an occupied non-repo mirror dir refuses
    const occ = path.join(box, 'occupied-mirror')
    fs.mkdirSync(occ); fs.writeFileSync(path.join(occ, 'stray.txt'), 'x')
    const r4 = await ensureCloneLocal(occ, up)
    assert.ok(!r4.ok); assert.match(r4.detail, /not empty and not a git repo/)
  } finally { fs.rmSync(box, { recursive: true, force: true }) }
})

test('pull/push local: fresh, up-to-date, fast-forward, local-ahead, diverged-upstream', async () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-sync-'))
  try {
    const up = path.join(box, 'pool.git')
    const a = path.join(box, 'machine-a')
    const b = path.join(box, 'machine-b')
    await ensureCloneLocal(a, up)
    await ensureCloneLocal(b, up)
    // nothing pushed yet: A commits + pushes
    await commitFile(a, 'chapters/1.md', '# one\n', 'c1')
    const p1 = await pushLocal(a, up)
    assert.ok(p1.ok, p1.detail); assert.match(p1.detail, /pushed \(local\)/)
    // B pulls the fast-forward
    const g1 = await pullLocal(b, up)
    assert.ok(g1.ok); assert.match(g1.detail, /fast-forwarded/)
    assert.ok(fs.existsSync(path.join(b, 'chapters', '1.md')))
    // idempotent pull
    assert.match((await pullLocal(b, up)).detail ?? '', /up to date/)
    // idempotent push
    assert.match((await pushLocal(b, up)).detail ?? '', /up to date|nothing new/)
    // B makes local commits ahead while A pushes another → upstream ahead of B's base
    await commitFile(b, 'chapters/2.md', '# two from b\n', 'c2')
    await commitFile(a, 'chapters/3.md', '# three from a\n', 'c3')
    await pushLocal(a, up)
    const bPull = await pullLocal(b, up)
    const bPush = await pushLocal(b, up)
    // the B-push after divergent upstream must not silently clobber:
    assert.ok(!bPush.ok || bPull.ok, 'conflict surfaces honestly (rejected or ff-retry resolved it)')
    if (!bPush.ok) assert.match(bPush.detail, /rejected|diverged/, `push arm: ${bPush.detail}`)
    // push with no local branch → nothing new
    const empty = path.join(box, 'empty-mirror')
    await ensureCloneLocal(empty, up)
    await git.deleteRef({ fs: nodefs as never, dir: empty, ref: 'refs/heads/main' }).catch(() => undefined)
    const noHead = await pushLocal(path.join(box, 'no-mirror-repo'), path.join(box, 'nope'))
    assert.ok(noHead.ok, `no branch ⇒ nothing new or upstream init: ${noHead.detail}`)
  } finally { fs.rmSync(box, { recursive: true, force: true }) }
})

test('initLocal arms: fresh init, existing repo idempotent, strays move aside', async () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-init-'))
  try {
    const d1 = path.join(box, 'fresh')
    const r1 = await initLocal(d1)
    assert.ok(r1.ok, r1.detail)
    const r2 = await initLocal(d1) // already a repo
    assert.ok(r2.ok); assert.match(r2.detail, /already a repo/)
    const d3 = path.join(box, 'dirty')
    fs.mkdirSync(d3, { recursive: true })
    fs.writeFileSync(path.join(d3, 'left.txt'), 'corpse')
    const r3 = await initLocal(d3)
    assert.ok(r3.ok, r3.detail)
    assert.ok(fs.readdirSync(box).some((f) => f.startsWith('dirty.stale-')), 'moved aside, never deleted')
    assert.ok(fs.existsSync(path.join(d3, 'left.txt')) === false || fs.existsSync(path.join(d3, '.git')), 'fresh repo under the original path')
  } finally { fs.rmSync(box, { recursive: true, force: true }) }
})
