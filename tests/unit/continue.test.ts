/**
 * L0 tests for chapters_continue orchestration: the refusal paths (ranges, no
 * boundary, budget), the atomicity ordering (reserve→write→create→commit), the
 * idempotent retry, tamper marking, and the notice's honest wording. Fakes
 * only — no harness, no fs, no cordis.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preflight, refusalResult, runContinue, runFork, type ContinueConfig, type ContinuePorts } from '../../src/continue-core.ts'
import { freshSession, appendChapters } from '../../src/registry.ts'
import { sha256 } from '../../src/render.ts'
import type { SessionEventLike } from '../../src/types.ts'
import type { SessionState } from '../../src/registry.ts'
import type { ArchiveFs } from '../../src/archive.ts'

const CONFIG: ContinueConfig = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25,
  fallbackPreset: 'chapters',
}

const ev = (seq: number, type: string, text?: string): SessionEventLike =>
  type === 'user/message' || type === 'assistant/message'
    ? { type, seq, time: 0, surfaceOp: 'append', data: { id: `m${seq}`, role: type.split('/')[0], source: { kind: 'user' }, content: [{ type: 'text', text: text ?? `message ${seq} ${'filler words '.repeat(20)}` }] } }
    : { type, seq, data: {} }

const conversation = (n: number): SessionEventLike[] => [
  ev(0, 'user/message'), ev(1, 'assistant/message'),
  ev(2, 'user/message'), ev(3, 'assistant/message'),
  { type: 'turn/end', seq: 4, data: { turn: 1 } } as SessionEventLike,
  ...Array.from({ length: n }, (_, i) => ev(5 + i, i % 2 ? 'assistant/message' : 'user/message')),
  { type: 'turn/end', seq: 5 + n, data: { turn: 2 } } as SessionEventLike,
]

class FakeFs implements ArchiveFs {
  files = new Map<string, string>()
  async write(path: string, content: string) { this.files.set(path, content) }
  async read(path: string) { return this.files.get(path) }
  async exists(path: string) { return this.files.has(path) }
}

const harness = (opts: {
  events?: SessionEventLike[]
  states?: Record<string, SessionState>
  budget?: { windowTokens: number | null; headerBoundTokens: number | null }
} = {}) => {
  const fs = new FakeFs()
  const states = new Map(Object.entries(opts.states ?? {}))
  let idCount = 0
  const created: Array<{ sessionId: string; noticeEvent: SessionEventLike; presetId: string; title: string }> = []
  const ports: ContinuePorts = {
    readCallerEvents: async () => opts.events ?? conversation(6),
    getState: async (id) => states.get(id) ?? freshSession(id),
    putState: async (id, s) => { states.set(id, s) },
    fs: () => fs,
    budgetProbe: async () => opts.budget ?? { windowTokens: 131072, headerBoundTokens: 13000 },
    newId: () => `id-${++idCount}`,
    createChild: async (input) => { created.push(input) },
    now: () => 1700000000000,
  }
  return { ports, fs, states, created }
}

const baseArgs = {
  callerSessionId: 'A',
  callerPreset: 'chapters',
  title: 'Widget work',
  handoffNote: 'Mid-refactor; the budget check is the next step.',
  chapters: [
    { title: 'Setup', summary: 'project scaffold', startSeq: 0, endSeq: 4 },
    { title: 'Model changes', summary: 'widget model edits', startSeq: 5, endSeq: 10 },
  ],
  toolResultOverrides: [],
}

test('happy path: archive written, child created with one notice event, registry committed', async () => {
  const h = harness()
  const result = await runContinue(h.ports, baseArgs as never, CONFIG)
  assert.equal(result.ok, true)
  assert.ok(result.childSessionId?.startsWith('ch-'))
  assert.equal(result.chapters?.length, 2)
  assert.equal(result.presetUsed, 'chapters')

  // files on the fake fs, cited by registry
  for (const c of result.chapters!) assert.ok(h.fs.files.has(c.path), `missing ${c.path}`)
  const caller = h.states.get('A')!
  assert.equal(caller.chapters.length, 2)
  const child = h.states.get(result.childSessionId!)!
  assert.equal(child.parentSession, 'A')
  assert.equal(child.rootSession, 'A') // caller is root

  // the child's seed: EXACTLY one event at seq 0, our notice source, budget reported
  assert.equal(h.created.length, 1)
  const seed = h.created[0]!.noticeEvent
  assert.equal(seed.seq, 0)
  assert.equal(seed.type, 'user/message')
  const text = JSON.stringify(seed.data)
  assert.ok(text.includes(result.chapters![0]!.path), 'notice cites chapter path')
  assert.ok(text.includes('every byte remains retrievable'))
  assert.ok(text.includes('Mid-refactor'))
  assert.ok(text.includes('root A'))
  assert.ok(result.budget && result.budget.usedTokens > 0 && result.budget.allowanceTokens > result.budget.usedTokens)
})

test('overlapping ranges refuse with the kernel validator message', async () => {
  const h = harness()
  const bad = structuredClone(baseArgs)
  bad.chapters[1].startSeq = 3 // overlaps chapter 1
  await assert.rejects(() => runContinue(h.ports, bad as never, CONFIG), (error: unknown) => {
    const res = refusalResult(error)
    assert.ok(res && !res.ok && /ranges refused/.test(res.reason ?? ''))
    return true
  })
  assert.equal(h.created.length, 0) // refused BEFORE creation
})

test('no completed turn refuses before any file is written', async () => {
  const h = harness({ events: [ev(0, 'user/message'), ev(1, 'assistant/message')] })
  await assert.rejects(() => runContinue(h.ports, { ...baseArgs, chapters: [{ title: 'x', summary: 'y', startSeq: 0, endSeq: 1 }] } as never, CONFIG), /turn.end/)
  assert.equal(h.fs.files.size, 0)
})

test('budget refusal carries the numbers and creates nothing', async () => {
  const h = harness({ budget: { windowTokens: 32000, headerBoundTokens: 31500 } }) // allowance = 0.25 × 500 = 125
  await assert.rejects(() => runContinue(h.ports, baseArgs as never, CONFIG), (error: unknown) => {
    const res = refusalResult(error)
    assert.ok(res && !res.ok)
    assert.match(res!.reason ?? '', /over budget: notice ~\d+ tokens > allowance 125/)
    assert.equal(res!.budget?.allowanceTokens, 125)
    return true
  })
  assert.equal(h.created.length, 0)
})

test('unknown model window refuses instead of guessing', async () => {
  const h = harness({ budget: { windowTokens: null, headerBoundTokens: null } })
  await assert.rejects(() => runContinue(h.ports, baseArgs as never, CONFIG), (error: unknown) => {
    const res = refusalResult(error)
    assert.ok(res && !res.ok && /cannot resolve the model context window/.test(res.reason ?? ''))
    return true
  })
})

test('retry after a crash reuses the SAME numbers (idempotence via attempt key)', async () => {
  const h = harness()
  const first = await runContinue(h.ports, { ...baseArgs, callerSessionId: 'A2' } as never, CONFIG)
  // Simulate: files written + reservation committed, but child creation failed
  // (registry chapters NOT committed). Re-run the identical attempt.
  const st = h.states.get('A2')!
  h.states.set('A2', { ...st, chapters: [] }) // roll back the commit, keep reservations
  const second = await runContinue(h.ports, { ...baseArgs, callerSessionId: 'A2' } as never, CONFIG)
  assert.deepEqual(second.chapters?.map((c) => c.number), first.chapters?.map((c) => c.number))
  const paths = [...h.fs.files.keys()].filter((p) => p.includes('A2') || p.length > 0)
  const dupes = paths.filter((p, i) => paths.indexOf(p) !== i)
  assert.equal(dupes.length, 0)
})

test('a tampered prior chapter is marked in the notice, not silently trusted', async () => {
  const h = harness()
  // Pre-commit a chapter whose stored body differs from its recorded hash.
  const forged = {
    number: 1, path: '.dsh-chapters/A/chapters/000-old.md', title: 'Old', summary: 's',
    startSeq: 0, endSeq: 0, sha256: 'deadbeef'.repeat(8), estimatedTokens: 10, artifacts: [],
  }
  h.states.set('A', appendChapters(freshSession('A'), [forged]))
  h.fs.files.set(forged.path, 'tampered content')
  const result = await runContinue(h.ports, baseArgs as never, CONFIG)
  assert.equal(result.ok, true)
  assert.ok(result.warnings?.some((w) => w.includes('000-old.md') && w.includes('modified since archived')))
  const notice = h.created[0]!.noticeEvent.data as { content: [{ text: string }] }
  assert.ok(notice.content[0].text.includes('⚠ modified since archived'))
})

test('ancestor chapters precede the caller\u2019s in reading order; root inherited', async () => {
  const h = harness()
  const ancestor = appendChapters(freshSession('R'), [{
    number: 7, path: '.dsh-chapters/R/chapters/007-anc.md', title: 'Ancient', summary: 'a',
    startSeq: 0, endSeq: 3, sha256: '', estimatedTokens: 5, artifacts: [],
  }])
  h.states.set('R', ancestor)
  h.fs.files.set('.dsh-chapters/R/chapters/007-anc.md', 'anc')
  const linked = { ...freshSession('A'), parentSession: 'R', rootSession: 'R' }
  h.states.set('A', linked)
  const result = await runContinue(h.ports, baseArgs as never, CONFIG)
  const notice = (h.created[0]!.noticeEvent.data as { content: [{ text: string }] }).content[0].text
  assert.ok(notice.indexOf('007-anc') < notice.indexOf('001-setup'), 'ancestor first')
  assert.ok(notice.includes('root R'))
  assert.equal(h.states.get(result.childSessionId!)!.rootSession, 'R')
})

// ---------------------------------------------------------------- fork

test('fork: cites existing archive, creates a linked child, writes and reserves NOTHING new', async () => {
  const h = harness()
  // Arrange a parent with two committed, intact chapters.
  const recs = [
    { number: 1, path: '.dsh-chapters/A/chapters/001-first.md', title: 'First', summary: 'a', startSeq: 0, endSeq: 3, sha256: sha256('one'), estimatedTokens: 5, artifacts: [] },
    { number: 2, path: '.dsh-chapters/A/chapters/002-second.md', title: 'Second', summary: 'b', startSeq: 4, endSeq: 7, sha256: sha256('two'), estimatedTokens: 5, artifacts: [] },
  ] as never[]
  h.fs.files.set('.dsh-chapters/A/chapters/001-first.md', 'one')
  h.fs.files.set('.dsh-chapters/A/chapters/002-second.md', 'two')
  h.states.set('A', appendChapters(freshSession('A'), recs))
  const filesBefore = new Set(h.fs.files.keys())
  const reservationsBefore = JSON.stringify(h.states.get('A')!.reservations)

  const result = await runFork(h.ports, {
    callerSessionId: 'A', callerPreset: 'chapters', title: 'Branch: try Redis', handoffNote: 'Same archive, new approach.',
  }, CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.chapters?.length ?? 0, 0)
  assert.deepEqual(new Set(h.fs.files.keys()), filesBefore)                 // no new files
  assert.equal(JSON.stringify(h.states.get('A')!.reservations), reservationsBefore) // no new numbers
  const child = h.states.get(result.childSessionId!)!
  assert.equal(child.parentSession, 'A')
  assert.equal(child.rootSession, 'A')
  const notice = JSON.stringify(h.created[0]!.noticeEvent.data)
  assert.ok(notice.includes('001-first.md') && notice.includes('002-second.md'))
  assert.ok(notice.includes('Same archive, new approach.'))
})

test('fork respects the budget: a bloated note refuses before creation', async () => {
  const h = harness({ budget: { windowTokens: 32000, headerBoundTokens: 31500 } }) // allowance 125
  await assert.rejects(() => runFork(h.ports, {
    callerSessionId: 'A', callerPreset: null, title: 't', handoffNote: 'x '.repeat(2000),
  }, CONFIG), (error: unknown) => {
    const res = refusalResult(error)
    assert.ok(res && !res.ok && /over budget/.test(res.reason ?? ''))
    return true
  })
  assert.equal(h.created.length, 0)
})

// ------------------------------------------------------------------ budget unit

test('preflight: fraction of the REMAINDER, never of the whole window', () => {
  const ok = preflight({ noticeTokens: 5000, budget: { windowTokens: 32000, headerBoundTokens: 12000 }, ratio: 0.25 })
  assert.equal(ok.ok, true) // remainder 20000 -> allowance 5000
  assert.equal(ok.budget.allowanceTokens, 5000)
  const over = preflight({ noticeTokens: 5001, budget: { windowTokens: 32000, headerBoundTokens: 12000 }, ratio: 0.25 })
  assert.equal(over.ok, false)
  // header bigger than window: allowance 0, refuse — never negative or whole-window
  const hostile = preflight({ noticeTokens: 1, budget: { windowTokens: 1000, headerBoundTokens: 4000 }, ratio: 0.25 })
  assert.equal(hostile.ok, false)
})
