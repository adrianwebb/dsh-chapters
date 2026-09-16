/**
 * dsh-chapters Phase 0, round 10 — G1/G2/G3 measured against a real provider.
 *
 * Rounds 6-9 proved the mechanism with no model calls. This round measures the two claims the plugin exists
 * to make, using a handful of deliberately tiny turns:
 *
 *   G1  a continuation's first request must be materially smaller than its parent's at the same point —
 *       the regression test for the seeding mistake that native fork would have made.
 *   G3  the continuation must build a stable cache: cold first step, high cacheRead on the second.
 *   G2  the parent must be untouched: its cache keeps hitting across the continuation boundary.
 *
 * Metric semantics, corrected by reading this host's own session log: `usage.inputTokens` is the UNcached
 * delta and `usage.cacheReadTokens` is the cached prefix, so total prompt = input + cacheRead and the hit
 * rate is cacheRead / (cacheRead + input). Steady state on this harness measured 99.79%.
 *
 * Costs a few thousand tokens. Runs only against the scratch DSH_HOME.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const OUT = path.join(HOME, 'results-10.json')
const report = { startedAt: new Date().toISOString(), steps: [], probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }

const TOC_TEXT = [
  '## Conversation TOC',
  '',
  'This session continues an earlier conversation. The chapters below hold its history as Markdown.',
  'Use the `read` tool on a chapter path to reload one.',
  '',
  '### In flight',
  'Phase 0 round 10: measuring continuation size and cache behaviour.',
  '',
  '### Chapters',
  '1. [Project Setup](spikes/probe/chapter.md) — Synthetic chapter proving the seed shape.',
  '2. [Auth Debugging](spikes/probe/chapter.md) — Second synthetic chapter for list realism.',
].join('\n')

const notice = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: {
    id: randomUUID(), role: 'user',
    source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: TOC_TEXT }] },
    content: [{ type: 'text', text: TOC_TEXT }],
  },
})

const userMsg = (text) => ({
  id: randomUUID(), role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

/** Drive one turn on an agent and report the usage of the steps it added. */
async function driveTurn(ctx, agent, text, label) {
  const session = agent.session
  const msgs = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'assistant/message')
  const turns = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
  const beforeMsgs = msgs().length
  const beforeTurns = turns()
  agent.steer(userMsg(text))
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    if (turns() > beforeTurns) break
    await new Promise((r) => setTimeout(r, 400))
  }
  const added = msgs().slice(beforeMsgs).map((e) => e.data?.usage).filter(Boolean)
  const last = added.at(-1) ?? null
  const total = last ? (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) : null
  const hit = last && total ? +((100 * (last.cacheReadTokens ?? 0)) / total).toFixed(2) : null
  const entry = { label, stepsAdded: added.length, allAdded: added, lastUsage: last, totalPrompt: total, hitPct: hit, turnEnded: turns() > beforeTurns }
  report.steps.push(entry)
  return entry
}

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()
    const registry = ctx.get('workspaceRegistry')
    const workspace = await registry.createCanonical?.(cwd)

    // -------------------------------------------------- 1. a real parent
    const parentId = `p10-parent-${randomUUID()}`
    const parentHandle = await ctx.agents.create({ sessionId: parentId, meta: { cwd, isSeeded: false } })
    await workspace?.attachSession?.(parentId)
    const parentAgent = parentHandle.agent
    record('parent created', true, { parentId })

    // Build real cached history: turn 1 is cold, turn 2 should hit the prefix turn 1 wrote.
    const p1 = await driveTurn(ctx, parentAgent, 'Reply with exactly: ALPHA. Do not explain.', 'parent turn 1 (cold)')
    const p2 = await driveTurn(ctx, parentAgent, 'Reply with exactly: BRAVO. Do not explain.', 'parent turn 2 (warm)')
    record('parent cache builds', (p2.hitPct ?? 0) > (p1.hitPct ?? 0), { p1: p1.totalPrompt, p2: p2.totalPrompt, p1Hit: p1.hitPct, p2Hit: p2.hitPct })

    // -------------------------------------------------- 2. the continuation
    // Same header, same provider, but its whole history is the TOC notice alone.
    const contId = `p10-cont-${randomUUID()}`
    const parentEvents = (parentAgent.session.snapshotEvents?.() ?? [])
    const contHandle = await ctx.agents.create({
      sessionId: contId, seed: [notice(0)], inheritedEventCount: 0,
      meta: { cwd, parentSession: parentId, isSeeded: false },
    })
    await workspace?.attachSession?.(contId)
    const contAgent = contHandle.agent
    const c1 = await driveTurn(ctx, contAgent, 'Reply with exactly: CHARLIE. Do not explain.', 'continuation turn 1 (cold)')
    const c2 = await driveTurn(ctx, contAgent, 'Reply with exactly: DELTA. Do not explain.', 'continuation turn 2 (warm)')

    // -------------------------------------------------- 3. the verdicts
    const parentTotal = p2.totalPrompt, contTotal = c1.totalPrompt
    record('G1 continuation smaller than parent', contTotal !== null && parentTotal !== null && contTotal < parentTotal, {
      parentPrompt: parentTotal, continuationPrompt: contTotal,
      reduction: parentTotal && contTotal ? +(1 - contTotal / parentTotal).toFixed(3) : null,
      caveat: 'parent here is a short synthetic conversation; a real 100K-token parent widens this gap enormously',
    })
    record('G3 continuation builds a cache', (c2.hitPct ?? 0) > (c1.hitPct ?? 0), {
      cold: c1.lastUsage, warm: c2.lastUsage, coldHit: c1.hitPct, warmHit: c2.hitPct,
    })
    const p3 = await driveTurn(ctx, parentAgent, 'Reply with exactly: ECHO. Do not explain.', 'parent turn 3 (after continuation)')
    record('G2 parent cache undisturbed', (p3.hitPct ?? 0) >= (p2.hitPct ?? 0) * 0.9, {
      beforeContinuationHit: p2.hitPct, afterContinuationHit: p3.hitPct,
    })

    // -------------------------------------------------- 4. does the notice read back intact
    const obs = await ctx.sessionQuery.observeSession(contId)
    const msg = (obs?.events ?? []).find((e) => e.type === 'user/message')
    record('notice byte-identical after provider round-trip', (msg?.data?.content?.[0]?.text ?? null) === TOC_TEXT, {
      sourceKind: msg?.data?.source?.kind, hadTurn: (obs?.events ?? []).some((e) => e.type === 'turn/end'),
      eventTypes: (obs?.events ?? []).map((e) => `${e.type}@${e.seq}`),
    })
    const headerOf = (a) => a?.session?.header ?? null
    record('lineage fields on the continuation', true, {
      parentSessionRecorded: headerOf(contAgent)?.parentSession ? String(headerOf(contAgent).parentSession) : null,
      isSeeded: headerOf(contAgent)?.isSeeded,
      note: 'meta.parentSession was supplied; check whether the kernel kept it for a non-seeded child',
    })

    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
