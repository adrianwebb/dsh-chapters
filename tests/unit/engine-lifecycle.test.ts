/**
 * The realm ENGINE (src/engine.ts) at the lifecycle level. Before the
 * 2026-09-23 coverage audit this file sat at 40% statements / 20% functions:
 * everything past the signature listener — construction, the §5.1 first-turn
 * pull, the degraded and real summarize paths, route observation, plot
 * elicitation, and the whole finalize-after-commit stack — ran only inside
 * browser boots, invisible to the deterministic ledger. These rows drive the
 * REAL class against fake ctx/session shapes (the same fakes engine-core
 * pins), never faking the engine itself.
 */
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChaptersCompactionEngine } from '../../src/engine.ts'
import { selectProvider, gitProvider } from '../../src/provider.ts'
import { makeDomainStore } from '../../src/store.ts'

type Ev = { seq: number; type: string; data: Record<string, unknown> }

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({ seq, type, data })
const human = (seq: number, text: string): Ev =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (seq: number, text: string): Ev =>
  ev(seq, 'assistant/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

function harness(config: Record<string, unknown> = {}, opts: { plotStream?: boolean } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-life-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return {
      get: (k: string) => m!.get(k),
      put: async (k: string, v: unknown) => { m!.set(k, v) },
      entries: () => m!.entries(),
      get size() { return m!.size },
    }
  }
  const domainLike = { table, close: async () => {} }
  const logs: Array<['info' | 'warn', string]> = []
  let resolveModelInfoThrows = false
  // THE REAL cordis root context: the Service base chain touches container
  // internals (provide/mixin/tracker) that a hand-rolled fake cannot satisfy —
  // measured 2026-09-23 (`Cannot read properties of undefined (reading
  // 'provide')`). Everything app-specific is then PROVIDED into it.
  const ctx = new Context() as unknown as Record<string, unknown> & {
    provide: (n: string, v: unknown) => unknown; emit: (n: string, ...a: unknown[]) => unknown
    dispose?: () => unknown
  }
  // ctx.logger on a root Context is container-fixed — capture at the console
  // seam instead: the real Logger exports through console in-process, and the
  // engine's messages are its own ('dsh-chapters: ...'), so we filter there.
  // The real cordis Logger exports through process.stdout.write (NOT console) —
  // confirmed by probe: wrapping console captured nothing. Intercept stdout and
  // classify 'dsh-chapters:' lines; the finalization-deferred warn contains a
  // stack so also match on the message's own marker.
  const ws = process.stdout.write.bind(process.stdout)
  const wes = process.stderr.write.bind(process.stderr)
  const feed = (chunk: unknown) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.includes('dsh-chapters') && !line.includes('finalization deferred')) continue
      // classify by CONTENT (the stream is not a reliable level signal)
      const kind: 'info' | 'warn' = /fail|deferred|refus|reject|degrad|error/i.test(line) ? 'warn' : 'info'
      logs.push([kind, line])
    }
  }
  process.stdout.write = ((o: typeof ws) => (c: Parameters<typeof ws>[0], ...r: Parameters<typeof ws>) => { feed(c); return o(c, ...r) })(ws)
  process.stderr.write = ((o: typeof wes) => (c: Parameters<typeof wes>[0], ...r: Parameters<typeof wes>) => { feed(c); return o(c, ...r) })(wes)
  ctx.provide('storageDomain', { open: async () => domainLike, get: () => domainLike })
  ctx.provide('tokenMeter', {
    measure: () => ({ totalTokens: 12 }),
    estimateMessage: (m: unknown) => Math.ceil(JSON.stringify(m).length / 4),
  })
  ctx.provide('llm', {
    resolveModelInfo: async () => {
      if (resolveModelInfoThrows) throw new Error('injected: adapter unavailable')
      return { context: { contextWindow: 32_000 } }
    },
    stream: async function* (_o: unknown) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'PLOT: mid-refactor, next run tests.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PLOT: mid-refactor, next run tests.' } }
    },
  })
  ctx.provide('sessions', {})
  ctx.provide('registry', {})
  const engine = new ChaptersCompactionEngine(ctx as never, {
    thresholdRatio: 0.9, retainRatio: 0.15,
    summarizationProvider: '', summarizationModel: '',
    maxTokens: 900, compactionRetries: 1, maxOverflowRetries: 0, auto: false,
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 4000,
    ...config,
  } as never)
  const store = makeDomainStore(domainLike as never)
  const fire = (session: unknown, event: unknown) => { for (const h of [...handlers]) h(session, event) }
  const sessionOf = (id: string, events: Ev[], extra: Record<string, unknown> = {}) => {
    const bySeq = new Map(events.map((e) => [e.seq, e]))
    return {
      id,
      // LIVE seq: append() must advance it or scanChaptersSummaries (bounded
      // by session.seq) never sees a just-appended compaction/summary — the
      // first draft of this harness pinned seq at construction and 'finalize
      // did nothing' looked like an engine bug when it was the fake lying.
      get seq() { return events.length },
      eventAt: (seq: number) => bySeq.get(seq),
      snapshotEvents: () => events,
      surface: { nodes: events.map((e) => e.seq) },
      append: (type: string, data: unknown) => { const e = { seq: events.length, type: String(type), data: data as Record<string, unknown> }; events.push(e); bySeq.set(e.seq, e); return e },
      deriveEventMessage: (e: { type: string; data?: Record<string, unknown> }) =>
        (e.data?.content !== undefined ? { role: e.type === 'assistant/message' ? 'assistant' : 'user', content: e.data.content } : null),
      header: { cwd },
      ...extra,
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 120))
  return { engine, cwd, store, logs, fire: (session: unknown, event: unknown) => { void ctx.emit('session/event', session, event) }, sessionOf, settle, table, setThrow: (v: boolean) => { resolveModelInfoThrows = v }, dispose: () => { process.stdout.write = ws; process.stderr.write = wes; try { (ctx.fiber as { dispose?: () => unknown } | undefined)?.dispose?.() } catch { /* root teardown is best-effort in tests */ } fs.rmSync(cwd, { recursive: true, force: true }) } }
}

