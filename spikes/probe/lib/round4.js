/**
 * dsh-chapters Phase 0 probe, round 4 — the message-source vocabulary.
 *
 * Rounds 1-3 established the create path and two real contract facts (seed must start after the kernel's
 * setup events; user/message needs `role: "user"`). Round 3 then hit the failure mode dsh-session-fork
 * warns about in its format-watch test — "message has invalid source" — which is the closed plugin
 * message-source allowlist, the same one that reportedly bricked 66 stored logs upstream when a source
 * was retired.
 *
 * So: discover empirically which `source` values the kernel accepts for a synthetic user/message, and
 * which rejected with an *unknown* error (meaning: not in the vocabulary) versus a *different* error
 * (meaning: accepted as a source, rejected for another reason). Then, if one works, create the
 * continuation-shaped session and record its id for the verify boot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const IDS = path.join(HOME, 'created-ids.json')
const OUT = path.join(HOME, `results-4-${process.env.PROBE_MODE ?? 'sources'}.json`)
const MODE = process.env.PROBE_MODE ?? 'sources'

const report = { mode: MODE, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }

// Plausible sources, ordered by how likely a harness would define them.
const SOURCES = [
  'user', 'plugin', 'system', 'command', 'agent', 'tool', 'app', 'client', 'cli', 'web', 'dsh',
  'internal', 'harness', 'core', 'session', 'dsh-chapters', 'fork-notice', 'branch-notice', 'unknown', '', null,
]

const TOC_TEXT = [
  '## Conversation TOC',
  '',
  'This session continues an earlier conversation. Chapters hold its history as Markdown.',
  '',
  '### In flight',
  'Phase 0 probe continuation.',
  '',
  '### Chapters',
  '1. [Probe Chapter](spikes/probe/chapter.md) — Synthetic chapter proving the seed shape.',
].join('\n')

const summarize = (entry) => {
  if (!entry) return null
  const events = Array.isArray(entry.events) ? entry.events : (entry.snapshotEvents?.() ?? [])
  const h = entry.header ?? {}
  return {
    events: events.length,
    eventTypes: events.map((e) => `${e.type}@${e.seq}`),
    firstEventData: events.find((e) => e.type === 'user/message')?.data ?? null,
    header: { isSeeded: h.isSeeded, parentSession: h.parentSession ? String(h.parentSession) : null, cwd: h.cwd ?? null },
  }
}

const buildSeed = (seq, source) => {
  const data = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: TOC_TEXT }] }
  if (source !== undefined) data.source = source
  return [{ type: 'user/message', seq, time: Date.now(), data, surfaceOp: 'append' }]
}

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()

    // seed start offset, derived not assumed
    const control = `p4-control-${randomUUID()}`
    let seedStart = 3
    try {
      await ctx.agents.create({ sessionId: control, meta: { cwd } })
      seedStart = summarize(ctx.sessions.get(control))?.events ?? 3
    } catch { /* keep the observed default */ }
    report.notes.push(`seedStart derived = ${seedStart}`)

    const accepted = []
    if (MODE === 'sources') {
      for (const source of SOURCES) {
        const id = `p4-src-${randomUUID()}`
        try {
          await ctx.agents.create({ sessionId: id, seed: buildSeed(seedStart, source), meta: { cwd } })
          accepted.push({ source: String(source), id, summary: summarize(ctx.sessions.get(id)) })
          record(`source ${JSON.stringify(source)}`, true, { verdict: 'ACCEPTED' })
        } catch (error) {
          const message = String(error?.message ?? error)
          const verdict = /invalid source/i.test(message) ? 'source rejected'
            : /not found|schema|missing/i.test(message) ? 'source ok, other failure'
            : 'other'
          record(`source ${JSON.stringify(source)}`, false, { verdict, message })
          if (verdict !== 'source rejected') accepted.push({ source: String(source), verdict, message })
        }
      }
      // try the shape used by real harness code: source on the EVENT, not the data
      for (const where of ['event.source', 'data.via', 'no-source-with-type']) {
        const id = `p4-alt-${randomUUID()}`
        const seed = buildSeed(seedStart, undefined)
        if (where === 'event.source') seed[0].source = 'plugin'
        if (where === 'data.via') seed[0].data.via = 'plugin'
        if (where === 'no-source-with-type') seed[0].data.type = 'user'
        try {
          await ctx.agents.create({ sessionId: id, seed, meta: { cwd } })
          accepted.push({ where, id, verdict: 'ACCEPTED', summary: summarize(ctx.sessions.get(id)) })
          record(`alt shape ${where}`, true, { verdict: 'ACCEPTED' })
        } catch (error) {
          record(`alt shape ${where}`, false, { message: String(error?.message ?? error) })
        }
      }
      report.accepted = accepted
      fs.writeFileSync(path.join(HOME, 'accepted-sources.json'), JSON.stringify(accepted, null, 2))
      report.notes.push('run PROBE_MODE=create with PROBE_SOURCE=<an accepted value> to test restart survival')
    } else {
      const source = process.env.PROBE_SOURCE
      const parsed = source === 'null' ? null : source
      const ids = []
      const a = `p4-cont-${randomUUID()}`
      try {
        await ctx.agents.create({ sessionId: a, seed: buildSeed(seedStart, parsed), meta: { cwd } })
        ids.push({ role: 'continuation', id: a, live: summarize(ctx.sessions.get(a)) })
        record('create continuation with PROBE_SOURCE', true, ids.at(-1))
      } catch (error) {
        record('create continuation with PROBE_SOURCE', false, { message: String(error?.message ?? error) })
      }
      const b = `p4-bare-${randomUUID()}`
      await ctx.agents.create({ sessionId: b, meta: { cwd } }).then(() => {
        ids.push({ role: 'bare', id: b, live: summarize(ctx.sessions.get(b)) })
      }).catch(() => {})
      for (const { id } of ids) { try { await ctx.sessionPersistence.flush?.(ctx.sessions.get(id)) } catch { /* best effort */ } }
      fs.writeFileSync(IDS, JSON.stringify({ ids, seedStart, source: process.env.PROBE_SOURCE, createdAt: new Date().toISOString() }, null, 2))
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
