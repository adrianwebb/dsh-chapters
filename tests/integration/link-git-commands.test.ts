/**
 * The human entry points on the GIT plane at the COMMAND surface: modes 1-3
 * of /chapters-link (view / local-path / https[+token]) and /chapters-status
 * rendering. The TreeDX command path is covered in link-treedx.test.ts; this
 * file closes the git-side branches that the 2026-09-23 coverage audit found
 * untested (commands.ts sat at 26.6% branch coverage — the argument parsing
 * and refusal texts are exactly what an operator fat-fingers).
 *
 * Pins a real bug found while writing it: /chapters-status printed the
 * `Provider:` line TWICE (two try/catch variants of the same push had both
 * landed in the file).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHostCommands } from '../../src/commands.ts'
import { startGitHttpServer, type GitHttpServer } from './http-git-server.ts'

type CmdDef = { name: string; handler: (inv: { agent: unknown; rawInput?: string }) => Promise<{ kind: string; text?: string }> }

let root: string
let home: string
let server: GitHttpServer | null = null
const defs = new Map<string, CmdDef>()
const projects = new Map<string, Record<string, unknown>>()

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'linkgit-home-'))
  process.env.DSH_HOME = home
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkgit-ws-'))
  server = await startGitHttpServer(path.join(root, 'poolserv'))
  const table = {
    get: (k: string) => projects.get(k),
    put: async (k: string, v: Record<string, unknown>) => { projects.set(k, v) },
    entries: () => projects.entries(),
    size: projects.size,
  }
  const domain = { table: () => table, close: async () => {} }
  const ctx = { get: (n: string) => (n === 'commands' ? { register: (def: CmdDef) => { defs.set(def.name, def); return () => {} } } : undefined) }
  // stub enrichment wiring — pins the /chapters-enrich VERB SURFACE (the ladder
  // itself is enrich-wire/enrich-queue territory); commands.ts had zero coverage
  // of model-set/clear/report before this file.
  let override: string | null = null
  const enrichStub = {
    runNow: async () => ({ processed: 1, remaining: 2 }),
    setModelOverride: async (v: string | null) => { override = v },
    modelOverride: () => override,
    statusLine: () => 'enrichment: manual, model conversation default',
    pendingCount: async () => 3,
  }
  registerHostCommands(ctx as never, domain as never, {
    artifactStoreRoot: '.dsh-chapters',
    harnessId: 'h-cmd',
    enrich: enrichStub as never,
    rules: async (cwd: string, raw: string) => ({ kind: 'success' as const, text: `rules@${cwd}: ${raw}` }),
  })
})
after(async () => {
  await server?.stop()
  delete process.env.DSH_HOME
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

const ws = (): string => path.join(root, 'workspace')
const agent = () => ({ session: { header: { cwd: ws() } } })
const link = (): CmdDef => defs.get('chapters-link')!
const status = (): CmdDef => defs.get('chapters-status')!

test('mode 1 — an unlinked workspace reads honestly: none linked, and what still works', async () => {
  const r = await link().handler({ agent: agent(), rawInput: '' })
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /Upstream: none/)
  assert.match(r.text ?? '', /knowledge-local/)
})

test('mode 2 — a local-path upstream links, syncs offline, and lands a real record', async () => {
  fs.mkdirSync(ws(), { recursive: true })
  const pool = path.join(root, 'pool.git')
  const r = await link().handler({ agent: agent(), rawInput: pool })
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text ?? '', /Linked to local upstream/)
  assert.match(r.text ?? '', /Sync: /)
  const rec = [...projects.values()].find((p) => p.cwd === ws())
  assert.ok(rec !== undefined, 'record stored under the workspace cwd')
  assert.equal(rec!.remote, pool)
  assert.equal(rec!.kind ?? 'git', 'git', 'local-path is the git provider')
})

test('/chapters-status renders each fact ONCE — Provider included (dup-line pin)', async () => {
  const r = await status().handler({ agent: agent() })
  assert.equal(r.kind, 'success', r.text)
  const t = r.text ?? ''
  assert.equal((t.match(/^Provider:/gm) ?? []).length, 1, 'exactly one Provider line — the regression this file caught')
  assert.match(t, /^Provider: git · /m, 'describe() carries the transport + remote')
  assert.match(t, /Sync: /)
})

test('mode 3 — an http URL without a token links when the host is loopback', async (t) => {
  if (server === null) { t.skip('git http-backend not available'); return }
  const url = server.serveRepo('kb-cmdlink')
  const r = await link().handler({ agent: agent(), rawInput: url })
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text ?? '', /no credentials: loopback upstream/)
  const rec = [...projects.values()].find((p) => p.remote === url)
  assert.ok(rec !== undefined)
})

test('mode 3 — a non-loopback https URL WITHOUT a token refuses with the credential policy', async () => {
  const r = await link().handler({ agent: agent(), rawInput: 'https://example.invalid/kb.git' })
  assert.equal(r.kind, 'error')
  assert.match(r.text ?? '', /credential is required/i)
  assert.ok(![...projects.values()].some((p) => String(p.remote).includes('example.invalid')), 'a refused link stores no record')
})

test('a target that is neither path, http(s), nor treedx+ falls back to the usage line', async () => {
  const r = await link().handler({ agent: agent(), rawInput: 'ssh://git@example.invalid/kb.git' })
  assert.equal(r.kind, 'error')
  assert.match(r.text ?? '', /usage: \/chapters-link/i)
})

// ------------------------------------------------ /chapters-enrich verb surface

const enrich = (): CmdDef => defs.get('chapters-enrich')!

test('/chapters-enrich run reports the batch in the run|pending shape', async () => {
  const r = await enrich().handler({ agent: agent(), rawInput: 'run' })
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /processed 1 chapter\(s\); 2 pending/)
})

test('/chapters-enrich model: set, view, clear — override round-trips', async () => {
  const set = await enrich().handler({ agent: agent(), rawInput: 'model testprov/testmodel' })
  assert.match(set.text ?? '', /set to testprov\/testmodel/)
  const view = await enrich().handler({ agent: agent(), rawInput: 'model' })
  assert.match(view.text ?? '', /testprov\/testmodel \(override\)/)
  const clr = await enrich().handler({ agent: agent(), rawInput: 'model clear' })
  assert.match(clr.text ?? '', /reset to the conversation default/)
  const view2 = await enrich().handler({ agent: agent(), rawInput: 'model' })
  assert.match(view2.text ?? '', /conversation default/)
})

test('/chapters-enrich report prints the status line plus pending count; junk verb yields usage', async () => {
  const r = await enrich().handler({ agent: agent(), rawInput: 'report' })
  assert.match(r.text ?? '', /enrichment: manual/)
  assert.match(r.text ?? '', /pending: 3 chapter\(s\)/)
  const u = await enrich().handler({ agent: agent(), rawInput: 'flarp' })
  assert.match(u.text ?? '', /usage: \/chapters-enrich/)
})

test('mode 1 on a LINKED workspace: provider line, branch, and pending view render', async () => {
  const r = await link().handler({ agent: agent(), rawInput: '' })
  assert.equal(r.kind, 'success')
  const t = r.text ?? ''
  assert.match(t, /Provider: git/)
  assert.match(t, /Upstream: /)
  assert.match(t, /Mirror:   \.dsh-knowledge/)
  assert.match(t, /branch main|rebuild/)
  assert.match(t, /Pending:  \d+ file\(s\)/)
})

test('/chapters-rule dispatches to the rules surface with cwd + raw args', async () => {
  const rule = defs.get('chapters-rule')
  assert.ok(rule !== undefined, 'config.rules present registers the command')
  const r = await rule.handler({ agent: agent(), rawInput: 'list --proposed' })
  assert.match(r.text ?? '', /rules@.*list --proposed/)
})
