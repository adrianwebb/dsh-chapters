/**
 * dsh-chapters Phase 0 probe, round 5.
 *
 * Rounds 1-4 narrowed the create path to one remaining fact: `data.source` is NOT a string. Reading the
 * host's real session logs showed it is a discriminated object — `{kind: "user"}`, and for plugin-authored
 * content `{kind: "plugin", plugin: "<bundle id>", form: "snapshot", sections: [...]}`.
 *
 * That discovery is bigger than the bug in my probe. It shows DSH already injects new context into a live
 * session by APPENDING a plugin-sourced user/message (see the `agent-instructions` events carrying AGENTS.md
 * digests and `changes` records) rather than rewriting a prefix. Which is precisely the mechanic this
 * plugin needs for its TOC notice, with a sanctioned shape to copy.
 *
 * This round tests the candidate source objects and, if one is accepted, records the session for the
 * restart-survival verify boot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const IDS = path.join(HOME, 'created-ids.json')
const OUT = path.join(HOME, 'results-5.json')

const report = { startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }) }

const TOC_TEXT = [
  '## Conversation TOC',
  '',
  'This session continues an earlier conversation. Chapters below hold its history as Markdown.',
  '',
  '### In flight', 'Phase 0 probe continuation.', '',
  '### Chapters', '1. [Probe Chapter](spikes/probe/chapter.md) — Synthetic chapter proving the seed shape.',
].join('\n')

const candidates = {
  user: { kind: 'user' },
  'plugin-snapshot': {
    kind: 'plugin', plugin: 'dsh-chapters-probe', form: 'snapshot',
    sections: [{ name: 'chapters:toc', text: TOC_TEXT }],
  },
  'plugin-plain': { kind: 'plugin', plugin: 'dsh-chapters-probe' },
  'plugin-form-message': { kind: 'plugin', plugin: 'dsh-chapters-probe', form: 'message' },
  'plugin-content-sections': {
    kind: 'plugin', plugin: 'dsh-chapters-probe', form: 'snapshot',
    sections: [{ name: 'toc', text: 'snapshot text' }],
  },
}

const summarize = (entry) => {
  if (!entry) return null
  const events = Array.isArray(entry.events) ? entry.events : (entry.snapshotEvents?.() ?? [])
  const h = entry.header ?? {}
  const msg = events.find((e) => e.type === 'user/message')
  return {
    events: events.length,
    eventTypes: events.map((e) => `${e.type}@${e.seq}`),
    userMessage: msg ? { seq: msg.seq, surfaceOp: msg.surfaceOp, dataKeys: Object.keys(msg.data).sort(), source: msg.data.source, contentBlocks: msg.data.content?.length } : null,
    header: { isSeeded: h.isSeeded, parentSession: h.parentSession ? String(h.parentSession) : null, cwd: h.cwd ?? null },
  }
}

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()
    const control = `p5-control-${randomUUID()}`
    // Round 4 corrected this: the kernel's own setup events are NOT part of the caller's seed, so the
    // seed must begin at 0 regardless of what a fresh session later contains.
    const seedStart = 0
    const controlId = `p5-control-${randomUUID()}`
    try {
      await ctx.agents.create({ sessionId: controlId, meta: { cwd } })
      report.notes.push(`control session (no seed) now holds ${summarize(ctx.sessions.get(controlId))?.events} events: ${summarize(ctx.sessions.get(controlId))?.eventTypes?.join(', ')}`)
    } catch (error) { report.notes.push(`control create failed: ${error?.message}`) }

    const winners = []
    for (const [label, source] of Object.entries(candidates)) {
      const id = `p5-${label}-${randomUUID()}`
      const seed = [{
        type: 'user/message', seq: seedStart, time: Date.now(), surfaceOp: 'append',
        data: { id: randomUUID(), role: 'user', source, content: [{ type: 'text', text: TOC_TEXT }] },
      }]
      try {
        await ctx.agents.create({ sessionId: id, seed, meta: { cwd } })
        const summary = summarize(ctx.sessions.get(id))
        winners.push({ label, id, summary })
        record(`source ${label}`, true, { accepted: true, id, summary })
      } catch (error) {
        record(`source ${label}`, false, { message: String(error?.message ?? error) })
      }
    }
    report.winners = winners.map(({ label, id }) => ({ label, id }))

    if (winners.length) {
      // also test the TOC as a snapshot-only message (no text content blocks) vs text
      const w = winners[0]
      try { await ctx.sessionPersistence.flush?.(ctx.sessions.get(w.id)) } catch { /* best effort */ }
      fs.writeFileSync(IDS, JSON.stringify({ ids: winners.map((x) => ({ role: `source:${x.label}`, id: x.id, live: x.summary })), seedStart, createdAt: new Date().toISOString() }, null, 2))
      report.notes.push(`recorded ${winners.length} surviving candidates for PROBE_MODE=verify`)
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
