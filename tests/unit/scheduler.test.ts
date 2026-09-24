/**
 * createSyncScheduler (§5.2 debounce) and makeCollectionsReader — the wiring
 * between archive events and the sync loop. Injected timers make the
 * coalescing window deterministic; the fake driver counts pushes so
 * "N schedules → one push" is arithmetic, not vibes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSyncScheduler, makeCollectionsReader, projectForCwd, type ProjectRecord } from '../../src/sync.ts'
import { makeFakeRemote, makeFakeDriver } from '../support/fake-driver.ts'

const project = (cwd: string): ProjectRecord =>
  ({ projectKey: 'K', slug: 's', remote: 'https://remote.example/x.git', harnessId: 'h', linkedAt: 'now', cwd })

function harness(opts: { project?: ProjectRecord | undefined } = {}) {
  const remote = makeFakeRemote()
  let pushes = 0
  const inner = makeFakeDriver(remote)
  const driver = { ...inner, push: async (...a: Parameters<typeof inner.push>) => { pushes += 1; return inner.push(...a) } }
  const timers: Array<() => void> = []
  const sched = createSyncScheduler({
    storeRoot: '.dsh-chapters',
    debounceMs: 1000,
    resolveProject: () => opts.project ?? undefined,
    tokenFor: () => undefined,
    collectionsFor: () => [],
    setTimer: (fn) => { timers.push(fn); return { cancel() { /* overwritten by fire */ } } },
    provider: driver,
  })
  return { sched, remote, timers, pushCount: () => pushes }
}

test('schedules coalesce: any number of events, one push when the window fires', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  fs.mkdirSync(path.join(cwd, '.dsh-chapters'))
  fs.writeFileSync(path.join(cwd, '.dsh-chapters', 'x.txt'), 'pending')
  const h = harness({ project: project(cwd) })
  h.sched.schedule(cwd, 'a'); h.sched.schedule(cwd, 'b'); h.sched.schedule(cwd, 'c')
  assert.equal(h.sched.hasPending(cwd), true)
  await h.timers[0]!()
  await h.sched.drain()
  assert.equal(h.pushCount(), 1, 'three schedules, one push')
  assert.equal(h.sched.hasPending(cwd), false)
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('run() is immediate and cancels the pending debounce', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  fs.mkdirSync(path.join(cwd, '.dsh-chapters'))
  const h = harness({ project: project(cwd) })
  h.sched.schedule(cwd, 'archive')
  const r = await h.sched.run(cwd, 'link')
  assert.equal(r.ok, true, r.detail)
  assert.equal(r.mode, 'synced')
  assert.equal(h.sched.hasPending(cwd), false)
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('no linked project ⇒ honest local-only refusal, no network attempts', async () => {
  const h = harness({ project: undefined })
  const r = await h.sched.run('/nowhere', 'archive')
  assert.equal(r.ok, false)
  assert.equal(r.mode, 'local-only')
  assert.match(r.detail, /no knowledge project/)
})

test('projectForCwd: deepest match wins; siblings and prefixes never cross', () => {
  const recs: Array<[string, ProjectRecord]> = [
    ['a', project('/work')], ['b', project('/work/mono/app')],
  ]
  assert.equal(projectForCwd(recs, '/work/mono/app/pkg')?.cwd, '/work/mono/app')
  assert.equal(projectForCwd(recs, '/work/other')?.cwd, '/work')
  assert.equal(projectForCwd(recs, '/workspace'), undefined, '/work is not a prefix of /workspace')
})

test('makeCollectionsReader publishes only this workspace\'s session trees', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  fs.mkdirSync(path.join(cwd, '.dsh-chapters', 'tree-here'), { recursive: true })
  const coll = { seqs: [0, 1], paths: ['src/x.ts'], commands: [], terms: ['x'], size: 10, by: 'deterministic' as const }
  const data: Array<[string, { rootSession: string; collections: unknown[] }]> = [
    ['tree-here', { rootSession: 'tree-here', collections: [coll] }],
    ['tree-elsewhere', { rootSession: 'tree-elsewhere', collections: [coll] }],
  ]
  const out = makeCollectionsReader(data[Symbol.iterator].bind(data) as never, '.dsh-chapters')(cwd)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.sessionId, 'tree-here')
  assert.equal(out[0]!.lines.length, 1)
  fs.rmSync(cwd, { recursive: true, force: true })
})

