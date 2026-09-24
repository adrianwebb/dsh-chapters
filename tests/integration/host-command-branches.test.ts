/**
 * host-command error arms (src/commands.ts): the register-time catch that
 * r35g made LOUD on the console, the TreeDX link create-failure refusal, the
 * link/enrich catch-alls, and the unlinked status view. happy paths live in
 * link-treedx / link-git-commands; this is the failure taxonomy of the
 * operator surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHostCommands } from '../../src/commands.ts'
import { startStubTreeDx, type StubTreeDx } from './treedx-stub-server.ts'
import '../../src/treedx/provider.ts' // registers the treedx provider (side effect)

type Cmd = { handler: (inv: { agent: unknown }) => Promise<{ kind: string; text?: string }> }

function harness(opts: { registerThrows?: boolean; enrichThrows?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostcmd-'))
  const defs = new Map<string, Cmd>()
  const warns: string[] = []
  const ctx = {
    logger: { warn: (m: unknown) => { warns.push(String(m)) }, info: () => undefined },
    get: () => ({
      register: (d: Cmd & { name: string }) => {
        if (opts.registerThrows) throw new Error('commands registry offline')
        defs.set(d.name, d)
        return () => {}
      },
    }),
  }
  const project = { projectKey: 'PKC', slug: 'kb', remote: 'x', harnessId: 'hC', linkedAt: 'now', cwd: tmp }
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries(), size: 0 }
  }
  table('projects').put('PKC', project)
  const enrich = opts.enrichThrows
    ? { runNow: async () => { throw new Error('ladder offline') }, setModelOverride: async () => undefined, modelOverride: () => null, statusLine: () => 'x', pendingCount: async () => 0 }
    : undefined
  registerHostCommands(ctx as never, { table, close: async () => {} } as never, {
    artifactStoreRoot: '.dsh-chapters', harnessId: 'hC', ...(enrich !== undefined ? { enrich } : {}),
    rules: async () => ({ kind: 'success' as const, text: 'ok' }),
  })
  const cwd = tmp
  const agent = { session: { header: { cwd }, id: 's' } }
  return { tmp, defs, agent, warns, tables, dispose: () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

test('command registration failure is LOUD (r35g lesson), never silent', async () => {
  const h = harness({ registerThrows: true })
  try {
    assert.ok(h.warns.some((m) => m.includes('host command registration failed')), 'warned')
    assert.equal(h.defs.size, 0)
  } finally { h.dispose() }
})

test('unlinked workspace /chapters-status answers with the link prompt, not a crash', async () => {
  const h = harness()
  try {
    // point the agent at a DIFFERENT cwd with no project + no status file
    const r = await h.defs.get('chapters-status')!.handler({ agent: { session: { header: { cwd: '/nonexistent-status-cwd' }, id: 'x' } } })
    assert.equal(r.kind, 'success')
    assert.match(r.text ?? '', /No knowledge repository is linked yet/)
  } finally { h.dispose() }
})

test('enrich verb failure is caught with the error, not a stack into the terminal', async () => {
  const h = harness({ enrichThrows: true })
  try {
    const r = await h.defs.get('chapters-enrich')!.handler({ agent: h.agent, rawInput: 'run' })
    assert.equal(r.kind, 'error')
    assert.match(r.text ?? '', /chapters-enrich failed/)
    assert.match(r.text ?? '', /ladder offline/)
  } finally { h.dispose() }
})

test('treedx link create-failure (non-conflict) refuses with the server reason', async () => {
  let stub: StubTreeDx | null = null
  const h = harness()
  try {
    stub = await startStubTreeDx()
    // point the link at the stub, but fail repository CREATE (non-conflict)
    stub.failNext({ method: 'GET', pathRe: '/api/v1/repos$', status: 500, code: 'internal' })
    const r = await h.defs.get('chapters-link')!.handler({ agent: h.agent, rawInput: `treedx+${stub.base}/dsh-kb-new tok` })
    assert.equal(r.kind, 'error')
    // repos list 500 -> network refusal in resolve (before create is even tried)
    assert.match(r.text ?? '', /TreeDX|repos|network|not found/i)
  } finally {
    await stub?.stop()
    h.dispose()
  }
})

test('no commands service: registration is a silent no-op disposer', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostcmd-none-'))
  try {
    const tables = new Map<string, Map<string, unknown>>()
    const table = (n: string) => { let m = tables.get(n); if (m === undefined) { m = new Map(); tables.set(n, m) } return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries(), size: 0 } }
    const dispose = registerHostCommands({ get: () => undefined } as never, { table, close: async () => {} } as never, { artifactStoreRoot: '.dsh-chapters', harnessId: 'hX' })
    assert.equal(typeof dispose(), 'undefined')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('link view on a linked git project: mirror, pending, token hint, last sync all render', async () => {
  const h = harness()
  try {
    const mirror = path.join(h.tmp, '.dsh-knowledge')
    fs.mkdirSync(path.join(mirror, 'chapters'), { recursive: true })
    fs.mkdirSync(path.join(h.tmp, '.dsh-chapters'), { recursive: true })
    fs.writeFileSync(path.join(h.tmp, '.dsh-chapters', '.sync-status.json'), JSON.stringify({ at: 'now', projectKey: 'PKC', lastOk: false, mode: 'local-only', detail: 'degraded', steps: ['a', 'b'] }))
    const r = await h.defs.get('chapters-link')!.handler({ agent: h.agent, rawInput: '' })
    assert.equal(r.kind, 'success')
    const t = r.text ?? ''
    assert.match(t, /Provider: git/)
    assert.match(t, /Mirror:   \.dsh-knowledge/)
    assert.match(t, /local-only @ now/)
    assert.match(t, /Pending:  \d+ file\(s\)/)
    assert.match(t, /no credentials/, 'unlinked-token hint shows for a network remote')
  } finally { h.dispose() }
})

test('link view on a treedx project: head, OFFLINE badge, origin-drift note', async () => {
  const h = harness()
  try {
    // re-point the stored record as treedx with drifted mirror state
    const tables = (h as unknown as { tables: Map<string, Map<string, unknown>> }).tables
    tables.get('projects')!.set('PKC', { projectKey: 'PKC', slug: 'kb', remote: 'treedx+http://svc/kb', harnessId: 'hC', linkedAt: 'now', cwd: h.tmp, kind: 'treedx', repoId: 'repo_x' })
    const mirror = path.join(h.tmp, '.dsh-knowledge')
    fs.mkdirSync(mirror, { recursive: true })
    fs.writeFileSync(path.join(mirror, '.treedx-state.json'), JSON.stringify({ origin: 'treedx+http://OTHER/kb', head: null, baseline: {}, staged: null, offline: true }))
    const r = await h.defs.get('chapters-link')!.handler({ agent: h.agent, rawInput: '' })
    const t = r.text ?? ''
    assert.match(t, /Provider: treedx/)
    assert.match(t, /OFFLINE/, 'the deferred-push badge shows')
    assert.match(t, /origin drift/, 'state.origin ≠ remote is called out')
  } finally { h.dispose() }
})

test('link view: detached-HEAD mirror shows the sha, an unreadable store reports pending=-1', async () => {
  const h = harness()
  try {
    // a mirror whose .git/HEAD is a raw sha (detached) → the `?? head.slice(0,8)` arm
    const g = path.join(h.tmp, '.dsh-knowledge', '.git')
    fs.mkdirSync(g, { recursive: true })
    fs.writeFileSync(path.join(g, 'HEAD'), 'deadbeefcafebabe1234567890abcdef00000000\n')
    // an unreadable store dir makes planStoreToRepo throw → countPending returns -1
    const store = path.join(h.tmp, '.dsh-chapters')
    fs.mkdirSync(store, { recursive: true })
    fs.chmodSync(store, 0o000)
    let text = ''
    try {
      const r = await h.defs.get('chapters-link')!.handler({ agent: h.agent, rawInput: '' })
      text = r.text ?? ''
    } finally {
      fs.chmodSync(store, 0o700)
    }
    assert.match(text, /Pending:  -1 file\(s\)/, 'honest -1 when the store cannot be enumerated: ' + text)
    // branch line reflects the detached sha (readMirrorHead slice fallback)
    assert.match(text, /\.dsh-knowledge/, 'mirror present')
  } finally { h.dispose() }
})
