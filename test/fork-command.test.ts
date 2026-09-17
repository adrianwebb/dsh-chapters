/**
 * L0 tests for the /chapters-fork command handler — the fork-button backend.
 * Same shared ports as the tools; real temp-dir fs so chapter files actually
 * materialize; stub ctx only where the harness would (agents.create capture).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools } from '../src/tools.ts'
import { freshSession, type SessionState } from '../src/registry.ts'
import type { SessionEventLike } from '../src/types.ts'

const CONFIG = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25,
  fallbackPreset: 'chapters',
}

const ev = (seq: number, type: string, text?: string): SessionEventLike =>
  type === 'user/message' || type === 'assistant/message'
    ? { type, seq, time: 0, surfaceOp: 'append', data: { id: `m${seq}`, role: type.split('/')[0], source: { kind: 'user' }, content: [{ type: 'text', text: text ?? `message ${seq} ${'filler words '.repeat(20)}` }] } } as SessionEventLike
    : type === 'session/title'
      ? { type, seq, time: 0, surfaceOp: 'append', data: { title: text ?? 'Parent Title' } } as SessionEventLike
      : { type, seq, time: 0, data: { turn: 1 } } as SessionEventLike

const conversation = (): SessionEventLike[] => [
  ev(0, 'session/title', 'Research notes'), ev(1, 'user/message'), ev(2, 'assistant/message'),
  ev(3, 'user/message'), ev(4, 'assistant/message'), { type: 'turn/end', seq: 5, data: {} } as SessionEventLike,
  ev(6, 'user/message'), ev(7, 'assistant/message'), { type: 'turn/end', seq: 8, data: {} } as SessionEventLike,
]

function makeWorld(opts: { events?: SessionEventLike[] } = {}) {
  const tmp = path.join(os.tmpdir(), `chapters-cmd-${Math.random().toString(36).slice(2)}`)
  const states = new Map<string, SessionState>()
  const createRequests: Array<Record<string, unknown>> = []
  const caller = {
    id: 'caller-1',
    options: { provider: 'local', model: 'qwen3.8-flash-next' },
    session: {
      id: 'caller-1',
      header: { cwd: tmp },
      snapshotEvents: () => opts.events ?? conversation(),
    },
  }
  const ctx = {
    get: (_name: string) => undefined,
    sessionProjections: { stateOf: (_s: unknown, key: string) => (key === 'agentPreset' ? 'chapters' : undefined) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 65536 } }) },
    agents: { create: async (req: Record<string, unknown>) => { createRequests.push(req); return { dispose: async () => {} } } },
    logger: { warn: (_m: string) => {} },
  }
  const store = {
    get: async (id: string) => states.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states.set(id, s) },
  }
  const built = buildChaptersTools(ctx as never, store as never, CONFIG as never)
  return { built, caller, states, createRequests, tmp }
}

test('success path: files written, child seeded with a TOC notice citing them, custom title wins', async () => {
  const w = makeWorld()
  const result = await w.built.forkCommand.handler({ agent: w.caller as never, rawInput: 'Deep dive' })
  assert.equal(result.kind, 'success')
  assert.equal(w.createRequests.length, 1)
  const req = w.createRequests[0]!
  assert.equal(req.inheritedEventCount, 0)
  const seed = req.seed as SessionEventLike[]
  assert.equal(seed.length, 1)
  const noticeText = JSON.stringify(seed[0]!.data)
  const chapters = w.states.get('caller-1')!.chapters
  assert.ok(chapters.length >= 1)
  assert.ok(noticeText.includes(chapters[0]!.path), 'notice cites the chapter path')
  // the archive itself on disk (real fs):
  const fsMod = await import('node:fs')
  assert.ok(fsMod.existsSync(path.join(w.tmp, chapters[0]!.path)))
  const body = fsMod.readFileSync(path.join(w.tmp, chapters[0]!.path), 'utf8')
  assert.match(body, /message 1 /) // verbatim seed text inside
  assert.equal(req.title, undefined) // title flows through createChild input, not create req — check capture below
  // child title applied through the port (createChild receives it):
  assert.match(result.kind === 'success' ? result.text ?? '' : '', /Deep dive/)
})

test('no argument: title derives from the parent session/title event', async () => {
  const w = makeWorld()
  const result = await w.built.forkCommand.handler({ agent: w.caller as never, rawInput: '   ' })
  assert.equal(result.kind, 'success')
  assert.match(result.kind === 'success' ? result.text ?? '' : '', /Research notes — branch/)
})

test('no completed turn: a clean error result, nothing created', async () => {
  const w = makeWorld({ events: [ev(0, 'user/message')] })
  const result = await w.built.forkCommand.handler({ agent: w.caller as never, rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.kind === 'error' ? result.text : '', /no completed turn/)
  assert.equal(w.createRequests.length, 0)
})
