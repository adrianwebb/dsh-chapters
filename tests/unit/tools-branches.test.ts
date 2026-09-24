/**
 * tools.ts branch sweep — the failure arms of the child-creation seam (invariant 2's
 * live work), rules-notice composition, and the registration disposers. Together
 * with tools-surface.test.ts (the happy paths) this closes the tool wrappers'
 * error taxonomy: a child that can't be titled/attached is STILL durable, and a
 * broken rules mirror never breaks a continuation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools, registerChaptersTools } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'
import type { SessionState } from '../../src/registry.ts'

type Ev = { seq: number; type: string; data: Record<string, unknown> }
const ev = (seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({ seq, type, data })
const human = (seq: number, text: string): Ev => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (seq: number, text: string): Ev => ev(seq, 'assistant/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

function world(fail: { attach?: boolean; rename?: boolean; noRename?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsbr-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (n: string) => { let m = tables.get(n); if (m === undefined) { m = new Map(); tables.set(n, m) } return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries(), get size() { return m!.size } } }
  const store = makeDomainStore({ table, close: async () => {} } as never)
  const warns: string[] = []
  let disposed = 0
  const ctx = {
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }) },
    agents: {
      create: async (o: Record<string, unknown>) => {
        await (o.setup as (c: unknown) => Promise<void>)({})
        return { dispose: async () => { disposed += 1 } }
      },
    },
    get: (name: string) => {
      if (name === 'agentPresets') return { mount: async () => undefined }
      if (name === 'workspaceRegistry') return { createCanonical: async () => { if (fail.attach) throw new Error('registry offline'); return { attachSession: async () => undefined } } }
      if (name === 'sessionController') {
        if (fail.noRename) return {}
        return { rename: async () => { if (fail.rename) throw new Error('title owned elsewhere') } }
      }
      if (name === 'commands') return { register: () => () => undefined }
      return undefined
    },
    tools: { register: () => () => undefined },
    sessionProjections: { stateOf: () => 'chapters' },
    logger: { info: () => undefined, warn: (m: unknown) => { warns.push(String(m)) } },
  }
  const events: Ev[] = [human(0, 'wire the composer into the merge path'), asst(1, 'wired; npm test green'), ev(2, 'turn/end', {})]
  const caller = { id: 'sess-b', options: { provider: 'local', model: 'm' }, session: { id: 'sess-b', header: { cwd: tmp }, snapshotEvents: () => events } }
  const config = {
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', harnessId: 'hB', coreRulesBudgetTokens: 1200,
    scheduler: { schedule: () => undefined, pullFor: async () => ({ ok: true, detail: '' }), run: async () => ({}), hasPending: () => false, drain: async () => {} },
  }
  const built = buildChaptersTools(ctx as never, store as never, config as never)
  return { tmp, store, built, caller, warns, events, tables, exec: { agent: caller }, dispose: () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

const continueArgs = {
  title: 'Branch continues',
  handoffNote: 'Composer wired; next: e2e.',
  chapters: [{ title: 'Composer wiring', summary: 'wired composer into merge', startSeq: 0, endSeq: 2 }],
}

test('child created despite workspace-attach failure — the miss is warned, not fatal', async () => {
  const w = world({ attach: true })
  try {
    const r = await w.built.chaptersContinue.execute(continueArgs as never, w.exec as never) as { ok: boolean }
    assert.equal(r.ok, true, 'continuation survives an unattachable workspace')
    assert.ok(w.warns.some((m) => m.includes('workspace attach failed')), 'and says so')
  } finally { w.dispose() }
})

test('child title refused (rename throws) is cosmetic; child remains durable', async () => {
  const w = world({ rename: true })
  try {
    const r = await w.built.chaptersContinue.execute(continueArgs as never, w.exec as never) as { ok: boolean }
    assert.equal(r.ok, true)
    assert.ok(w.warns.some((m) => m.includes('child title refused')))
  } finally { w.dispose() }
})

test('sessionController absent warns the child is untitled', async () => {
  const w = world({ noRename: true })
  try {
    const r = await w.built.chaptersContinue.execute(continueArgs as never, w.exec as never) as { ok: boolean }
    assert.equal(r.ok, true)
    assert.ok(w.warns.some((m) => m.includes('sessionController absent')))
  } finally { w.dispose() }
})

test('segment lists existing chapters from the registry (watermark view)', async () => {
  const w = world()
  try {
    const base = await w.store.get('sess-b')
    await w.store.put('sess-b', { ...base, chapters: [
      { number: 1, path: '.dsh-chapters/sess-b/chapters/001-old.md', title: 'old', summary: 'old work', startSeq: 0, endSeq: 1, sha256: 'x'.repeat(10), artifacts: [], estimatedTokens: 10, startSeqOverride: undefined } as unknown as SessionState['chapters'][number],
    ] })
    const r = await w.built.segment.execute({} as never, w.exec as never) as { ok: boolean; existingChapters: Array<{ number: number }> }
    assert.equal(r.existingChapters.length, 1)
    assert.equal(r.existingChapters[0].number, 1)
  } finally { w.dispose() }
})

test('a broken rules mirror is absorbed — continuation proceeds without the section', async () => {
  const w = world()
  try {
    // link a project so rulesSectionFor actually runs, then make the rules
    // tree unreadable: collectMirrorRules throws INSIDE buildRulesSection's
    // view of the mirror and the wrapper must swallow it (rules are additive)
    await tablePut(w, 'PKB')
    const rulesRoot = path.join(w.tmp, '.dsh-knowledge', 'rules', 'PKB', 'hB')
    fs.mkdirSync(rulesRoot, { recursive: true })
    fs.chmodSync(rulesRoot, 0o000)
    try {
      const r = await w.built.chaptersContinue.execute(continueArgs as never, w.exec as never) as { ok: boolean }
      assert.equal(r.ok, true, 'a broken mirror never breaks continuation')
    } finally {
      fs.chmodSync(rulesRoot, 0o755)
    }
  } finally { w.dispose() }
})

async function tablePut(w: { store: unknown }, key: string): Promise<void> {
  // reach through the domain store to the projects table the world built
  const store = w.store as { tableRaw?: (n: string) => { put: (k: string, v: unknown) => Promise<void> } }
  void store
  // simpler: the world's projects table is a Map keyed by projectKey
  const tables = (w as unknown as { tables: Map<string, Map<string, unknown>> }).tables
  let m = tables.get('projects')
  if (m === undefined) { m = new Map(); tables.set('projects', m) }
  m.set(key, { projectKey: key, slug: 'kb', remote: 'https://x.invalid/kb.git', harnessId: 'hB', linkedAt: 'now', cwd: (w as unknown as { tmp: string }).tmp })
}

test('registerChaptersTools wires the /chapters-fork command and disposes everything', async () => {
  const w = world()
  try {
    let commandDisposed = false
    const registrar = {
      tools: { register: () => () => undefined },
      get: (name: string) => name === 'commands' ? { register: () => () => { commandDisposed = true } } : undefined,
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }) },
      agents: { create: async () => ({}) },
      sessionProjections: { stateOf: () => 'chapters' },
      logger: { info: () => undefined, warn: () => undefined },
    }
    const dispose = registerChaptersTools(registrar as never, w.store as never, {
      artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
      continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
    } as never)
    dispose()
    assert.ok(commandDisposed, 'the fork-command disposer ran with the tool disposers')
  } finally { w.dispose() }
})
