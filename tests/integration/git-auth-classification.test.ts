/**
 * Git-plane failure classes over a REAL smart-HTTP remote that answers 401.
 * Before the 2026-09-23 coverage audit the git provider classified every
 * transport error as 'network' — a rejected token rendered as "remote
 * unreachable", the exact ghost the live-TreeDX run taught us to forbid.
 * This pins the fix: auth rides as auth through ensureClone/pull/push into
 * the degrade-to-local-only status text, and the sync loop's honest wording
 * ('credentials rejected…') survives the offline fallback.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitProvider } from '../../src/provider.ts'
import { classifyGitTransportError } from '../../src/gitops.ts'
import { runSync } from '../../src/sync.ts'
import { startGitHttpServer, type GitHttpServer } from './http-git-server.ts'

const root: string = fs.mkdtempSync(path.join(os.tmpdir(), 'gitauth-'))
// started at MODULE level (await) — a { skip: } evaluated at registration
// against a before()-filled variable would skip unconditionally: the exact
// load-time-skip trap already fixed once in treedx-live.test.ts
const server: GitHttpServer | null = await startGitHttpServer(path.join(root, 'pools'))
const GATE = 'right-token'

after(async () => {
  // stub-owning files MUST stop their listener (undici keep-alive hangs the
  // file's event loop otherwise — the lesson pinned in treedx-stub-server.ts)
  await server?.stop()
  fs.rmSync(root, { recursive: true, force: true })
})

const project = (remote: string) => ({
  projectKey: 'GITAUTH', slug: 'kb', remote, harnessId: 'h', linkedAt: 'now', cwd: root,
})
const sync = (url: string, token: string | undefined, host: string) =>
  runSync({ cwd: path.join(root, host), storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: project(url), ...(token !== undefined ? { token } : {}), force: true })

test('classifyGitTransportError maps the isomorphic-git error shapes', () => {
  const httpErr = (msg: string, status?: number): unknown => {
    const e = new Error(msg) as Error & { statusCode?: number }
    if (status !== undefined) e.statusCode = status
    return e
  }
  assert.equal(classifyGitTransportError(httpErr('HTTP Error: 401 Unauthorized', 401)).code, 'auth')
  assert.equal(classifyGitTransportError(httpErr('HTTP Error: 403 Forbidden', 403)).code, 'auth')
  assert.equal(classifyGitTransportError(httpErr('HTTP Error: 404 Not Found', 404)).code, 'not_found')
  assert.equal(classifyGitTransportError(httpErr('could not read Username for https://github.com')).code, 'auth')
  assert.equal(classifyGitTransportError(httpErr('git clone: connect ECONNREFUSED')).code, 'network')
  assert.equal(classifyGitTransportError('plain string').code, 'network')
})

test('ensureClone probes the wire first: a 401 answers auth, not a silent empty clone', { skip: server === null ? 'no git http-backend' : false }, async () => {
  const url = server!.serveRepo('gited.git', { requireToken: GATE })
  const r = await gitProvider.ensureClone(path.join(root, 'probe-bad'), { url, token: 'WRONG' })
  assert.ok(!r.ok, 'the probe must refuse what isomorphic-git would silently accept')
  assert.equal(r.code, 'auth', `expected auth, got ${r.code}: ${r.detail}`)
  // no-token gets the same honest answer (server challenged; nothing answered)
  const r2 = await gitProvider.ensureClone(path.join(root, 'probe-none'), { url })
  assert.ok(!r2.ok)
  assert.equal(r2.code, 'auth')
  // a healthy EMPTY repo still clones ok — the probe distinguishes 200-no-refs from 401
  const openEmpty = server!.serveRepo('open-empty.git')
  const r3 = await gitProvider.ensureClone(path.join(root, 'probe-good'), { url: openEmpty })
  assert.ok(r3.ok, `empty-but-open must not be refused: ${r3.detail}`)
  // and the right token works
  const r4 = await gitProvider.ensureClone(path.join(root, 'probe-right'), { url, token: GATE })
  assert.ok(r4.ok, `right token: ${r4.detail}`)
})

test('the loop degrades to local-only with CREDENTIALS wording, never unreachable-ghost', { skip: server === null ? 'no git http-backend' : false }, async () => {
  const url = server!.serveRepo('gated2.git', { requireToken: GATE })
  const r = await sync(url, 'WRONG', 'machine-x')
  assert.ok(!r.ok)
  assert.equal(r.mode, 'local-only', `expected local-only, got ${r.mode}: ${r.detail}`)
  assert.match(r.detail, /credentials rejected/, 'the auth truth reaches the status line')
  assert.match(r.detail, /re-link with \/chapters-link/, 'and says what to DO about it')
  // the offline mirror is still real: work continues locally
  assert.ok(fs.existsSync(path.join(root, 'machine-x', '.dsh-knowledge')), 'offline mirror initialized')
})

test('a bad token NEVER reports a successful push (the silent-loss hole)', { skip: server === null ? 'no git http-backend' : false }, async () => {
  // A gated repo + a host with real chapters to publish. Without the probe,
  // isomorphic-git treats the 401 as 'empty server': the clone lands empty,
  // the push 'succeeds' having delivered NOTHING, and runSync reports synced.
  // The honest outcomes are only: auth-shaped failure, or a local-only mode
  // that says credentials are the problem.
  const url = server!.serveRepo('gated-push.git', { requireToken: GATE })
  const host = path.join(root, 'machine-y')
  fs.mkdirSync(path.join(host, '.dsh-chapters', 'GITPUSH', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(host, '.dsh-chapters', 'GITPUSH', 'chapters', '001-real.md'), '---\ntitle: "real work"\ntopics: ["push"]\n---\n# real work\n\ncontent worth syncing\n')
  const r = await runSync({
    cwd: host, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge',
    project: { projectKey: 'GITPUSH', slug: 'kb', remote: url, harnessId: 'h', linkedAt: 'now', cwd: host },
    token: 'WRONG', force: true,
  })
  assert.ok(!(r.ok && r.mode === 'synced'), `a WRONG token must never report synced — steps: ${r.steps?.join('; ')}`)
  assert.match(`${r.detail} ${r.steps?.join('; ')}`, /auth|credentials/i, 'the failure names credentials, not ghosts')
})

test('push/pull verbs themselves surface auth when a mirror already exists', { skip: server === null ? 'no git http-backend' : false }, async () => {
  const openUrl = server!.serveRepo('seed.git')
  // machine-y above already owns a mirror; here build a clean one over the open repo
  const seedDir = path.join(root, 'pusher')
  const clone = await gitProvider.ensureClone(seedDir, { url: openUrl })
  assert.ok(clone.ok)
  fs.mkdirSync(path.join(seedDir, 'chapters', 'SEED'), { recursive: true })
  fs.writeFileSync(path.join(seedDir, 'chapters', 'SEED', '001-a.md'), '---\ntitle: "a"\n---\n# a\n')
  const st = await gitProvider.stageAllAndCommit(seedDir, 'c1', { name: 't', email: 't@t' })
  assert.ok(st.ok, st.detail)
  const p0 = await gitProvider.push(seedDir, { url: openUrl })
  assert.ok(p0.ok, `push to open must work: ${p0.detail}`)
  const gated = server!.serveRepo('gate-push.git', { requireToken: GATE })
  const p = await gitProvider.push(seedDir, { url: gated, token: 'WRONG' })
  assert.ok(!p.ok, 'the 401 must not read as pushed')
  assert.equal(p.code, 'auth', `expected auth, got ${p.code} (${p.detail})`)
  const pl = await gitProvider.pullFastForward(seedDir, { url: gated, token: 'WRONG' })
  assert.ok(!pl.ok)
  assert.equal(pl.code, 'auth', `pull: expected auth, got ${pl.code} (${pl.detail})`)
})
