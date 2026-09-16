/**
 * dsh-chapters Phase 0 probe, round 8 — the last rows, in one boot.
 *
 * Round 7's two failures were both mine: `listSessions(signal?: AbortSignal)` takes a POSITIONAL signal
 * (session-query/src/index.ts:174), so passing `{ signal }` made the harness call `throwIfAborted` on a
 * plain object; and `agents.resume` correctly refused because round 7 still held the create handle —
 * "already owned by an active write handle" is the ownership contract working, not a defect.
 *
 * Round 6 created a session without a workspace, so it could not be listed. Round 7 attached one and STILL
 * saw it absent from listSessions(). The remaining hypothesis is a title: a session with no `session/title`
 * event may not surface. So this round disposes properly, resumes, and tests whether naming a continuation
 * makes it appear.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const OUT = path.join(HOME, 'results-8.json')
const report = { startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }

const TOC_TEXT = '## Conversation TOC\n\nRound 8 probe notice.\n\n### Chapters\n1. [Probe](x.md) — t.\n'
const notice = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: TOC_TEXT }] }, content: [{ type: 'text', text: TOC_TEXT }] },
})
const eventsOf = (e) => (Array.isArray(e?.events) ? e.events : (e?.snapshotEvents?.() ?? []))
const brief = (e) => e ? { events: eventsOf(e).length, types: eventsOf(e).map((x) => `${x.type}@${x.seq}`) } : null

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents', 'sessionController', 'commands']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()
    const registry = ctx.get('workspaceRegistry')
    const workspace = await registry.createCanonical?.(cwd) ?? registry.create?.({ cwd })
    record('workspace', Boolean(workspace), { id: String(workspace?.id ?? '') })

    // -------- A. create, then DISPOSE the handle so resume can own it
    const idA = `p8-a-${randomUUID()}`
    let handleA
    try {
      handleA = await ctx.agents.create({ sessionId: idA, seed: [notice(0)], inheritedEventCount: 0, meta: { cwd, isSeeded: false } })
      record('A create', true, { idA, ...brief(ctx.sessions.get(idA)) })
    } catch (error) { record('A create', false, { message: String(error?.message ?? error) }) }
    await workspace?.attachSession?.(idA).catch((e) => record('A attach', false, { message: String(e?.message) }))
    if (typeof handleA?.dispose === 'function') { await handleA.dispose(); record('A dispose handle', true, { disposed: true }) }
    try { await ctx.sessionPersistence.flush?.(ctx.sessions.get(idA)) } catch { /* best effort */ }

    // -------- B. positional signal, as the source declares
    let listed = null
    try {
      const ac = new AbortController()
      const r = await ctx.sessionQuery.listSessions(ac.signal)
      const list = Array.isArray(r) ? r : (r?.sessions ?? [])
      listed = list
      record('B listSessions(signal) positional', true, { total: list.length, hasA: list.some((s) => String(s?.id ?? s) === idA) })
    } catch (error) { record('B listSessions(signal) positional', false, { message: String(error?.message ?? error).slice(0, 140) }) }

    // -------- C. does naming make it appear?
    const controller = ctx.get('sessionController')
    for (const [label, call] of [
      ['rename command', () => ctx.commands?.execute?.('session.rename', { sessionId: idA, title: 'Phase 0 continuation' })],
      ['controller.renameSession', () => controller?.renameSession?.(idA, 'Phase 0 continuation')],
      ['controller.rename', () => controller?.rename?.({ sessionId: idA, title: 'Phase 0 continuation' })],
    ]) {
      try {
        const r = await call()
        record(`C name via ${label}`, true, { result: r === undefined ? 'undefined(ok)' : typeof r })
        break
      } catch (error) { record(`C name via ${label}`, false, { message: String(error?.message ?? error).slice(0, 110) }) }
    }
    try { await ctx.sessionPersistence.flush?.(ctx.sessions.get(idA)) } catch { /* best effort */ }
    try {
      const after = await ctx.sessionQuery.listSessions(new AbortController().signal)
      const list = Array.isArray(after) ? after : (after?.sessions ?? [])
      record('C listed after naming', list.some((s) => String(s?.id ?? s) === idA), { total: list.length, titleNow: await ctx.sessionQuery.readTitle?.(idA).catch?.(() => null) })
    } catch (error) { record('C listed after naming', false, { message: String(error?.message ?? error).slice(0, 110) }) }

    // -------- D. resume after disposal
    try {
      const h = await ctx.agents.resume({ resumeSessionId: idA })
      record('D resume after dispose', true, { agentId: String(h?.agent?.id ?? ''), ...brief(ctx.sessions.get(idA)) })
      if (typeof h?.dispose === 'function') await h.dispose()
    } catch (error) { record('D resume after dispose', false, { message: String(error?.message ?? error).slice(0, 160) }) }

    // -------- E. what the 12 listed sessions look like, for comparison
    if (listed) {
      record('E listed session shapes', true, {
        sample: listed.slice(0, 4).map((s) => ({ keys: Object.keys(s ?? {}).sort().slice(0, 9), id: String(s?.id ?? s).slice(0, 22), hasTitle: Boolean(s?.title) })),
        probeIds: listed.map((s) => String(s?.id ?? s)).filter((i) => /^(p[5678]|probe)-/.test(i)).slice(0, 6),
      })
    }

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
