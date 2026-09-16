/**
 * dsh-chapters Phase 0 probe, round 7 — sidebar listing and resume, with the signatures read from source
 * rather than guessed: `agents.resume({ resumeSessionId })` (core/agent/src/index.ts:125-133) and a
 * workspace resolved through `workspaceRegistry`, whose entries expose `attachSession` / `sessionIds`
 * (dsh-session-fork/src/vendor/fork.ts:139-182).
 *
 * Round 6's "not listed" result had a mundane explanation: `workspaceRegistry.list()` returned ZERO
 * workspaces, because nothing in the scratch profile had ever opened one. An unattached session in an
 * unlisted workspace is not the eviction trap; it is the expected consequence of skipping the attach.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const OUT = path.join(HOME, 'results-7.json')
const STATE = path.join(HOME, 'round7-state.json')
const report = { startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }

const TOC_TEXT = `## Conversation TOC\n\nRound 7 probe notice.\n\n### Chapters\n1. [Probe](spikes/probe/chapter.md) — proving attach + resume.\n\nmarker: ${'r7-' + randomUUID()}`

const notice = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: TOC_TEXT }] }, content: [{ type: 'text', text: TOC_TEXT }] },
})
const eventsOf = (e) => (Array.isArray(e?.events) ? e.events : (e?.snapshotEvents?.() ?? []))
const summarize = (e) => e ? { events: eventsOf(e).length, types: eventsOf(e).map((x) => `${x.type}@${x.seq}`), header: { isSeeded: e.header?.isSeeded, cwd: e.header?.cwd ?? null } } : null

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents', 'storageDomain']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()
    const registry = ctx.get('workspaceRegistry')

    // ------------------------------------------- 1. obtain a workspace
    let workspace
    for (const [label, make] of [
      ['resolveByPath(cwd)', () => registry.resolveByPath?.(cwd)],
      ['get(cwd)', () => registry.get?.(cwd)],
      ['createCanonical(cwd)', () => registry.createCanonical?.(cwd)],
      ['create()', () => registry.create?.({ cwd })],
    ]) {
      if (typeof make !== 'function') continue
      try {
        const r = await make()
        if (r) { workspace = r; record(`workspace ${label}`, true, { id: String(r.id ?? ''), sessions: r.sessionIds?.length ?? null }); break }
        record(`workspace ${label}`, false, { note: 'returned falsy' })
      } catch (error) { record(`workspace ${label}`, false, { message: String(error?.message ?? error).slice(0, 120) }) }
    }
    if (!workspace) report.notes.push('NO WORKSPACE OBTAINED — sidebar listing cannot be proven from a plugin alone')

    // ------------------------------------------- 2. create + attach
    const childId = `p7-cont-${randomUUID()}`
    try {
      await ctx.agents.create({ sessionId: childId, seed: [notice(0)], inheritedEventCount: 0, meta: { cwd, isSeeded: false } })
      record('create', true, { childId, live: summarize(ctx.sessions.get(childId)) })
    } catch (error) { record('create', false, { message: String(error?.message ?? error) }) }

    if (workspace) {
      try {
        await workspace.attachSession(childId)
        record('attachSession', true, { sessionIdsNow: workspace.sessionIds?.map(String)?.slice(-4) ?? null })
      } catch (error) { record('attachSession', false, { message: String(error?.message ?? error) }) }
    }
    record('registry.list after attach', true, { workspaces: [...(registry.list?.() ?? [])].map((w) => ({ id: String(w.id ?? ''), sessionCount: w.sessionIds?.length ?? null })) })

    // ------------------------------------------- 3. the sidebar question
    try {
      const r = await ctx.sessionQuery.listSessions()
      const list = Array.isArray(r) ? r : (r?.sessions ?? [])
      const hit = list.find((s) => String(s?.id ?? s) === childId)
      record('SESSION LISTED by listSessions()', Boolean(hit), { total: list.length, found: Boolean(hit), entry: hit ? { id: String(hit.id ?? ''), title: hit.title ?? null, cwd: hit.cwd ?? null } : null })
    } catch (error) { record('SESSION LISTED by listSessions()', false, { message: String(error?.message ?? error).slice(0, 140) }) }

    try {
      const trace = await ctx.sessionQuery.traceSession(childId)
      record('traceSession on the continuation', true, { ancestors: trace?.ancestors?.length ?? null, keys: Object.keys(trace ?? {}).slice(0, 8) })
    } catch (error) { record('traceSession on the continuation', false, { message: String(error?.message ?? error).slice(0, 140) }) }

    // ------------------------------------------- 4. resume, correct options
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: childId })
      const agent = handle?.agent ?? handle
      record('agents.resume({ resumeSessionId })', Boolean(agent), {
        handleKeys: handle ? Object.keys(handle).sort().slice(0, 8) : null,
        agentId: agent?.id ? String(agent.id) : null,
        live: summarize(ctx.sessions.get(childId)),
        sessionTitle: await ctx.sessionQuery.readTitle?.(childId).catch?.(() => null) ?? null,
      })
      if (typeof handle?.dispose === 'function') await handle.dispose()
    } catch (error) { record('agents.resume({ resumeSessionId })', false, { message: String(error?.message ?? error).slice(0, 180) }) }

    // ------------------------------------------- 5. record id for a restart check
    fs.writeFileSync(STATE, JSON.stringify({ childId, cwd, createdAt: new Date().toISOString() }, null, 2))
    try { await ctx.sessionPersistence.flush?.(ctx.sessions.get(childId)) } catch { /* best effort */ }

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
