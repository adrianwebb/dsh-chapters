/**
 * The REAL-TreeDX journey — the §13 two-machine exit criterion against an
 * actual service booted by `scripts/treedx-local.sh` (compose in dev,
 * dev-auth). Gating rule (its own bug class, caught 2026-09-21): the skip
 * decision is made ONCE AT LOAD from CONFIGURATION PRESENCE
 * (TREEDX_LIVE_URL/TREEDX_LIVE_TOKEN env, or var/treedx-dev.env written by
 * `scripts/treedx-local.sh token`). Configured-but-unreachable FAILS loudly
 * in `before` — the first version flipped a `live` flag inside `before()`
 * while `{ skip }` had already captured the load-time value, so the tests
 * could never un-skip. A configured test that silently skips is a test that
 * can never witness anything; configuration means intent to run.
 *
 * Beyond the stub journey it pins the live-only shapes measured against the
 * container: born-with head + `.treedxkeep` exclusion, repoId addressing,
 * refs `target`, `contentBase64` blobs, and lease release through commit.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTreedxProvider } from '../../src/treedx/provider.ts'
import { runSync, DEFAULT_CLONE_DIR, type ProjectRecord } from '../../src/sync.ts'
import { searchKnowledge } from '../../src/search.ts'

const here = new URL('.', import.meta.url).pathname
const ENV_FILE = path.join(here, '..', '..', 'var', 'treedx-dev.env')
let BASE = process.env.TREEDX_LIVE_URL ?? ''
let TOKEN = process.env.TREEDX_LIVE_TOKEN ?? ''
if ((BASE === '' || TOKEN === '') && fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^(TREEDX_LIVE_(?:URL|TOKEN))=(.*)$/.exec(line.trim())
    if (m?.[1] === 'TREEDX_LIVE_URL' && BASE === '') BASE = m[2] ?? ''
    if (m?.[1] === 'TREEDX_LIVE_TOKEN' && TOKEN === '') TOKEN = m[2] ?? ''
  }
}

const configured = BASE !== '' && TOKEN !== ''
const SKIP = configured ? false : 'not configured — run scripts/treedx-local.sh up && scripts/treedx-local.sh token (docs/development.md § TreeDX dev loop)'
let root = ''
const REPO = 'dsh-kb-live'
const RUN = Date.now().toString(36) // unique file names per run; the pool accumulates

const chapter = (title: string, body: string, topics: string[]): string =>
  `---\ntitle: "${title}"\ntopics: [${topics.map((t) => JSON.stringify(t)).join(', ')}]\n---\n# ${title}\n\n${body}\n`
const writeFile = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const mk = () => createTreedxProvider({ fetchTimeoutMs: 10000, workspaceTtlSeconds: 300 })
const remote = () => ({ url: `treedx+${BASE}/${REPO}`, token: TOKEN })
const sync = (harness: string) => {
  const cwd = path.join(root, harness)
  const project: ProjectRecord = {
    projectKey: 'LIVE', slug: REPO, remote: remote().url, harnessId: harness, linkedAt: 'now', cwd, kind: 'treedx',
  }
  return runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project, token: TOKEN,
    provider: mk(), force: true,
  })
}

before(async () => {
  if (!configured) return // skipped at load; nothing to witness
  // Configured ⇒ intent to run. Unreachable is a FAILURE, never a skip.
  let healthy = false
  try {
    const health = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(3000) })
    healthy = health.ok
  } catch { healthy = false }
  assert.ok(healthy, `TreeDX is configured (${BASE}) but unreachable — boot it with scripts/treedx-local.sh up, or unset TREEDX_LIVE_URL`)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'treedx-live-'))
  const created = await fetch(`${BASE}/api/v1/repos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryName: REPO, source: { type: 'empty' }, placement: { mode: 'local' } }),
  }).catch(() => null)
  if (created !== null && !created.ok && created.status !== 409) {
    throw new Error(`live setup: repo create failed (${created.status}): ${(await created.text()).slice(0, 200)}`)
  }
})
after(() => { if (root !== '') fs.rmSync(root, { recursive: true, force: true }) })

test('live: managed repo clones cleanly (born head, .treedxkeep excluded)', { skip: SKIP }, async () => {
  const dir = path.join(root, 'probe', DEFAULT_CLONE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const r = await mk().ensureClone(dir, remote())
  assert.ok(r.ok, r.detail)
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.treedx-state.json'), 'utf8')) as { head: string | null }
  assert.equal(typeof state.head, 'string', 'live repos are BORN with refs/heads/main (measured)')
  assert.ok(state.head.length > 0)
  assert.ok(!fs.existsSync(path.join(dir, '.treedxkeep')), 'the service bookkeeping file never enters the mirror/baseline')
})

test('live: publish → second machine clones → search finds it (exit criterion)', { skip: SKIP }, async () => {
  const file = `001-live-loop-${RUN}.md`
  const cwdA = path.join(root, 'machine-a')
  // the query is RUN-UNIQUE on purpose: the live pool accumulates identical
  // titles across runs, ties sort by path, and searchKnowledge returns only
  // the budget-shown prefix — a generic query would rank this run's newest
  // file below its own history and crowd it out
  writeFile(path.join(cwdA, '.dsh-chapters', 'liveRootA', 'chapters', file), chapter('live loop', 'two machines over the real api', ['live', 'treedx', `r${RUN}`]))
  const a = await sync('machine-a')
  assert.ok(a.ok, `${a.detail} | ${a.steps.join('; ')}`)
  assert.equal(a.mode, 'synced')

  const cwdB = path.join(root, 'machine-b')
  fs.mkdirSync(cwdB, { recursive: true })
  const b = await sync('machine-b')
  assert.ok(b.ok, b.detail)
  assert.ok(fs.existsSync(path.join(cwdB, DEFAULT_CLONE_DIR, 'chapters', 'LIVE', 'liveRootA', file)))
  const hits = searchKnowledge(path.join(cwdB, DEFAULT_CLONE_DIR), `r${RUN}`, 400, { projectKey: 'LIVE' })
  assert.ok(hits.results.some((r) => r.path.includes(file)), hits.line)
})

test('live: bad token degrades to local-only with an auth-shaped detail, never a throw', { skip: SKIP }, async () => {
  const cwd = path.join(root, 'machine-c')
  writeFile(path.join(cwd, '.dsh-chapters', 'liveRootC', 'chapters', `001-c-${RUN}.md`), chapter('c', 'auth degradation', ['auth']))
  const project: ProjectRecord = {
    projectKey: 'LIVE', slug: REPO, remote: remote().url, harnessId: 'machine-c', linkedAt: 'now', cwd, kind: 'treedx',
  }
  const r = await runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project, token: 'bogus-token',
    provider: mk(), force: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.mode, 'local-only')
  assert.match(r.detail, /auth|re-link/i, r.detail)
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_CLONE_DIR, 'chapters', 'LIVE', 'liveRootC', `001-c-${RUN}.md`)), 'the offline mirror still materializes local work')
})

test('live: second publish advances the head (lease released by commit, re-acquirable)', { skip: SKIP }, async () => {
  const file = `002-live-followup-${RUN}.md`
  const cwdA = path.join(root, 'machine-a')
  writeFile(path.join(cwdA, '.dsh-chapters', 'liveRootA', 'chapters', file), chapter('live followup', 'second commit, same machine', ['followup']))
  const a2 = await sync('machine-a')
  assert.ok(a2.ok, `${a2.detail} | ${a2.steps.join('; ')}`)
  const b = await sync('machine-b')
  assert.ok(b.ok, b.detail)
  assert.ok(fs.existsSync(path.join(root, 'machine-b', DEFAULT_CLONE_DIR, 'chapters', 'LIVE', 'liveRootA', file)),
    'B saw the second commit through the provider')
})

test('live: binary artifact round-trips through the blob path', { skip: SKIP }, async () => {
  const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80])
  const cwdA = path.join(root, 'machine-a')
  // planStoreToRepo maps <store>/<session>/artifacts/<rel> → artifacts/<projectKey>/<rel>
  fs.mkdirSync(path.join(cwdA, '.dsh-chapters', 'liveRootA', 'artifacts', 'lb'), { recursive: true })
  fs.writeFileSync(path.join(cwdA, '.dsh-chapters', 'liveRootA', 'artifacts', 'lb', `blob-${RUN}.bin`), bin)
  writeFile(path.join(cwdA, '.dsh-chapters', 'liveRootA', 'chapters', `000-anchor-${RUN}.md`), chapter('anchor', 'binary ride-along', ['bin']))
  const a = await sync('machine-a')
  assert.ok(a.ok, `${a.detail} | ${a.steps.join('; ')}`)
  const cwdB = path.join(root, 'machine-b')
  const b = await sync('machine-b')
  assert.ok(b.ok, b.detail)
  const seen = fs.readFileSync(path.join(cwdB, DEFAULT_CLONE_DIR, 'artifacts', 'LIVE', 'lb', `blob-${RUN}.bin`))
  assert.deepEqual(seen, bin, 'binary bytes round-trip via blobs (contentBase64)')
})
