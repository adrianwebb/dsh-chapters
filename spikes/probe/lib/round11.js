/**
 * dsh-chapters Phase 0, round 11 — G1/G2/G3 with the agent actually composed.
 *
 * Round 10's turns all ended in error before reaching a provider (so nothing was spent):
 *
 *   prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
 *
 * That is the `hasPreset: false` finding from round 8/9 made concrete: `ctx.agents.create` gives you a
 * DURABLE, LISTED, RESUMABLE session, but not by itself a *usable conversational* one. A real session gets
 * an agent preset plus a model selection, which is exactly why dsh-session-fork passes
 * `agentOptions: defaultModel.currentSelection()`, `meta.agentPreset`, and `setup` (src/index.ts:368-381).
 * For `chapters_continue` this is not optional — a continuation that cannot resolve its own model is a
 * broken session the user inherits.
 *
 * This round composes properly via the same services, then measures size and cache.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const OUT = path.join(HOME, 'results-11.json')
const report = { startedAt: new Date().toISOString(), steps: [], probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }

const TOC_TEXT = [
  '## Conversation TOC', '',
  'This session continues an earlier conversation. Chapters below hold its history as Markdown.', '',
  '### In flight', 'Phase 0 round 11: measuring continuation size and cache.', '',
  '### Chapters', '1. [Project Setup](spikes/probe/chapter.md) — Synthetic chapter.',
  '2. [Auth Debugging](spikes/probe/chapter.md) — Second synthetic chapter.',
].join('\n')

const notice = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: TOC_TEXT }] }, content: [{ type: 'text', text: TOC_TEXT }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

async function driveTurn(agent, text, label) {
  const session = agent.session
  const msgs = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'assistant/message')
  const turns = () => (session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
  const beforeMsgs = msgs().length
  const beforeTurns = turns()
  agent.steer(userMsg(text))
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline && turns() === beforeTurns) await new Promise((r) => setTimeout(r, 400))
  const added = msgs().slice(beforeMsgs).map((e) => e.data?.usage).filter(Boolean)
  const last = added.at(-1) ?? null
  const total = last ? (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) : null
  const hit = last && total ? +((100 * (last.cacheReadTokens ?? 0)) / total).toFixed(2) : null
  const errs = (session.snapshotEvents?.() ?? []).slice(-4).map((e) => e.type === 'turn/end' ? JSON.stringify(e.data?.reason ?? null) : null).filter(Boolean)
  const entry = { label, stepsAdded: added.length, totalPrompt: total, hitPct: hit, lastUsage: last, turnEnded: turns() > beforeTurns, turnEndReasons: errs }
  report.steps.push(entry)
  return entry
}

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()
    const workspace = await ctx.get('workspaceRegistry').createCanonical?.(cwd)

    // ------------------------------------------- 1. how does a real session get composed?
    const defaultModel = ctx.get('agentDefaultModel')
    let selection = null, selectionErr = null
    try { selection = defaultModel?.currentSelection?.() ?? null } catch (error) { selectionErr = String(error?.message ?? error) }
    record('agentDefaultModel.currentSelection()', Boolean(selection), {
      surface: defaultModel ? Object.getOwnPropertyNames(Object.getPrototypeOf(defaultModel)).sort() : null,
      selection, selectionErr,
    })

    // Look at an ALREADY-RUNNING real session to copy its composition rather than invent one.
    let exemplar = null
    try {
      const listed = await ctx.sessionQuery.listSessions(new AbortController().signal)
      const list = Array.isArray(listed) ? listed : (listed?.sessions ?? [])
      for (const rec of list) {
        const id = rec?.header?.id
        if (!id || String(id).startsWith('p1')) continue     // skip our own probe junk
        const obs = await ctx.sessionQuery.observeSession(id)
        const preset = obs?.projections?.values?.agentPreset ?? obs?.agentPreset ?? null
        if (preset) { exemplar = { id: String(id), preset, keys: Object.keys(obs?.projections?.values ?? {}).sort() }; break }
      }
    } catch (error) { record('exemplar scan', false, { message: String(error?.message ?? error) }) }
    record('found a real session with an agentPreset', Boolean(exemplar), {
      id: exemplar?.id ?? null, presetShape: exemplar?.preset ? JSON.stringify(exemplar.preset).slice(0, 220) : null,
      projectionKeys: exemplar?.keys ?? null,
    })

    const compose = () => ({
      ...(selection ? { agentOptions: selection } : {}),
      ...(exemplar?.preset ? { meta: { agentPreset: exemplar.preset } } : {}),
    })

    // -------------------------------------------------- 2. real parent
    const parentId = `p11-parent-${randomUUID()}`
    let parentAgent
    try {
      const base = compose()
      const h = await ctx.agents.create({ sessionId: parentId, meta: { cwd, isSeeded: false, ...(base.meta ?? {}) }, ...(base.agentOptions ? { agentOptions: base.agentOptions } : {}) })
      await workspace?.attachSession?.(parentId)
      parentAgent = h.agent
      record('parent composed', true, { parentId, options: parentAgent.options ? JSON.stringify(parentAgent.options).slice(0, 160) : null })
    } catch (error) { record('parent composed', false, { message: String(error?.message ?? error) }) }

    if (!parentAgent) { report.notes.push('parent not usable; aborting measurement'); report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

    const p1 = await driveTurn(parentAgent, 'Reply with exactly: ALPHA. No explanation.', 'parent turn 1 (cold)')
    const p2 = await driveTurn(parentAgent, 'Reply with exactly: BRAVO. No explanation.', 'parent turn 2 (warm)')
    const p3 = await driveTurn(parentAgent, 'Reply with exactly: CHARLIE. No explanation.', 'parent turn 3 (warm)')

    // -------------------------------------------------- 3. the continuation
    const contId = `p11-cont-${randomUUID()}`
    const base = compose()
    const ch = await ctx.agents.create({
      sessionId: contId, seed: [notice(0)], inheritedEventCount: 0,
      meta: { cwd, parentSession: parentId, isSeeded: false, ...(base.meta ?? {}) },
      ...(base.agentOptions ? { agentOptions: base.agentOptions } : {}),
    })
    await workspace?.attachSession?.(contId)
    const c1 = await driveTurn(ch.agent, 'Reply with exactly: DELTA. No explanation.', 'continuation turn 1 (cold)')
    const c2 = await driveTurn(ch.agent, 'Reply with exactly: ECHO. No explanation.', 'continuation turn 2 (warm)')
    const p4 = await driveTurn(parentAgent, 'Reply with exactly: FOXTROT. No explanation.', 'parent turn 4 (after continuation)')

    // -------------------------------------------------- 4. verdicts
    record('G1 continuation first request smaller than parent', Boolean(c1.totalPrompt && p3.totalPrompt && c1.totalPrompt < p3.totalPrompt), {
      parentWarmPrompt: p3.totalPrompt, continuationColdPrompt: c1.totalPrompt,
      reductionPct: c1.totalPrompt && p3.totalPrompt ? +((1 - c1.totalPrompt / p3.totalPrompt) * 100).toFixed(1) : null,
    })
    record('G3 continuation builds a cache across turns', (c2.hitPct ?? 0) > (c1.hitPct ?? 0), { coldHit: c1.hitPct, warmHit: c2.hitPct, cold: c1.lastUsage, warm: c2.lastUsage })
    record('G2 parent cache undisturbed by the continuation', (p4.hitPct ?? 0) >= (p3.hitPct ?? 0) - 1, { parentBefore: p3.hitPct, parentAfter: p4.hitPct })
    record('parent turns all produced usage', [p1, p2, p3, p4].every((x) => x.lastUsage), { reasons: [p1, p2, p3, p4].map((x) => x.turnEndReasons).flat().slice(0, 3) })

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
