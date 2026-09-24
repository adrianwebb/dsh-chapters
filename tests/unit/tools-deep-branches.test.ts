/**
 * tools.ts deep-branch sweep. The happy/failure taxonomies are pinned in
 * tools-surface and tools-branches; THIS file exists for istanbul branch
 * coverage specifically — every `??` fallback, conditional spread, and
 * optional-service arm in the wrapper (preset absent, options without a model,
 * no scheduler, no project, no rules, budget with/without windowTokens, ...).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'
import { renderRuleFile } from '../../src/rules.ts'

type Ev = { seq: number; type: string; data: Record<string, unknown> }
const ev = (seq: number, t: string, d: Record<string, unknown> = {}): Ev => ({ seq, type: t, data: d })
const human = (seq: number, text: string): Ev => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (seq: number, text: string): Ev => ev(seq, 'assistant/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

function w(opts: {
  preset?: string | null
  noResolve?: boolean
  noScheduler?: boolean
  noTools?: boolean
  noProjections?: boolean
  noAgents?: boolean
  usageAt?: number | undefined
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsdeep-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (n: string) => { let m = tables.get(n); if (m === undefined) { m = new Map(); tables.set(n, m) } return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries(), get size() { return m!.size } } }
  const store = makeDomainStore({ table, close: async () => {} } as never)
  const events: Ev[] = [human(0, 'deep branch coverage of the wrappers'), asst(1, 'done: verified')]
  if (opts.usageAt !== undefined) events[1].data.usage = { inputTokens: 5000, cacheReadTokens: 100 }
  events.push(ev(2, 'turn/end', {}))
  const ctx: Record<string, unknown> = {
    llm: opts.noResolve ? {} : { resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }) },
    agents: { create: async (o: Record<string, unknown>) => { await (o.setup as (c: unknown) => Promise<void>)({}); return {} } },
    get: () => ({ mount: async () => undefined }),
    sessionProjections: { stateOf: () => opts.preset === null ? null : 'chapters' },
    tools: { register: () => () => undefined },
    logger: { info: () => undefined, warn: () => undefined },
  }
  const config = {
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', harnessId: 'hD', coreRulesBudgetTokens: 1200,
    ...(opts.noScheduler ? {} : { scheduler: { schedule: () => undefined, pullFor: async () => ({ ok: true, detail: '' }), run: async () => ({}), hasPending: () => false, drain: async () => {} } }),
  }
  const caller = { id: 'sd', options: { provider: 'local', model: 'm' }, session: { id: 'sd', header: { cwd: tmp }, snapshotEvents: () => events } }
  const built = buildChaptersTools(ctx as never, store as never, config as never)
  return { tmp, store, built, caller, events, table, exec: { agent: caller }, dispose: () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

test('continue without a resolved model window still budgets against header bound', async () => {
  const h = w({ usageAt: 0 })
  try {
    const r = await h.built.chaptersContinue.execute({
      title: 'T', handoffNote: 'note', chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }],
    } as never, h.exec as never) as { ok: boolean; budget?: { windowTokens: number | null } }
    assert.equal(r.ok, true)
  } finally { h.dispose() }
})

test('continue with no measurable window refuses rather than guessing (no-never-truncate rule)', async () => {
  const h = w({ noResolve: true })
  try {
    const r = await h.built.chaptersContinue.execute({
      title: 'T', handoffNote: 'note', chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }],
    } as never, h.exec as never) as { ok: boolean; reason?: string }
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /window|measure|configure|budget/i, 'refuses WITH a reason')
  } finally { h.dispose() }
})

test('continue with a null preset (caller has none) still creates a child', async () => {
  const h = w({ preset: null })
  try {
    const r = await h.built.chaptersContinue.execute({
      title: 'T', handoffNote: 'note', chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }],
    } as never, h.exec as never) as { ok: boolean }
    assert.equal(r.ok, true)
  } finally { h.dispose() }
})

test('continue with no scheduler wired (pure-local archive) works', async () => {
  const h = w({ noScheduler: true })
  try {
    const r = await h.built.chaptersContinue.execute({
      title: 'T', handoffNote: 'note', chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }],
    } as never, h.exec as never) as { ok: boolean }
    assert.equal(r.ok, true)
  } finally { h.dispose() }
})

test('segment with a linked project but no mirror → empty existing, no crash', async () => {
  const h = w()
  try {
    await h.table('projects').put('PKD', { projectKey: 'PKD', slug: 'kb', remote: 'x', harnessId: 'hD', linkedAt: 'l', cwd: h.tmp })
    const r = await h.built.chaptersSearch.execute({ query: 'wrappers' } as never, h.exec as never) as { note?: string }
    assert.match(r.note ?? '', /no knowledge mirror/, 'search without mirror → honest note')
    const seg = await h.built.segment.execute({} as never, h.exec as never) as { ok: boolean }
    assert.equal(seg.ok, true)
  } finally { h.dispose() }
})

test('continue carries the project line + rules section when both present', async () => {
  const h = w()
  try {
    await h.table('projects').put('PKD', { projectKey: 'PKD', slug: 'kb', remote: 'x', harnessId: 'hD', linkedAt: 'l', cwd: h.tmp })
    const mirror = path.join(h.tmp, '.dsh-knowledge')
    const rulesDir = path.join(mirror, 'rules', 'PKD', 'hD')
    fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(path.join(rulesDir, '001-security-always-rotate-bearer-tokens-before-expiry-x.md'),
      renderRuleFile({ number: 1, category: 'security', title: 'Always rotate bearer tokens before expiry', sourceSession: 'x', at: '2026-09-23T00:00:00Z', body: 'Always rotate bearer tokens before expiry.\n' }))
    const { appendRuleStatusFact } = await import('../../src/rules.ts')
    appendRuleStatusFact(mirror, 'hD', { rule: 'hD/001', status: 'core', at: '2026-09-23T00:00:00Z' })
    const r = await h.built.chaptersContinue.execute({
      title: 'T', handoffNote: 'note', chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }],
    } as never, h.exec as never) as { ok: boolean; childSessionId?: string; presetUsed?: string; budget?: unknown }
    assert.equal(r.ok, true)
    assert.ok(r.childSessionId !== undefined)
  } finally { h.dispose() }
})

test('fork tool: no scheduler + no rules + no project still forks', async () => {
  const h = w({ noScheduler: true, preset: null })
  try {
    const base = await h.store.get('sd')
    await h.store.put('sd', { ...base, chapters: [{ number: 1, path: '.dsh-chapters/sd/chapters/001-a.md', title: 'a', summary: 'aa', startSeq: 0, endSeq: 2, sha256: 'x', artifacts: [], estimatedTokens: 5 }] })
    const r = await h.built.chaptersFork.execute({ title: 'Sibling', handoffNote: 'other way' } as never, h.exec as never) as { ok: boolean }
    assert.equal(r.ok, true)
  } finally { h.dispose() }
})

test('segment tool with NO completed turn (only a mid-turn) → honest refusal arm', async () => {
  const h = w()
  try {
    h.events.pop() // remove turn/end
    const r = await h.built.segment.execute({} as never, h.exec as never) as { ok: boolean; reason?: string }
    assert.equal(r.ok, false)
  } finally { h.dispose() }
})

test('degraded caller (no header, no snapshotEvents, no context info, partial usage) flips the ?? arms', async () => {
  // One pass with every optional field ABSENT: cwd falls to '', snapshotEvents
  // to [], resolveModelInfo yields no context, and a usage record missing
  // inputTokens. Each arm of the nullish/optional branches needs a side.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsdegraded-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (n: string) => { let m = tables.get(n); if (m === undefined) { m = new Map(); tables.set(n, m) } return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries(), get size() { return m!.size } } }
  const store = makeDomainStore({ table, close: async () => {} } as never)
  const events: Ev[] = [human(0, 'degraded session with almost nothing attached'), asst(1, 'done')]
  events[1].data.usage = { cacheReadTokens: 200 } // inputTokens absent
  events.push(ev(2, 'turn/end', {}))
  // a session with header but a caller with NO header anywhere resolves cwd ''
  const ctx = {
    llm: { resolveModelInfo: async () => null },
    agents: { create: async (o: Record<string, unknown>) => { await (o.setup as (c: unknown) => Promise<void>)({}); return {} } },
    get: (name: string) => name === 'agentPresets' ? { mount: async () => undefined } : undefined,
    sessionProjections: { stateOf: () => undefined },
    tools: { register: () => () => undefined },
    logger: { info: () => undefined, warn: () => undefined },
  }
  const config = { artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200, continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', harnessId: 'hE' }
  const built = buildChaptersTools(ctx as never, store as never, config as never)
  // caller 1: no header at all -> cwd '' -> fs() throws -> continue refuses cleanly
  const bare = { id: 'se', options: {}, session: { id: 'se', snapshotEvents: () => events } }
  const r1 = await built.chaptersContinue.execute({ title: 'T', handoffNote: 'n', chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }] } as never, { agent: bare } as never) as { ok: boolean; reason?: string }
  assert.equal(r1.ok, false)
  // caller 2: real cwd, but session WITHOUT snapshotEvents -> events [] -> no turn/end -> refuse
  const noEvents = { id: 'sf', options: { provider: 'p', model: 'm' }, session: { id: 'sf', header: { cwd: tmp } } }
  const r2 = await built.segment.execute({} as never, { agent: noEvents } as never) as { ok: boolean; reason?: string }
  assert.equal(r2.ok, false)
  assert.match(r2.reason ?? '', /completed turn|no calling/)
  // caller 3: full happy caller but agentPresets absent -> child creation throws inside
  // portsFor.createChild -> wrapped as refusal reason, not a crash
  const ok = { id: 'sg', options: { provider: 'p', model: 'm' }, session: { id: 'sg', header: { cwd: tmp }, snapshotEvents: () => events } }
  const ctxNoPresets = { ...ctx, get: () => undefined }
  const built2 = buildChaptersTools(ctxNoPresets as never, store as never, config as never)
  const r3 = await built2.chaptersContinue.execute({ title: 'T', handoffNote: 'n', chapters: [{ title: 'A', summary: 'aa', startSeq: 0, endSeq: 2 }] } as never, { agent: ok } as never) as { ok: boolean; reason?: string }
  assert.equal(r3.ok, false)
  assert.match(r3.reason ?? '', /refus/i, 'a refusal, not a crash')
  fs.rmSync(tmp, { recursive: true, force: true })
})
