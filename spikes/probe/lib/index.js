/**
 * dsh-chapters Phase 0 probe.
 *
 * Mounts into a SCRATCH profile (never the live one), runs the load-bearing experiment during boot,
 * writes findings to JSON, then exits the process so the run is scriptable.
 *
 * The question it exists to answer, from AGENTS.md: can a plugin create a session whose seed is a single
 * synthetic event — and is that session durable, discoverable, and re-readable — without going through
 * DSH's native fork, which copies the parent's whole log (commands.ts:260 `seed: source.events.slice(0, cut)`)?
 *
 * Nothing here mutates production state: sessions are created in the scratch DSH_HOME only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const OUT = process.env.DSH_CHAPTERS_PROBE_OUT
  ?? '/home/adrian/Projects/dsh-chapter-fork/spikes/probe/results.json'

const report = {
  startedAt: new Date().toISOString(),
  dshHome: process.env.DSH_HOME ?? '(unset)',
  cwd: process.cwd(),
  probes: [],
  notes: [],
}

const record = (name, ok, details) => {
  report.probes.push({ name, ok, ...safe(details) })
  return report.probes.at(-1)
}

/** Never let a getter or a circular ref lose the whole run. */
function safe(value, depth = 0) {
  try {
    if (value === null || typeof value !== 'object') return { value: String(value) }
    if (depth > 3) return { truncated: true }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') out[k] = safe(v, depth + 1)
      else if (typeof v === 'function') out[k] = `[fn ${v.name || 'anonymous'}]`
      else out[k] = v
    }
    return out
  } catch (error) {
    return { unserializable: String(error?.message ?? error) }
  }
}

const surfaceOf = (obj) => {
  if (obj === undefined || obj === null) return null
  const names = new Set()
  let target = obj
  while (target && target !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(target)) names.add(key)
    target = Object.getPrototypeOf(target)
  }
  return [...names].sort().filter((k) => typeof obj[k] === 'function')
}

const keyList = (obj) => (obj ? Object.keys(obj).sort() : null)

function newUserMessage(text) {
  // Two plausible shapes; probe both rather than guessing which the contract wants.
  return { content: [{ type: 'text', text }] }
}

function noticeEvent(seq, data) {
  return { type: 'user/message', seq, time: Date.now(), data, surfaceOp: 'append' }
}

function findSessionLogs() {
  const root = path.join(process.env.DSH_HOME ?? '', 'sessions')
  try {
    return fs.readdirSync(root).slice(0, 40)
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

export const name = 'dsh-chapters-probe'

export const inject = [
  'sessions', 'sessionPersistence', 'sessionQuery', 'agents', 'storageDomain', 'tools',
]

export function apply(ctx, config) {
  // Deliberately driven off a timer rather than an assumed cordis lifecycle hook: the probe must not
  // depend on knowing the right start() signature to run. Long delay so every bundle has mounted.
  const run = async () => {

    try {
      // ---------------------------------------------------------- surface
      record('ctx surface', true, {
        ctxKeys: (keyList(ctx) ?? []).slice(0, 60),
        agents: surfaceOf(ctx.agents),
        sessions: surfaceOf(ctx.sessions),
        sessionPersistence: surfaceOf(ctx.sessionPersistence),
        sessionQuery: surfaceOf(ctx.sessionQuery),
      })

      // ------------------------------------------------------ probe A: unseeded
      const idA = `probe-unseeded-${randomUUID()}`
      let a
      try {
        a = await ctx.agents.create({ sessionId: idA })
        record('A unseeded create', true, {
          idA,
          handleKeys: keyList(a),
          agentId: a?.agent?.id ? String(a.agent.id) : undefined,
        })
      } catch (error) {
        record('A unseeded create', false, { message: String(error?.message ?? error) })
      }

      // ------------------------------------------- probe B: one synthetic event
      const idB = `probe-seeded-${randomUUID()}`
      let b
      try {
        b = await ctx.agents.create({
          sessionId: idB,
          seed: [noticeEvent(0, newUserMessage('## Conversation TOC\n\nprobe continuation seed'))],
        })
        record('B single-event seed at seq 0', true, { idB, handleKeys: keyList(b) })
      } catch (error) {
        record('B single-event seed at seq 0', false, { message: String(error?.message ?? error) })
      }

      // --------------------------------------- probe C: seed continuity check
      // If a NON-contiguous seed is accepted, the kernel is not validating seqs and our
      // assumption that continuity must be right is weaker than the docs claim.
      const idC = `probe-badseed-${randomUUID()}`
      try {
        await ctx.agents.create({
          sessionId: idC,
          seed: [noticeEvent(7, newUserMessage('deliberately non-contiguous seed'))],
        })
        report.notes.push('C: kernel ACCEPTED a seed starting at seq 7 — no continuity validation observed')
        record('C non-contiguous seed', true, { idC, accepted: true })
      } catch (error) {
        report.notes.push('C: kernel rejected the non-contiguous seed, so continuity IS validated')
        record('C non-contiguous seed', false, { rejected: true, message: String(error?.message ?? error) })
      }

      // -------------------------------------------- probe D: live visibility
      for (const [label, id] of [['A', idA], ['B', idB], ['C', idC]]) {
        let live
        try {
          live = ctx.sessions.get(id)
        } catch (error) {
          live = { threw: String(error?.message ?? error) }
        }
        record(`D${label} ctx.sessions.get`, Boolean(live && !live.threw), {
          id, found: Boolean(live && !live.threw),
          eventCount: live?.events?.length ?? live?.snapshotEvents?.()?.length,
          header: live?.header ? { isSeeded: live.header.isSeeded, parentSession: live.header.parentSession ? String(live.header.parentSession) : null, cwd: live.header.cwd } : null,
        })
      }

      // ----------------------------------------- probe E: durable + listed
      await Promise.all([idA, idB].map(async (id) => {
        try { await ctx.sessionPersistence?.flush?.(ctx.sessions.get(id)?.session ?? id) } catch { /* best effort */ }
      }))
      const logs = findSessionLogs()
      record('E session log dir', true, { count: Array.isArray(logs) ? logs.length : logs, sample: Array.isArray(logs) ? logs.slice(0, 6) : logs })

      const observation = {}
      for (const [label, id] of [['A', idA], ['B', idB]]) {
        try {
          const observed = await ctx.sessionQuery?.observeSession?.(id)
          observation[label] = observed
            ? { events: observed.events?.length ?? observed.snapshotEvents?.()?.length, hasPreset: Boolean(observed.projections?.values?.agentPreset ?? observed.agentPreset) }
            : null
        } catch (error) {
          observation[label] = { error: String(error?.message ?? error) }
        }
      }
      record('E observeSession after create', true, observation)

      // ------------------------------------------- probe F: fork semantics
      // Confirm the thing invariant 2 forbids, by observing the fork handler's seed shape.
      try {
        const forked = await ctx.sessions.fork?.({ sessionId: idA })
        record('F ctx.sessions.fork host-side', forked ? true : false, { result: forked ? String(forked) : 'service absent' })
      } catch (error) {
        record('F ctx.sessions.fork host-side', false, { message: String(error?.message ?? error) })
      }
    } catch (error) {
      report.fatal = String(error?.stack ?? error)
    }

    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
