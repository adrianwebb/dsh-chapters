/**
 * The P1 exit criterion (record §13), automated: TWO machines, ONE repo,
 * over REAL git-over-HTTP (stock git-http-backend serving bare repos on
 * loopback; isomorphic-git as the only client — the same stack production
 * uses). Machine A publishes chapters; machine B clones, sees them, and
 * SEARCH FINDS them; B publishes back; A converges. Plus the full
 * degradation arc over the same real remote: unreachable → offline
 * local-only mirror keeps working → remote returns → diverged-rebuild
 * pushes the backlog. Skips honestly when git is unavailable.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, readSyncStatus, DEFAULT_CLONE_DIR } from '../../src/sync.ts'
import { searchKnowledge } from '../../src/search.ts'
import { startGitHttpServer, remoteFiles, type GitHttpServer } from './http-git-server.ts'

let root: string
let server: GitHttpServer | null = null
let repoUrl: string | null = null

const project = (harness: string, remote: string) => ({
  projectKey: 'KEY-REMOTE',
  slug: 'remotetest',
  remote,
  harnessId: harness,
  linkedAt: new Date().toISOString(),
  cwd: '',
})
const writeFile = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
/** A chapter shaped like what the renderer writes (frontmatter + body). */
const chapterFile = (title: string, body: string, topics: string[]): string =>
  `---\ntitle: "${title}"\ntopics: [${topics.map((t) => JSON.stringify(t)).join(', ')}]\n---\n# ${title}\n\n${body}\n`

const sync = (cwd: string, harness: string, opts: { token?: string } = {}) => {
  if (repoUrl === null) throw new Error('no remote')
  return runSync({
    cwd,
    storeRoot: '.dsh-chapters',
    cloneDir: DEFAULT_CLONE_DIR,
    project: project(harness, repoUrl),
    force: true,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  })
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-remote-'))
  server = await startGitHttpServer(path.join(root, 'gitserver'))
  repoUrl = server?.serveRepo('kb.git') ?? null
})
after(async () => {
  await server?.stop()
  fs.rmSync(root, { recursive: true, force: true })
})

test('two machines, one repo: A publishes, B clones and SEARCH FINDS A (exit criterion)', async (t) => {
  if (server === null || repoUrl === null) { t.skip('git http-backend unavailable'); return }
  assert.ok(server !== null && repoUrl !== null)
  const a = path.join(root, 'machine-a')
  const b = path.join(root, 'machine-b')
  // A archives two chapters + a collection file, then syncs
  writeFile(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '001-renderer-deferral.md'),
    chapterFile('Renderer deferral of tool results', 'Tool results above the floor defer to artifacts; see src/render.ts.', ['src/render.ts', 'artifacts']))
  writeFile(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '002-signature-scoring.md'),
    chapterFile('Signature scoring', 'Overlap of paths/commands/terms with paths weighted double.', ['src/compose.ts', 'signature']))
  writeFile(path.join(a, '.dsh-chapters', 'treeA', 'artifacts', 'ab', 'abcdef.txt'), 'deferred tool output\n')
  const ra = await sync(a, 'harness-a', { token: 'tok-a' })
  assert.ok(ra.ok, `A should reach the remote: ${ra.detail} | ${ra.steps.join('; ')}`)
  assert.equal(ra.mode, 'synced')
  // the remote really carries the layout
  const files = await remoteFiles(repoUrl, 'tok-check')
  assert.ok(files.includes(path.join('chapters', 'KEY-REMOTE', 'treeA', '001-renderer-deferral.md').split(path.sep).join('/')), files.join(', '))
  assert.ok(files.some((f) => f.startsWith('index/')), 'the derived index shipped too')

  // B syncs: clone lands A's chapters in its mirror, index built, search finds them
  fs.mkdirSync(b)
  const rb = await sync(b, 'harness-b')
  assert.ok(rb.ok, rb.detail)
  const mirror = path.join(b, DEFAULT_CLONE_DIR)
  assert.ok(fs.existsSync(path.join(mirror, 'chapters', 'KEY-REMOTE', 'treeA', '001-renderer-deferral.md')))
  const hits = searchKnowledge(mirror, 'renderer deferral tool results', 500, { projectKey: 'KEY-REMOTE' })
  assert.ok(hits.total >= 1, `search must find the other machine's chapter: ${JSON.stringify(hits.results)}`)
  assert.match(hits.results[0]!.title, /Renderer deferral/)

  // B publishes its own work; A pulls it (the pool grows both ways)
  writeFile(path.join(b, '.dsh-chapters', 'treeB', 'chapters', '001-sync-loop-machine-b.md'),
    chapterFile('The sync loop from machine B', 'Lock, publish, ff-only, local-only degradation.', ['src/sync.ts', 'gitops']))
  const rb2 = await sync(b, 'harness-b')
  assert.ok(rb2.ok, rb2.detail)
  const ra2 = await sync(a, 'harness-a', { token: 'tok-a' })
  assert.ok(ra2.ok, ra2.detail)
  const mirrorA = path.join(a, DEFAULT_CLONE_DIR)
  const back = searchKnowledge(mirrorA, 'sync loop machine B lock', 500, { projectKey: 'KEY-REMOTE' })
  assert.ok(back.total >= 1, 'A must now see B’s chapter')
})

test('degradation over the REAL protocol: unreachable remote keeps the mirror current, recovery lands the backlog', async (t) => {
  if (server === null || repoUrl === null) { t.skip('git http-backend unavailable'); return }
  assert.ok(server !== null && repoUrl !== null)
  const c = path.join(root, 'machine-c')
  writeFile(path.join(c, '.dsh-chapters', 'treeC', 'chapters', '001-offline-chapter.md'),
    chapterFile('Offline chapter', 'Written while the remote was down.', ['offline']))
  // remote unreachable: wrong port on the same host
  const offlineUrl = 'http://127.0.0.1:9/repos/kb.git'
  const r1 = await runSync({ cwd: c, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: project('harness-c', offlineUrl), force: true })
  assert.equal(r1.ok, false)
  assert.equal(r1.mode, 'local-only', 'unreachable clone ⇒ offline mirror, not a dead end')
  // the mirror is CURRENT locally: file published + index built into it
  assert.ok(fs.existsSync(path.join(c, DEFAULT_CLONE_DIR, 'chapters', 'KEY-REMOTE', 'treeC', '001-offline-chapter.md')))
  assert.ok(fs.existsSync(path.join(c, DEFAULT_CLONE_DIR, 'index')), 'index built even offline')
  const st = readSyncStatus(c, '.dsh-chapters')
  assert.equal(st?.mode, 'local-only')
  // recovery: same project record, reachable remote → diverged-rebuild lands it
  const r2 = await runSync({ cwd: c, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: project('harness-c', repoUrl), force: true })
  assert.ok(r2.ok, `recovery should push the backlog: ${r2.detail} | ${r2.steps.join('; ')}`)
  const files = await remoteFiles(repoUrl, undefined)
  assert.ok(files.some((f) => f.endsWith('001-offline-chapter.md')), `remote must carry the offline-written chapter: ${files.join(', ')}`)
})