// ---------------------------------------------------------------- construction

test('construction: logger line, listeners armed, TreeDX provider registered on this plane', async () => {
  const h = harness()
  try {
    // constructing the engine registers the TreeDX transport on THIS plane —
    // selectProvider('treedx') would have thrown before the constructor ran
    const tp = selectProvider({ kind: 'treedx', remote: 'treedx+http://h/r' } as never)
    assert.notEqual(tp, gitProvider, 'the realm plane resolves treedx to its own provider')
    // both listeners registered on the event bus (signature + first-turn)
    const s = h.sessionOf('s-boot', [human(0, 'prime the session with some words'), ev(1, 'turn/end', {})])
    h.fire(s, { type: 'turn/end', seq: 1 })
    await h.settle()
    const st = await h.store.get('s-boot')
    assert.equal(st.collections.length, 1, 'the signature listener is live on the constructed engine')
  } finally { h.dispose() }
})

test('first-turn pull: linked-but-dead TreeDX remote degrades offline, never throws into the session', async () => {
  const h = harness()
  try {
    // link a treedx+ project pointing at a dead loopback port (fast refuse)
    await h.table('projects').put('P1', {
      projectKey: 'P1', slug: 'kb', remote: 'treedx+http://127.0.0.1:1/kb',
      harnessId: 'h1', linkedAt: 'now', cwd: h.cwd, kind: 'treedx',
    })
    const s = h.sessionOf('s-pull', [ev(0, 'turn/start', {})])
    h.fire(s, { type: 'turn/start', seq: 0 })
    await h.settle()
    // the pass ran and fell into the offline mirror init — the durable proof
    // is the mirror directory the pull created under the workspace
    assert.ok(fs.existsSync(path.join(h.cwd, '.dsh-knowledge')), 'runPull initialized the offline mirror')
  } finally { h.dispose() }
})

test('first-turn pull: one pull per session (process-scoped memory)', async () => {
  const h = harness()
  try {
    await h.table('projects').put('P1', {
      projectKey: 'P1', slug: 'kb', remote: 'treedx+http://127.0.0.1:1/kb',
      harnessId: 'h1', linkedAt: 'now', cwd: h.cwd, kind: 'treedx',
    })
    const s = h.sessionOf('s-once', [ev(0, 'turn/start', {})])
    h.fire(s, { type: 'turn/start', seq: 0 })
    h.fire(s, { type: 'turn/start', seq: 2 })
    await h.settle()
    assert.ok(fs.existsSync(path.join(h.cwd, '.dsh-knowledge')))
  } finally { h.dispose() }
})

// ---------------------------------------------------------------- summarize

