/**
 * dsh-chapters Phase 0 probe, round 3 — the restart gate.
 *
 * Rounds 1-2 established that `agents.create` is plugin-reachable, that a single-event seed with an
 * identified user/message at seq 0 is accepted, and that seq continuity is enforced. What has NOT been
 * shown is the thing that actually decides the design: does such a session SURVIVE the process — is it
 * still on disk, still listable, and still readable after the harness is killed and booted again?
 *
 * dsh-session-fork's branch.ts:10-14 warns that kernel-created children can be fiber-scoped, evicted,
 * and broadcast `session-removed` — vanishing from the sidebar. That trap is only visible across a
 * process boundary, so this probe runs in two boots:
 *
 *   PROBE_MODE=create   create one continuation-shaped session, record its id, exit
 *   PROBE_MODE=verify   boot fresh, read that id back, report whether it survived and what it contains
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const IDS = path.join(HOME, 'created-ids.json')
const OUT = path.join(HOME, `results-3-${process.env.PROBE_MODE ?? 'create'}.json`)
const MODE = process.env.PROBE_MODE ?? 'create'

const report = { mode: MODE, startedAt: new Date().toISOString(), dshHome: process.env.DSH_HOME, probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }

// Round 3 first-run findings: a freshly created session already contains kernel setup events
// (permission/preset@0, sandbox/mode@1, approval/policy@2), so a seed must begin at the first FREE seq,
// and the user/message data must carry `role: "user"` plus an id. Derive the offset; never hardcode it.
const notice = (seq, text) => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }] },
  surfaceOp: 'append',
})

const TOC_TEXT = [
  '## Conversation TOC',
  '',
  'This session continues an earlier conversation. The chapters below hold its history as Markdown.',
  '',
  '### In flight',
  'Phase 0 probe continuation. Parent: probe.',
  '',
  '### Chapters',
  '1. [Probe Chapter](spikes/probe/chapter.md) — Synthetic chapter used to prove the seed shape.',
].join('\n')

const summarize = (entry) => {
  if (!entry) return null
  const events = Array.isArray(entry.events) ? entry.events : (entry.snapshotEvents?.() ?? [])
  const h = entry.header ?? {}
  return {
    events: events.length,
    eventTypes: events.map((e) => `${e.type}@${e.seq}`),
    header: { isSeeded: h.isSeeded, parentSession: h.parentSession ? String(h.parentSession) : null, cwd: h.cwd ?? null, id: h.id ? String(h.id) : null },
  }
}

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents', 'storageDomain']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()

    if (MODE === 'create') {
      const ids = []
      // Derive the seed start offset from a throwaway control session rather than assuming 3.
      const control = `probe-control-${randomUUID()}`
      let seedStart = 0
      try {
        await ctx.agents.create({ sessionId: control, meta: { cwd } })
        seedStart = summarize(ctx.sessions.get(control))?.events ?? 0
        record('control session setup-event count', true, { seedStart, setup: summarize(ctx.sessions.get(control))?.eventTypes })
      } catch (error) {
        record('control session setup-event count', false, { message: String(error?.message ?? error) })
      }
      report.notes.push(`derived seed start seq = ${seedStart}`)
      const idsWithOffset = []
      // A: continuation-shaped — exactly what chapters_continue will produce
      const a = `probe-cont-${randomUUID()}`
      try {
        await ctx.agents.create({ sessionId: a, seed: [notice(seedStart, TOC_TEXT)], meta: { cwd } })
        ids.push({ role: 'continuation', id: a, live: summarize(ctx.sessions.get(a)) })
        record('create continuation-shaped session', true, ids.at(-1))
      } catch (error) {
        record('create continuation-shaped session', false, { message: String(error?.message ?? error) })
      }
      // B: unseeded control
      const b = `probe-bare-${randomUUID()}`
      try {
        await ctx.agents.create({ sessionId: b, meta: { cwd } })
        ids.push({ role: 'bare', id: b, live: summarize(ctx.sessions.get(b)) })
        record('create unseeded control', true, ids.at(-1))
      } catch (error) {
        record('create unseeded control', false, { message: String(error?.message ?? error) })
      }
      // flush so the child has the best chance of hitting disk before we kill the process
      for (const { id } of ids) {
        try { await ctx.sessionPersistence.flush?.(ctx.sessions.get(id)) } catch { /* best effort */ }
      }
      fs.writeFileSync(IDS, JSON.stringify({ ids, seedStart, createdAt: new Date().toISOString() }, null, 2))
      void idsWithOffset
      report.notes.push('created; kill this process, then re-run with PROBE_MODE=verify')
    } else {
      const stored = JSON.parse(fs.readFileSync(IDS, 'utf8'))
      report.createdInPriorBoot = stored.createdAt
      if (stored.seedStart !== undefined) report.notes.push(`prior boot derived seedStart=${stored.seedStart}`)
      for (const { role, id, live } of stored.ids) {
        const now = summarize(ctx.sessions.get(id))
        record(`survives restart (${role})`, Boolean(now), { id, wasLiveBefore: live, isLiveNow: now })

        let observed = null, observedErr = null
        try { observed = await ctx.sessionQuery.observeSession(id) } catch (error) { observedErr = String(error?.message ?? error) }
        record(`sessionQuery.observeSession (${role})`, Boolean(observed), {
          found: Boolean(observed),
          events: observed?.events?.length ?? observed?.snapshotEvents?.()?.length,
          hasPreset: Boolean(observed?.projections?.values?.agentPreset ?? observed?.agentPreset),
          observedErr,
        })

        let persisted = null
        try { persisted = await ctx.sessionPersistence.readStoredLog?.(id) ?? null } catch (error) { persisted = { error: String(error?.message ?? error) } }
        record(`stored log readable (${role})`, Boolean(persisted && !persisted?.error), {
          kind: persisted ? (persisted.error ? 'error' : typeof persisted) : 'null',
          events: Array.isArray(persisted?.events) ? persisted.events.length : undefined,
          error: persisted?.error,
        })
      }
      // is it LISTED? the sidebar question, proxied by the query service
      try {
        const listed = await ctx.sessionQuery.listSessions({})
        const list = Array.isArray(listed) ? listed : (listed?.sessions ?? [])
        const hit = list.filter((s) => String(s?.id ?? s).startsWith('probe-'))
        record('probe sessions appear in listSessions', hit.length > 0, {
          totalListed: list.length, probeListed: hit.map((s) => ({ id: String(s?.id ?? s), title: s?.title ?? null })),
        })
      } catch (error) {
        record('probe sessions appear in listSessions', false, { message: String(error?.message ?? error) })
      }
      // resume: can an agent be re-attached to the continued session?
      const cont = stored.ids.find((x) => x.role === 'continuation')
      if (cont) {
        let resumed = null, resumeErr = null
        try { resumed = await ctx.agents.resume?.(cont.id) ?? 'no resume method' } catch (error) { resumeErr = String(error?.message ?? error) }
        record('agents.resume the continuation', Boolean(resumed) && !resumeErr, {
          resumed: resumed ? typeof resumed : null, resumeErr,
          after: summarize(ctx.sessions.get(cont.id)),
        })
      }
    }

    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
  setTimeout(() => {
    run().catch((error) => {
      report.fatal = String(error?.stack ?? error)
      report.finishedAt = new Date().toISOString()
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(1)
    })
  }, 4000)
}
