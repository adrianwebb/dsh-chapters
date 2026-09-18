/**
 * The local-path upstream (user directive 2026-09-18): '/chapters-link
 * <path>' binds the pool to a bare DIRECTORY — no HTTP, no credentials, and
 * the transport is isomorphic-git's own pack layer (packObjects → indexPack),
 * so still zero git-binary. This test is the full loop: link A (creates the
 * pool), B clones and SEARCHES A's chapters, both machines keep publishing,
 * and a genuine fork (both pushed from the same base) converges through the
 * divergence-rebuild — all on the filesystem.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as git from 'isomorphic-git'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, buildIndexInClone, DEFAULT_CLONE_DIR, type ProjectRecord } from '../../src/sync.ts'
import { searchKnowledge } from '../../src/search.ts'
import { isomorphicDriver } from '../../src/gitops.ts'

const project = (cwd: string, remote: string): ProjectRecord => ({
  projectKey: 'KEYLOCAL', slug: 'pool', remote, harnessId: 'h', linkedAt: new Date().toISOString(), cwd,
})
const writeFile = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const chapter = (title: string, body: string, topics: string[]): string =>
  `---\ntitle: "${title}"\ntopics: [${topics.map((t) => JSON.stringify(t)).join(', ')}]\n---\n# ${title}\n\n${body}\n`
const sync = (cwd: string, remote: string) =>
  runSync({ cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: project(cwd, remote), force: true })

test('two machines, one local-path pool: create → clone → search crosses → both publish → divergence rebuild converges', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pool-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  const b = path.join(root, 'machine-b')
  try {
    // A links first: pool materialized, A's chapters pushed
    writeFile(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '001-render-decisions.md'),
      chapter('Render decisions', 'Tool-result deferral lives in src/render.ts.', ['src/render.ts']))
    const ra = await sync(a, pool)
    assert.ok(ra.ok, ra.detail)
    assert.equal(ra.mode, 'synced')
    assert.ok(fs.existsSync(path.join(pool, 'HEAD')), 'pool was created as a git repo')
    const headPool = await git.resolveRef({ fs: fs as never, dir: pool, gitdir: pool, ref: 'refs/heads/main' }).catch(() => null)
    assert.ok(headPool !== null, 'pool carries a main branch')

    // B clones and finds A's knowledge via search
    fs.mkdirSync(b)
    const rb = await sync(b, pool)
    assert.ok(rb.ok, rb.detail)
    assert.ok(fs.existsSync(path.join(b, DEFAULT_CLONE_DIR, 'chapters', 'KEYLOCAL', 'treeA', '001-render-decisions.md')))
    const hits = searchKnowledge(path.join(b, DEFAULT_CLONE_DIR), 'render tool deferral', 500, { projectKey: 'KEYLOCAL' })
    assert.ok(hits.total >= 1, 'machine B searches machine A\u2019s chapter across the local pool')

    // B publishes; A pulls it in
    writeFile(path.join(b, '.dsh-chapters', 'treeB', 'chapters', '001-sync-order.md'),
      chapter('Sync order', 'lock publish commit pull push, never throws.', ['src/sync.ts']))
    const rb2 = await sync(b, pool)
    assert.ok(rb2.ok, rb2.detail)
    const ra2 = await sync(a, pool)
    assert.ok(ra2.ok, ra2.detail)
    assert.ok(fs.existsSync(path.join(a, DEFAULT_CLONE_DIR, 'chapters', 'KEYLOCAL', 'treeB', '001-sync-order.md')))

    // Genuine fork: both mirrors advanced independently from an older base.
    writeFile(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '002-fork-a.md'), chapter('Fork A', 'a side', ['src/alpha.ts']))
    const raf = await sync(a, pool)
    assert.ok(raf.ok, `A pushes first: ${raf.detail}`)
    writeFile(path.join(b, '.dsh-chapters', 'treeB', 'chapters', '002-fork-b.md'), chapter('Fork B', 'b side', ['src/beta.ts']))
    const rbf = await sync(b, pool)
    assert.ok(rbf.ok, `B diverged → rebuild converges: ${rbf.detail} | ${rbf.steps.join('; ')}`)
    assert.ok(rbf.steps.some((s) => /rebuild|diverg/i.test(s)), `expected rebuild step, got: ${rbf.steps.join('; ')}`)
    const files = await git.listFiles({ fs: fs as never, dir: pool, gitdir: pool, ref: 'HEAD' })
    assert.ok(files.some((f) => f.endsWith('002-fork-a.md')) && files.some((f) => f.endsWith('002-fork-b.md')),
      `pool must hold BOTH sides after convergence: ${files.join(', ')}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('index builds inside a local mirror and stays deterministic across machines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pool-idx-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  try {
    writeFile(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '001-topic-a.md'), chapter('Topic alpha', 'body', ['src/alpha.ts']))
    const r = await sync(a, pool)
    assert.ok(r.ok)
    const mirrorA = path.join(a, DEFAULT_CLONE_DIR)
    assert.ok(fs.existsSync(path.join(mirrorA, 'index')), 'index built in the mirror during sync')
    const before = buildIndexInClone(mirrorA)
    assert.equal(before, false, 'second build over identical corpus changes nothing (incremental gate)')
    const headPool = await git.resolveRef({ fs: fs as never, dir: pool, gitdir: pool, ref: 'refs/heads/main' })
    assert.ok(headPool.length === 40)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