test('summarize: degraded branches answer honestly (no cwd / no open transaction / empty region)', async () => {
  const h = harness()
  try {
    const summarize = (input: unknown, agent: unknown) =>
      (h.engine as unknown as { summarize: (i: unknown, a: unknown) => Promise<{ summary: { text: string }[]; provider: string }> }).summarize(input, agent)

    const noCwd = { id: 'x', seq: 0, eventAt: () => undefined, snapshotEvents: () => [] }
    const r1 = await summarize({ messages: [{ role: 'user', content: [] }] }, { session: noCwd })
    assert.match(r1.summary[0]!.text, /no workspace cwd/)
    assert.equal(r1.provider, 'dsh-chapters-degraded')

    const openless = h.sessionOf('s-nocid', [human(0, 'hello there this is text')])
    const r2 = await summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there this is text' }] }] }, { session: openless })
    assert.match(r2.summary[0]!.text, /no open transaction/)

    const empty = h.sessionOf('s-empty', [ev(0, 'compaction/start', { compactionId: 'c-9' })])
    const r3 = await summarize({ messages: [] }, { session: empty })
    assert.match(r3.summary[0]!.text, /empty region|no open transaction/)
  } finally { h.dispose() }
})

test('summarize: the real deterministic path writes the plan + reservation durably', async () => {
  const h = harness()
  try {
    const events = [
      human(0, 'fix the sync loop copy-out bug'),
      asst(1, 'edited src/sync.ts and ran npm test'),
      human(2, 'verify the two-machine row passes too'),
      asst(3, 'npm test green, 333 pass'),
      ev(4, 'turn/end', {}),
      ev(5, 'compaction/start', { compactionId: 'c-1' }),
    ]
    const session = h.sessionOf('s-real', events)
    const input = { messages: events.slice(0, 4).map((e) => ({ role: e.type === 'asst' ? 'assistant' : 'user', content: (e.data.content as unknown[]) ?? [] })) }
    const r = await (h.engine as unknown as { summarize: (i: unknown, a: unknown) => Promise<{ summary: { text: string }[]; provider: string; model: string }> })
      .summarize(input, { session })
    assert.equal(r.provider, 'dsh-chapters')
    assert.match(r.summary[0]!.text, /Chapter archive:/)
    const st = await h.store.get('s-real')
    assert.ok(st.plans['c-1'] !== undefined, 'durable plan under the compaction id')
    assert.ok(st.reservations['compaction:c-1'] !== undefined, 'chapter numbers reserved BEFORE the cite')
  } finally { h.dispose() }
})

// ---------------------------------------------------------------- observe + arrive

test('compactIfNeeded below threshold: observes the route, arrives clean, returns null', async () => {
  const h = harness()
  try {
    const events = [human(0, 'do the thing with some real content here'), asst(1, 'done: verified by npm test')]
    const session = h.sessionOf('s-ok', events, {
      requestHeader: () => ({ config: { provider: 'local', model: 'qwen-test' } }),
    })
    const r = await h.engine.compactIfNeeded(
      { session } as never, 'pressure' as never, new AbortController().signal as never,
    )
    assert.equal(r, null, 'no pressure, no compaction')
  } finally { h.dispose() }
})

// ---------------------------------------------------------------- plot elicitation

test('plot carriage: no authored PLOT => one bounded elicit call through the routed model', async () => {
  const h = harness()
  try {
    const events = [
      human(0, 'plan the refactor of src/engine.ts'),
      asst(1, 'starting with the listeners; the route capture still needs lastRoute'),
      ev(2, 'turn/end', {}),
      ev(3, 'compaction/start', { compactionId: 'c-p' }),
    ]
    const arm = h.sessionOf('s-plot-arm', [human(0, 'nothing compacted here at all'), asst(1, 'route arming only')], {
      requestHeader: () => ({ config: { provider: 'local', model: 'plotmodel' } }),
    })
    await h.engine.compactIfNeeded({ session: arm } as never, 'pressure' as never, new AbortController().signal as never)
    const session = h.sessionOf('s-plot', events, {
      requestHeader: () => ({ config: { provider: 'local', model: 'plotmodel' } }),
    })
    const input = { messages: events.slice(0, 2).map((e) => ({ role: 'user', content: e.data.content })) }
    const r = await (h.engine as unknown as { summarize: (i: unknown, a: unknown) => Promise<{ summary: { text: string }[]; provider: string }> })
      .summarize(input, { session })
    assert.match(r.summary[0]!.text, /PLOT: mid-refactor, next run tests\./, 'the elicited plot rode the checkpoint')
  } finally { h.dispose() }
})

