/**
 * dsh-chapters Phase 0 probe, round 2.
 *
 * Round 1 (preserved in lib/index.round1.js, results in results.json) answered the headline question —
 * an unseeded `agents.create` produces a live, discoverable session — but it also REFUTED two things our
 * own docs asserted, and one of its conclusions was invalid:
 *
 *   1. `ctx.sessions.fork` DOES exist host-side (with `_forkSeed` and `_resolveForkSource`). Our docs
 *      claimed there was no host-side fork API at all. Invariant 2 survives — but on measured grounds
 *      rather than on a claim about API absence, which is the better footing anyway.
 *   2. Round 1's "continuity IS validated" note was wrong: the seed was rejected for a message-shape
 *      reason ("lacks an identified message") that fires before any seq check. So continuity is untested.
 *
 * This round: read the real signatures, discover the accepted user/message shape empirically, test
 * continuity with that shape, and MEASURE what host-side fork copies.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const OUT = process.env.DSH_CHAPTERS_PROBE_OUT
  ?? '/home/adrian/Projects/dsh-chapter-fork/spikes/probe/results-2.json'

const report = { startedAt: new Date().toISOString(), dshHome: process.env.DSH_HOME ?? '(unset)', probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }
const src = (fn, limit = 1000) => {
  try { return Function.prototype.toString.call(fn).slice(0, limit) } catch { return null }
}
const shapes = (text) => ({
  'bare content': { content: [{ type: 'text', text }] },
  id: { id: randomUUID(), content: [{ type: 'text', text }] },
  uuid: { uuid: randomUUID(), content: [{ type: 'text', text }] },
  'role+content': { role: 'user', content: [{ type: 'text', text }] },
  'role+id+content': { role: 'user', id: randomUUID(), content: [{ type: 'text', text }] },
  messageId: { messageId: randomUUID(), content: [{ type: 'text', text }] },
  'message array': { message: [{ type: 'text', text }] },
  'text field': { text },
})
const ev = (seq, data) => ({ type: 'user/message', seq, time: Date.now(), data, surfaceOp: 'append' })
const eventCount = (entry) => {
  if (!entry) return null
  if (Array.isArray(entry.events)) return entry.events.length
  try { return entry.snapshotEvents?.()?.length ?? null } catch { return null }
}
const headerOf = (entry) => {
  const h = entry?.header
  if (!h) return null
  return {
    isSeeded: h.isSeeded,
    parentSession: h.parentSession ? String(h.parentSession) : null,
    cwd: h.cwd ?? null,
    keys: Object.keys(h).sort(),
  }
}

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents', 'storageDomain']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()

    // ------------------------------------------------- 1. real signatures
    record('signatures', true, {
      fork_arity: ctx.sessions.fork?.length,
      fork_src: src(ctx.sessions.fork, 1400),
      forkSeed_src: src(ctx.sessions._forkSeed, 1200),
      resolveForkSource_src: src(ctx.sessions._resolveForkSource, 600),
      sessions_create_src: src(ctx.sessions.create, 600),
      agents_create_src: src(ctx.agents.create, 900),
    })

    // ------------------------------- 2. discover the accepted user/message
    const accepted = []
    for (const [label, data] of Object.entries(shapes('probe continuation TOC'))) {
      const id = `p2-shape-${randomUUID()}`
      try {
        await ctx.agents.create({ sessionId: id, seed: [ev(0, data)], meta: { cwd } })
        const entry = ctx.sessions.get(id)
        accepted.push({ label, id, events: eventCount(entry), header: headerOf(entry) })
      } catch (error) {
        record('seed shape rejected', false, { label, message: String(error?.message ?? error) })
      }
    }
    record('accepted seed shapes', accepted.length > 0, { accepted })
    const goodShape = accepted[0] ? shapes('x')[accepted[0].label] : null
    if (!goodShape) report.notes.push('no user/message shape was accepted; cannot test continuity or seeding')

    // ----------------------------- 3. continuity, now that shape is known
    if (goodShape) {
      const bad = `p2-seq7-${randomUUID()}`
      try {
        await ctx.agents.create({ sessionId: bad, seed: [ev(7, goodShape)], meta: { cwd } })
        report.notes.push('continuity: a seed starting at seq 7 was ACCEPTED — seqs are NOT validated as we assumed')
        record('seed at seq 7', true, { accepted: true, events: eventCount(ctx.sessions.get(bad)), header: headerOf(ctx.sessions.get(bad)) })
      } catch (error) {
        report.notes.push(`continuity: seq-7 seed rejected — "${error?.message}". Our continuity assumption holds.`)
        record('seed at seq 7', false, { rejected: true, message: String(error?.message ?? error) })
      }
      const two = `p2-two-${randomUUID()}`
      try {
        await ctx.agents.create({ sessionId: two, meta: { cwd }, seed: [ev(0, goodShape), ev(1, goodShape)] })
        record('two-event contiguous seed', true, { events: eventCount(ctx.sessions.get(two)) })
      } catch (error) {
        record('two-event contiguous seed', false, { message: String(error?.message ?? error) })
      }
    }

    // ---------------------------- 4. invariant 2, measured rather than read
    const parentId = `p2-parent-${randomUUID()}`
    try {
      const parentHandle = await ctx.agents.create({ sessionId: parentId, meta: { cwd }, seed: goodShape ? [ev(0, goodShape)] : undefined })
      const parentEvents = eventCount(ctx.sessions.get(parentId))
      let child = null, childErr = null
      try {
        child = await ctx.sessions.fork(parentId)
      } catch (e1) {
        try { child = await ctx.sessions.fork({ sessionId: parentId }) } catch (e2) { childErr = `${e1?.message} | ${e2?.message}` }
      }
      if (childErr) record('host-side fork', false, { message: childErr })
      else {
        const childId = String(typeof child === 'string' ? child : (child?.sessionId ?? child?.id ?? child))
        const before = parentEvents, after = eventCount(ctx.sessions.get(childId))
        record('host-side fork', true, {
          returned: typeof child, childId, parentEvents: before, childEvents: after,
          childHeader: headerOf(ctx.sessions.get(childId)),
          copiedParentLog: typeof before === 'number' && typeof after === 'number' && after > before,
        })
        if (typeof before === 'number' && typeof after === 'number' && after > before) {
          report.notes.push(`MEASURED: host-side fork copies the parent log (${before} -> ${after} events). Seeding a continuation from it would grow context, exactly as invariant 2 warns.`)
        } else if (typeof before === 'number' && typeof after === 'number') {
          report.notes.push(`MEASURED: host-side fork did NOT copy the parent log (${before} -> ${after}). Invariant 2 is not what we thought.`)
        }
      }
      void parentHandle
    } catch (error) {
      record('parent setup for fork', false, { message: String(error?.message ?? error) })
    }

    // ---------------------------------- 5. listing, durability, cleanup
    try {
      const listed = await ctx.sessionQuery.listSessions?.({})
      const ids = Array.isArray(listed) ? listed.map((s) => String(s?.id ?? s)) : null
      record('listSessions', true, { count: ids?.length ?? typeof listed, probeSessionsListed: ids?.filter((i) => i.startsWith('p2-')).length })
    } catch (error) {
      record('listSessions', false, { message: String(error?.message ?? error) })
    }
    try {
      const dirs = path.join(process.env.DSH_HOME, 'sessions')
      const buckets = fs.readdirSync(dirs)
      const perBucket = {}
      for (const b of buckets.slice(0, 6)) {
        try { perBucket[b] = fs.readdirSync(path.join(dirs, b)).length } catch { perBucket[b] = 'unreadable' }
      }
      record('on-disk layout', true, { buckets, perBucket })
    } catch (error) {
      record('on-disk layout', false, { message: String(error?.message ?? error) })
    }

    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  }
  setTimeout(() => {
    run().catch((error) => {
      report.fatal = String(error?.stack ?? error)
      fs.mkdirSync(path.dirname(OUT), { recursive: true })
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(1)
    })
  }, 4000)
}
