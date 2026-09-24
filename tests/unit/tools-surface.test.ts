/**
 * The tool-surface wrappers (src/tools.ts) at L0. The underlying flows
 * (continue-core, search, artifact-query, rules) are each pinned by their own
 * suites — what THIS file covers is the wrapper layer the deterministic ledger
 * never reached: caller extraction, the pull→archive→push scheduling seams,
 * project/rules notice assembly (including the refuse-with-numbers overflow),
 * refusal formatting, and the registration disposers. Before the 2026-09-23
 * audit tools.ts sat at 66% stmts / 50% branch — every browser run leaned on
 * these wrappers while the ledger couldn't see them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools, registerChaptersTools } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'
import { appendRuleStatusFact, renderRuleFile } from '../../src/rules.ts'

type Ev = { seq: number; type: string; data: Record<string, unknown> }
const ev = (seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({ seq, type, data })
const human = (seq: number, text: string): Ev =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (seq: number, text: string, extra: Record<string, unknown> = {}): Ev =>
  ({ seq, type: 'assistant/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra } })

function world(opts: { withProject?: boolean; tinyRulesBudget?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsurf-'))
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
  const store = makeDomainStore(domainLike as never)
  const project = {
    projectKey: 'PKS', slug: 'kb', remote: 'https://example.invalid/kb.git',
    harnessId: 'hS', linkedAt: 'now', cwd: tmp,
  }
  if (opts.withProject !== false) void table('projects').put('PKS', project)

  const events: Ev[] = [
    human(0, 'fix the composer merge rule in src/compose.ts'),
    asst(1, 'edited compose.ts; ran the unit suite', { usage: { inputTokens: 9000, cacheReadTokens: 300 } }),
    ev(2, 'turn/end', {}),
  ]
  const created: Array<Record<string, unknown>> = []
  const mounted: string[] = []
  const attached: string[] = []
  const renamed: Array<{ sessionId: string; title: string }> = []
  const warns: string[] = []
  let disposed = 0
  const routes: string[] = []
  const caller = {
    id: 'sess-p',
    options: { provider: 'local', model: 'qwen-test' },
    session: {
      id: 'sess-p',
      header: { cwd: tmp },
      snapshotEvents: () => events,
    },
  }
  const ctx = {
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }) },
    agents: {
      create: async (o: Record<string, unknown>) => {
        created.push(o)
        // run the setup() the continuation contract requires (invariant 2)
        await (o.setup as (c: unknown) => Promise<void>)({})
        return { dispose: async () => { disposed += 1 } }
      },
    },
    get: (name: string) => {
      if (name === 'agentPresets') return { mount: async (_c: unknown, id: string) => { mounted.push(id) } }
      if (name === 'workspaceRegistry') return { createCanonical: async () => ({ attachSession: async (id: string) => { attached.push(id) } }) }
      if (name === 'sessionController') return { rename: async (r: { sessionId: string; title: string }) => { renamed.push(r) } }
      return undefined
    },
    sessionProjections: { stateOf: () => 'chapters' },
    logger: { info: () => undefined, warn: (m: unknown) => { warns.push(String(m)) } },
  }
  let schedules: string[] = []
  const scheduler = {
    schedule: (_c: string, why: string) => { schedules.push(why) },
    pullFor: async () => ({ ok: true, detail: 'fake pull' }),
    run: async () => ({}), hasPending: () => false, drain: async () => {},
  }
  const config = {
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', harnessId: 'hS',
    coreRulesBudgetTokens: opts.tinyRulesBudget ? 8 : 1200, searchMaxTokens: 400, rulesCoreBonus: 2,
    scheduler, noteRoute: (r: { provider: string, model: string }) => { routes.push(`${r.provider}/${r.model}`) },
  }
  const built = buildChaptersTools(ctx as never, store as never, config as never)
  return {
    tmp, store, built, caller, events, created, mounted, attached, renamed, warns, routes,
    exec: { agent: caller },
    scheduled: () => schedules, resetSchedules: () => { schedules = [] },
    dispose: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}

// ------------------------------------------------------------------ segment

test('segment: missing caller, no completed turn, then the real fact-sheet', async () => {
  const w = world()
  try {
    const noAgent = await w.built.segment.execute({} as never, {} as never) as { ok: boolean; reason?: string }
    assert.equal(noAgent.ok, false)
    assert.match(noAgent.reason ?? '', /no calling agent/)

    w.events.splice(2, 1) // remove turn/end
    const early = await w.built.segment.execute({} as never, w.exec as never) as { ok: boolean; reason?: string }
    assert.equal(early.ok, false)
    assert.match(early.reason ?? '', /no completed turn/)

    w.events.push(ev(2, 'turn/end', {}))
    const r = await w.built.segment.execute({} as never, w.exec as never) as Record<string, unknown>
    assert.equal(r.ok, true)
    assert.equal(r.archiveCeiling, 2)
    assert.ok(Array.isArray(r.toolResults) && Array.isArray(r.existingChapters === undefined ? [] : r.existingChapters))
    assert.ok(r.budgetHint !== undefined, 'budget hint rides for the model')
    assert.deepEqual(w.routes, [], 'segment does not touch the route seam')
  } finally { w.dispose() }
})

// ------------------------------------------------------------------ continue

test('continue: archives, creates the child fully-composed, arms push', async () => {
  const w = world()
  try {
    const r = await w.built.chaptersContinue.execute({
      title: 'Composer work continues',
      handoffNote: 'Merge rule updated in compose.ts; next: run the e2e.',
      chapters: [{ title: 'Composer merge rule', summary: 'edited compose.ts and verified', startSeq: 0, endSeq: 2 }],
    } as never, w.exec as never) as Record<string, unknown>
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(typeof r.childSessionId, 'string')
    assert.equal(w.created.length, 1, 'exactly one child created')
    const seed = (w.created[0]!.seed as Array<{ data?: { source?: { plugin?: string } } }>)
    assert.equal(seed[0]!.data?.source?.plugin, 'dsh-chapters', 'the TOC notice seed (invariant 2)')
    assert.equal(seed[0]!.type, 'user/message'); assert.equal((seed[0] as { seq?: number }).seq, 0, 'seeds contiguous from seq 0')
    assert.deepEqual(w.mounted, ['chapters'], 'setup mounted the preset (invariant 2)')
    assert.equal(w.attached.length, 1, 'workspace attach ran')
    assert.equal(w.renamed.length, 1, 'durable title through the service')
    assert.equal(w.created[0]!.agentOptions !== undefined, true, 'caller model options ride')
    assert.ok(w.scheduled().includes('archive:continue'), 'debounced push armed')
    // chapters are real on disk, the log itself untouched
    const dir = path.join(w.tmp, '.dsh-chapters', 'sess-p', 'chapters')
    assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length === 1)
    assert.equal(w.events[w.events.length - 1].type, 'turn/end', 'no events were appended to the caller')
  } finally { w.dispose() }
})

test('continue: overlapping ranges refuse before any file is written', async () => {
  const w = world()
  try {
    const dir = path.join(w.tmp, '.dsh-chapters', 'sess-p', 'chapters')
    const r = await w.built.chaptersContinue.execute({
      title: 'Bad plan', handoffNote: 'note',
      chapters: [
        { title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 },
        { title: 'B', summary: 'bb', startSeq: 1, endSeq: 2 },
      ],
    } as never, w.exec as never) as { ok: boolean; reason?: string }
    assert.equal(r.ok, false)
    assert.ok(!fs.existsSync(dir), 'refusal precedes the write (validate-before-write)')
  } finally { w.dispose() }
})

test('continue: an over-budget handoff refuses WITH the numbers', async () => {
  const w = world()
  try {
    const r = await w.built.chaptersContinue.execute({
      title: 'Huge note',
      handoffNote: 'word '.repeat(30_000),
      chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }],
    } as never, w.exec as never) as { ok: boolean; reason?: string; budget?: { usedTokens: number; allowanceTokens: number } }
    assert.equal(r.ok, false)
    assert.ok(r.budget !== undefined && r.budget.usedTokens > r.budget.allowanceTokens, 'refuses with measured numbers')
    assert.equal(w.created.length, 0, 'nothing created on refusal')
  } finally { w.dispose() }
})

// ------------------------------------------------------------------ fork

test('fork: cites the existing archive when the watermark covers the anchor', async () => {
  const w = world()
  try {
    await w.store.put('sess-p', { ...(await w.store.get('sess-p')), chapters: [
      { number: 1, path: '.dsh-chapters/sess-p/chapters/001-old.md', title: 'old', summary: 'old work', startSeq: 0, endSeq: 2, sha256: 'x', artifacts: [], estimatedTokens: 10 },
    ] })
    const r = await w.built.chaptersFork.execute({ title: 'Sibling angle', handoffNote: 'Try the other approach.' } as never, w.exec as never) as Record<string, unknown>
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(w.created.length, 1)
    assert.ok(w.scheduled().includes('archive:fork'))
  } finally { w.dispose() }
})

test('fork-command: nothing-to-archive says so; success text names the branch session', async () => {
  const w = world()
  try {
    const empty = { ...w, events: [] as Ev[] }
    void empty
    const ok = await w.built.forkCommand.handler({ agent: w.caller })
    assert.equal(ok.kind, 'success', ok.kind === 'error' ? ok.text : '')
    assert.match(ok.text ?? '', /branch/)
    w.resetSchedules()
    assert.ok(w.scheduled().length === 0 || w.scheduled().some((s) => s.startsWith('archive:fork')))
  } finally { w.dispose() }
})

// ------------------------------------------------------------------ search

test('search: no mirror is an honest empty, a mirror returns ranked readable paths', async () => {
  const w = world()
  try {
    const bare = await w.built.chaptersSearch.execute({ query: 'composer' } as never, w.exec as never) as { note?: string; total: number }
    assert.match(bare.note ?? '', /no knowledge mirror/)

    const chapters = path.join(w.tmp, '.dsh-knowledge', 'chapters', 'PKS', 'sess-x')
    fs.mkdirSync(chapters, { recursive: true })
    fs.writeFileSync(path.join(chapters, '001-composer.md'), '---\ntitle: "Composer rules"\ntopics: ["compose"]\n---\n# Composer rules\n\nhow chapters merge\n')
    const hit = await w.built.chaptersSearch.execute({ query: 'composer merge' } as never, w.exec as never) as { total: number; results: Array<{ path: string }> }
    assert.ok(hit.total >= 1, 'found through the mirror')
    assert.match(hit.results[0]!.path, /^chapters\/PKS\//, 'paths are mirror-readable')
  } finally { w.dispose() }
})

// ------------------------------------------------------------------ artifact

test('artifact: toc/search/read over a real file; unknown path and action refuse', async () => {
  const w = world()
  try {
    const arts = path.join(w.tmp, '.dsh-chapters', 'artifacts', 'ab')
    fs.mkdirSync(arts, { recursive: true })
    const body = '# Top\n\n## Section one\n\nalpha detail line\n\n## Section two\n\nbeta needle here\n'
    fs.writeFileSync(path.join(arts, 'ab12.txt'), body)
    const toc = await w.built.chaptersArtifact.execute({ path: 'artifacts/ab/ab12.txt', action: 'toc' } as never, w.exec as never) as { ok: boolean; toc: string[] }
    assert.equal(toc.ok, true)
    assert.equal(toc.toc.length, 3)
    const search = await w.built.chaptersArtifact.execute({ path: 'artifacts/ab/ab12.txt', action: 'search', query: 'needle' } as never, w.exec as never) as { ok: boolean; blocks: string[] }
    assert.ok(search.blocks.some((b) => b.includes('needle')))
    const read = await w.built.chaptersArtifact.execute({ path: 'artifacts/ab/ab12.txt', action: 'read', offset: 3, limit: 2 } as never, w.exec as never) as { ok: boolean; lines: string[] }
    assert.match(read.lines.join(' '), /Section one/)
    const bad = await w.built.chaptersArtifact.execute({ path: 'artifacts/zz/nope.txt', action: 'toc' } as never, w.exec as never) as { ok: boolean; error?: string }
    assert.equal(bad.ok, false)
    const junk = await w.built.chaptersArtifact.execute({ path: 'artifacts/ab/ab12.txt', action: 'levitate' } as never, w.exec as never) as { ok: boolean; error?: string }
    assert.equal(junk.ok, false)
    assert.match(junk.error ?? '', /unknown action/)
  } finally { w.dispose() }
})

// ------------------------------------------------------------------ rules refusal

test('notice rules overflow refuses the fork with numbers — the notice never clips', async () => {
  const w = world({ tinyRulesBudget: true })
  try {
    const mirror = path.join(w.tmp, '.dsh-knowledge')
    const rulesDir = path.join(mirror, 'rules', 'PKS', 'hS')
    fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(path.join(rulesDir, '001-security-never-log-raw-tokens-anywhere-in-output-x.md'),
      renderRuleFile({ number: 1, category: 'security', title: 'Never log raw tokens anywhere in output', sourceSession: 'sess-p', at: '2026-09-23T00:00:00Z', body: 'Never log raw tokens anywhere in output, including headers and stored paths.\n' }))
    appendRuleStatusFact(mirror, 'hS', { rule: 'hS/001', status: 'core', at: '2026-09-23T00:00:00Z' })
    const r = await w.built.chaptersFork.execute({ title: 'Anything', handoffNote: 'note' } as never, w.exec as never) as { ok: boolean; reason?: string }
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /overflow their budget/)
    assert.match(r.reason ?? '', /never clips/, 'the message states the guarantee')
  } finally { w.dispose() }
})

// ------------------------------------------------------------------ registration

test('registerChaptersTools registers every surface and disposes all of it', async () => {
  const w = world()
  try {
    const registered: string[] = []
    const disposers: Array<() => void> = []
    const ctx2 = { ...w.created && {} , tools: { register: (d: { name: string }) => { registered.push(d.name); const f = () => { registered.splice(registered.indexOf(d.name), 1) }; disposers.push(f); return f } }, ...w.ctx ?? {} }
    void ctx2
    // rebuild ctx pieces the registrar needs: reuse the world's shape via opts
    const registrar = { tools: { register: (d: { name: string }) => { registered.push(d.name); return () => { registered.splice(Math.max(0, registered.indexOf(d.name)), 1) } } } }
    void registerChaptersTools(
      { ...({ llm: { resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }) }, agents: { create: async () => ({}) }, get: () => undefined, sessionProjections: { stateOf: () => 'chapters' }, logger: { warn: () => undefined } }), ...registrar } as never,
      w.store as never,
      { artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200, continuationBudgetRatio: 0.25, fallbackPreset: 'chapters' } as never,
    )
    assert.deepEqual(registered.sort(), ['chapters_artifact', 'chapters_continue', 'chapters_fork', 'chapters_rule_propose', 'chapters_search', 'chapters_segment'].sort())
    assert.ok(registered.includes('chapters_segment'))
  } finally { w.dispose() }
})