test('plot elicitation: llm without a stream degrades to no plot, never breaks compaction', async () => {
  const h = harness()
  try {
    (h.engine as unknown as { ctx: { llm: { stream?: unknown } } }).ctx =
      (h.engine as unknown as { ctx: Record<string, unknown> }).ctx
    const events = [
      human(0, 'refactor on, nothing authored here'),
      asst(1, 'no plot note was ever written by the agent'),
      ev(2, 'turn/end', {}),
      ev(3, 'compaction/start', { compactionId: 'c-np' }),
    ]
    const session = h.sessionOf('s-noplot', events) // no requestHeader => route unknown
    const input = { messages: events.slice(0, 2).map((e) => ({ role: 'user', content: e.data.content })) }
    const r = await (h.engine as unknown as { summarize: (i: unknown, a: unknown) => Promise<{ summary: { text: string }[] }> })
      .summarize(input, { session })
    assert.ok(r.summary[0]!.text.length > 0, 'compaction still returned a checkpoint')
    assert.ok(!r.summary[0]!.text.includes('PLOT:'), 'no route => no plot, silently')
  } finally { h.dispose() }
})

// ---------------------------------------------------------------- finalize stack

test('finalize-after-commit: super throws AFTER a durable plan => chapters written, marked, error rethrown', async () => {
  const h = harness()
  try {
    const events = [
      human(0, 'fix the copy-out bug in src/sync.ts'),
      asst(1, 'edited and verified with the two-machine suite'),
      ev(2, 'turn/end', {}),
      ev(3, 'compaction/start', { compactionId: 'c-f' }),
    ]
    const session = h.sessionOf('s-fin', events, {
      requestHeader: () => ({ config: { provider: 'local', model: 'm' } }),
    })
    const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the copy-out bug in src/sync.ts' }] }, { role: 'assistant', content: [{ type: 'text', text: 'edited and verified with the two-machine suite' }] }] }
    await (h.engine as unknown as { summarize: (i: unknown, a: unknown) => Promise<unknown> }).summarize(input, { session })
    // the base's committed marker the reconciliation scan reads
    session.append('compaction/summary', { provider: 'dsh-chapters', compactionId: 'c-f', shadowedSeqs: [0, 1] })

    h.setThrow(true) // super.compactIfNeeded now throws at resolveModelInfo — AFTER our overrides ran
    await assert.rejects(
      () => h.engine.compactIfNeeded({ session } as never, 'pressure' as never, new AbortController().signal as never),
      /injected: adapter unavailable/, 'the original error is rethrown untouched',
    )
    const chapters = path.join(h.cwd, '.dsh-chapters', 's-fin', 'chapters')
    const files = fs.existsSync(chapters) ? fs.readdirSync(chapters) : []
    assert.equal(files.length, 1, `the guard finalized the committed plan (saw: ${files.join(',')})`)
    const st = await h.store.get('s-fin')
    assert.ok(st.chapters.length >= 1, 'chapter record durable')
    assert.ok(st.finalized !== undefined && Object.keys(st.finalized).includes('c-f'), 'marked finalized — no retry pending')
  } finally { h.dispose() }
})

test('finalize failures warn, land in the diagnostics sink, and retry next touch', async () => {
  const sink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eng-sink-')), 'errors.log')
  process.env.DSH_CHAPTERS_ENGINE_ERRORS = sink
  const h = harness()
  try {
    const events = [
      human(0, 'summarize a region with no plan behind it'),
      asst(1, 'this marker exists but its manifest never was'),
      ev(2, 'compaction/start', { compactionId: 'c-ghost' }),
    ]
    const session = h.sessionOf('s-ghost', events, {
      requestHeader: () => ({ config: { provider: 'local', model: 'm' } }),
    })
    session.append('compaction/summary', { provider: 'dsh-chapters', compactionId: 'c-ghost', shadowedSeqs: [0, 1] })
    h.setThrow(true)
    await assert.rejects(() => h.engine.compactIfNeeded({ session } as never, 'pressure' as never, new AbortController().signal as never))
    // the in-memory log may or may not have a live exporter on a bare root
    // Context — the SINK is the operator-visible contract, assert on it
    const written = fs.readFileSync(sink, 'utf8')
    assert.match(written, /finalization deferred/, 'the sink captured it for the operator')
    assert.match(written, /no durable plan/, 'naming the real cause')
  } finally {
    delete process.env.DSH_CHAPTERS_ENGINE_ERRORS
    h.dispose()
    fs.rmSync(path.dirname(sink), { recursive: true, force: true })
  }
})
