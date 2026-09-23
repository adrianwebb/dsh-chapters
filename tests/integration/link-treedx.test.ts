/**
 * /chapters-link's TreeDX mode (record §2.1 + §15 amendment) at the COMMAND
 * surface: the handler resolves-or-creates the managed repository over the
 * stub service, stores the token in the DSH home (0600) — never the project —
 * writes the project record with kind 'treedx' + the catalog repoId, and runs
 * one immediate sync pass. This is the human entry point into the transport
 * tested verb-by-verb in treedx-provider.test.ts.
 *
 * dsh-home-paths reads $DSH_HOME at CALL time (verified in its lib), so
 * redirecting HOME below keeps credentials out of the real ~/.dsh.
 *
 * Lesson (measured the slow way): the stub server MUST be stopped in after()
 * — a live listener + the undici keep-alive sockets left by the link pass
 * keep this file's root promise unsettled ("Promise resolution is still
 * pending but the event loop has already resolved", node 24) and the runner
 * hangs the whole suite. Every stub-owning file stops its server.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStubTreeDx, type StubTreeDx } from './treedx-stub-server.ts'
import { registerHostCommands } from '../../src/commands.ts'
import { projectKeyForTarget, parseKnowledgeRemote } from '../../src/repo.ts'
import { tokenPath } from '../../src/sync.ts'
import '../../src/treedx/provider.ts' // registers the default treedx provider (registry side effect)

type CmdDef = { name: string; handler: (inv: { agent: unknown; rawInput?: string }) => Promise<{ kind: string; text?: string }> }

let stub: StubTreeDx
let root: string
let home: string
let defs: Map<string, CmdDef>
let projects: Map<string, Record<string, unknown>>

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'treedx-link-home-'))
  process.env.DSH_HOME = home
  stub = await startStubTreeDx()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'treedx-link-ws-'))
  defs = new Map()
  projects = new Map()
  const table = {
    get: (k: string) => projects.get(k),
    put: async (k: string, v: Record<string, unknown>) => { projects.set(k, v) },
    entries: () => projects.entries(),
    size: projects.size,
  }
  const domain = { table: () => table, close: async () => {} }
  const ctx = { get: (n: string) => (n === 'commands' ? { register: (def: CmdDef) => { defs.set(def.name, def); return () => {} } } : undefined) }
  registerHostCommands(ctx as never, domain as never, {
    artifactStoreRoot: '.dsh-chapters',
    harnessId: 'h-link',
    // no scheduler: syncNow runs one immediate pass through the registry-resolved provider
  })
})
after(async () => {
  await stub.stop()
  delete process.env.DSH_HOME
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

const agent = () => ({ session: { header: { cwd: root } } })

test('link treedx+ resolves-or-creates the repo, records kind/repoId, stores the token 0600', async () => {
  const link = defs.get('chapters-link')
  assert.ok(link !== undefined, 'chapters-link registered')
  const r = await link.handler({ agent: agent(), rawInput: `treedx+${stub.base}/dsh-kb-cmd ${stub.token}` })
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text ?? '', /Linked to TreeDX/)
  assert.match(r.text ?? '', /Created the managed repository/)

  const key = projectKeyForTarget(parseKnowledgeRemote(`treedx+${stub.base}/dsh-kb-cmd`))
  const rec = projects.get(key)
  assert.ok(rec !== undefined, 'project row stored under the §2.3-derived key')
  assert.equal(rec.kind, 'treedx')
  assert.equal(typeof rec.repoId, 'string')
  assert.ok(String(rec.repoId).startsWith('repo_'))

  const tp = tokenPath(key)
  assert.ok(fs.existsSync(tp), 'credential stored under the DSH home, not the workspace')
  assert.equal((fs.statSync(tp).mode & 0o777).toString(8), '600')
  assert.ok(!fs.existsSync(path.join(root, '.git-auth')), 'nothing token-shaped in the project tree')

  // the immediate pass reached the service: a synced status line is in the text
  assert.match(r.text ?? '', /Sync: synced/, r.text)
})

test('re-link is idempotent (resolves the existing repo, no create note)', async () => {
  const link = defs.get('chapters-link')!
  const r = await link.handler({ agent: agent(), rawInput: `treedx+${stub.base}/dsh-kb-cmd ${stub.token}` })
  assert.equal(r.kind, 'success', r.text)
  assert.doesNotMatch(r.text ?? '', /Created the managed repository/)
})

test('missing token refuses with the minting hint; bad form refuses too', async () => {
  const link = defs.get('chapters-link')!
  const noTok = await link.handler({ agent: agent(), rawInput: `treedx+${stub.base}/dsh-kb-other` })
  assert.equal(noTok.kind, 'error')
  assert.match(noTok.text ?? '', /always needs a bearer token/)
  const badForm = await link.handler({ agent: agent(), rawInput: 'treedx+not-an-url some-token' })
  assert.equal(badForm.kind, 'error')
})

test('the no-args view shows the provider, head, and origin for a treedx link', async () => {
  const link = defs.get('chapters-link')!
  const r = await link.handler({ agent: agent() })
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /Provider: treedx/)
  assert.match(r.text ?? '', /treedx\+http:\/\/127\.0\.0\.1/)
  assert.match(r.text ?? '', /head [0-9a-f]{10}|head empty repo|head not cloned/)
})

test('/chapters-status carries the provider line', async () => {
  const status = defs.get('chapters-status')!
  const r = await status.handler({ agent: agent() })
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /Provider: treedx · repo_/, r.text)
})