// ------------------------------------------- pullFor / in-flight / notify rows

test('pullFor with no linked project refuses honestly', async () => {
  const h = harness()
  const r = await h.sched.pullFor('/nowhere')
  assert.equal(r.ok, false)
  assert.match(r.detail, /no linked project/)
})

test('pullFor awaits an in-flight pass instead of racing a second pull', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  fs.mkdirSync(path.join(cwd, '.dsh-chapters'))
  fs.writeFileSync(path.join(cwd, '.dsh-chapters', 'x.txt'), 'pending')
  const remote = makeFakeRemote()
  const inner = makeFakeDriver(remote)
  let releasePush = () => {}
  const gate = new Promise<void>((res) => { releasePush = res })
  const slow = { ...inner, async push(...a: Parameters<typeof inner.push>) { await gate; return inner.push(...a) } }
  const sched = createSyncScheduler({
    storeRoot: '.dsh-chapters', debounceMs: 10_000,
    resolveProject: () => project(cwd), tokenFor: () => undefined, collectionsFor: () => [],
    provider: slow,
  })
  const inFlight = sched.run(cwd, 'archive') // never resolves until the gate opens
  await new Promise((r) => setImmediate(r))
  setTimeout(releasePush, 25) // the pass must finish from a timer — pullFor's await would otherwise deadlock the test
  const pull = await sched.pullFor(cwd) // must await the pass, not double-pull
  assert.ok(pull.ok, pull.detail)
  assert.match(pull.detail, /awaited in-flight/)
  await inFlight
  await sched.drain()
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('a throwing onSyncDone never breaks the sync pass', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  fs.mkdirSync(path.join(cwd, '.dsh-chapters'))
  const remote = makeFakeRemote()
  const sched = createSyncScheduler({
    storeRoot: '.dsh-chapters', debounceMs: 1000,
    resolveProject: () => project(cwd), tokenFor: () => undefined, collectionsFor: () => [],
    provider: makeFakeDriver(remote),
    onSyncDone: () => { throw new Error('consumer exploded') },
  })
  const r = await sched.run(cwd, 'link')
  assert.ok(r.ok, `the pass completed despite the notify failure: ${r.detail}`)
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('runPull (pre-fork refresh, §5.1): clones+ffs, and offline falls back to a local mirror — never pushes', async () => {
  const { runPull } = await import('../../src/sync.ts')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runpull-'))
  fs.mkdirSync(path.join(cwd, '.dsh-chapters'))
  const remote = makeFakeRemote()
  remote.files.set('chapters/K/sess/001-shared.md', '# shared\n')
  const p = project(cwd)
  const ok = await runPull({ cwd, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: p, provider: makeFakeDriver(remote) })
  assert.ok(ok.ok, ok.detail)
  assert.ok(fs.existsSync(path.join(cwd, '.dsh-knowledge', 'chapters', 'K', 'sess', '001-shared.md')), 'remote content materialized')
  // an offline twin: push NEVER attempted on the pull path
  const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'runpull-off-'))
  fs.mkdirSync(path.join(cwd2, '.dsh-chapters'))
  fs.writeFileSync(path.join(cwd2, '.dsh-chapters', 'pend.md'), 'pending work')
  let pushes = 0
  const inner = makeFakeDriver(makeFakeRemote(), { unreachable: { clone: true, fetch: true } })
  const counting = { ...inner, async push(...a: Parameters<typeof inner.push>) { pushes += 1; return inner.push(...a) } }
  const off = await runPull({ cwd: cwd2, storeRoot: '.dsh-chapters', cloneDir: '.dsh-knowledge', project: project(cwd2), provider: counting })
  assert.ok(!off.ok, 'unreachable clone reports false')
  assert.match(off.detail, /offline mirror present/, 'and says the local mirror exists')
  assert.equal(pushes, 0, 'the pull path never pushes')
  fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(cwd2, { recursive: true, force: true })
})
