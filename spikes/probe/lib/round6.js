/**
 * dsh-chapters Phase 0 probe, round 6 — close the open rows.
 *
 * Rounds 1-5 proved a plugin can create a one-event-seeded session that survives process death. Three rows
 * stayed open, two of them because of bugs in my own probe:
 *
 *   1. SIDEBAR LISTING  — listSessions was called wrong (`signal?.throwIfAborted is not a function`), and
 *      round 5 never attached the session to a workspace at all. dsh-session-fork's production path does
 *      `await workspace?.attachSession(childId)` right after create and notes that "an unattached child is
 *      real but invisible in its workspace" (src/index.ts:383-384). That is very likely what round 5 was
 *      seeing: not eviction, just an unattached session.
 *   2. RESUME           — skipped by my own role filter.
 *   3. BOUNDED HEAD     — measurable WITHOUT a model call via tokenMeter, so no token spend is needed for
 *      the structural half of G1.
 *
 * The create call shape is taken from dsh-session-fork/src/index.ts:368-381 rather than guessed again:
 * { sessionId, seed, inheritedEventCount, meta: { cwd, parentSession, isSeeded, agentPreset },
 *   agentOptions, setup }.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const OUT = path.join(HOME, 'results-6.json')
const report = { startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details) => { report.probes.push({ name, ok, ...details }); return report.probes.at(-1) }

const TOC_TEXT = [
  '## Conversation TOC',
  '',
  'This session continues an earlier conversation. Chapters below hold its history as Markdown.',
  '',
  '### In flight', 'Phase 0 round 6 continuation. Rows: sidebar, resume, bounded head.', '',
  '### Chapters', '1. [Probe Chapter](spikes/probe/chapter.md) — Synthetic chapter proving the seed shape.',
  '',
  `校验 marker: ${'integrity-check-' + randomUUID()} — must come back byte-identical after restart`,
].join('\n')

const notice = (seq) => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  surfaceOp: 'append',
  data: {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: TOC_TEXT }] },
    content: [{ type: 'text', text: TOC_TEXT }],
  },
})

const eventsOf = (entry) => (Array.isArray(entry?.events) ? entry.events : (entry?.snapshotEvents?.() ?? []))
const summarize = (entry) => entry ? { events: eventsOf(entry).length, eventTypes: eventsOf(entry).map((e) => `${e.type}@${e.seq}`), header: (({ isSeeded, parentSession, cwd, id }) => ({ isSeeded, parentSession: parentSession ? String(parentSession) : null, cwd: cwd ?? null, id: id ? String(id) : null }))(entry.header ?? {}) } : null

const tryGet = (ctx, name) => { try { return { name, service: ctx.get(name) ?? null } } catch (error) { return { name, error: String(error?.message ?? error).slice(0, 90) } } }

/** Best-effort token measurement; falls back to the chars/4 estimate dsh-session-fork's own fake uses. */
function meter(ctx, text) {
  const tm = ctx.get?.('tokenMeter')
  for (const fn of ['countText', 'count', 'measureText', 'textTokens', 'tokensForText']) {
    if (typeof tm?.[fn] === 'function') {
      try { return { tokens: tm[fn](text), via: `tokenMeter.${fn}` } } catch { /* next */ }
    }
  }
  return { tokens: Math.round(text.length / 4), via: 'chars/4 estimate (tokenMeter method not matched)' }
}

export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents', 'tokenMeter']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()

    // ---------------------------------------- 1. service discovery
    const discovered = ['workspace', 'workspaces', 'workspaceRegistry', 'workspaceController', 'agentDefaultModel', 'agentPresets', 'sessionController', 'systemPrompt', 'tokenMeter']
      .map((n) => { const r = tryGet(ctx, n); return { name: n, present: Boolean(r.service), surface: r.service ? Object.getOwnPropertyNames(Object.getPrototypeOf(r.service) ?? {}).sort().slice(0, 14) : r.error } })
    record('service discovery', true, { discovered })

    // ---------------------------------------- 2. create, properly shaped
    const childId = `p6-cont-${randomUUID()}`
    let created = false
    try {
      await ctx.agents.create({
        sessionId: childId,
        seed: [notice(0)],
        inheritedEventCount: 0,        // our seed is the child's OWN history, not inherited content
        meta: { cwd, isSeeded: false },
      })
      created = true
      record('create continuation (production call shape)', true, { childId, live: summarize(ctx.sessions.get(childId)) })
    } catch (error) {
      record('create continuation (production call shape)', false, { message: String(error?.message ?? error) })
    }

    // ---------------------------------------- 3. attach to a workspace
    for (const svc of ['workspaces', 'workspaceRegistry', 'workspace']) {
      const w = tryGet(ctx, svc).service
      if (!w) continue
      const list = typeof w?.list === 'function' ? [...(w.list() ?? [])] : []
      const target = list[0] ?? (typeof w?.get === 'function' ? w.get(cwd) : undefined)
      const attach = target?.attachSession ?? w?.attachSession
      if (typeof attach !== 'function') { record(`attach via ${svc}`, false, { note: 'no attachSession', workspaces: list.length, surface: Object.getOwnPropertyNames(Object.getPrototypeOf(target ?? w) ?? {}).slice(0, 12) }); continue }
      try {
        await (target ? attach.call(target, childId) : attach.call(w, childId))
        record(`attach via ${svc}`, true, { attached: true, workspaceCount: list.length })
      } catch (error) {
        record(`attach via ${svc}`, false, { message: String(error?.message ?? error) })
      }
      break
    }

    // ---------------------------------------- 4. listability, called correctly
    const ac = new AbortController()
    for (const call of [
      ['listSessions({ signal })', () => ctx.sessionQuery.listSessions({ signal: ac.signal })],
      ['listSessions({ cwd, signal })', () => ctx.sessionQuery.listSessions({ cwd, signal: ac.signal })],
      ['listSessions()', () => ctx.sessionQuery.listSessions()],
    ]) {
      try {
        const r = await call[1]()
        const list = Array.isArray(r) ? r : (r?.sessions ?? [])
        const mine = list.filter((s) => String(s?.id ?? s).startsWith('p6-') || String(s?.id ?? '').startsWith('p6-'))
        record(`listSessions ${call[0]}`, true, { total: list.length, probeListed: mine.map((s) => ({ id: String(s?.id ?? s), title: s?.title ?? null, cwd: s?.cwd ?? null })) })
        break
      } catch (error) {
        record(`listSessions ${call[0]}`, false, { message: String(error?.message ?? error).slice(0, 120) })
      }
    }

    // ---------------------------------------- 5. resume
    if (created) {
      for (const [label, fn] of [['agents.resume(id)', () => ctx.agents.resume?.(childId)], ['agents.resume({sessionId})', () => ctx.agents.resume?.({ sessionId: childId })]]) {
        if (typeof ctx.agents.resume !== 'function') { record('agents.resume exists', false, { note: 'method absent' }); break }
        try {
          const h = await fn()
          record(`resume ${label}`, true, { handle: h ? Object.keys(h).sort() : null, live: summarize(ctx.sessions.get(childId)) })
          break
        } catch (error) { record(`resume ${label}`, false, { message: String(error?.message ?? error).slice(0, 140) }) }
      }
    }

    // ---------------------------------------- 6. content integrity round-trip
    if (created) {
      try { await ctx.sessionPersistence.flush?.(ctx.sessions.get(childId)) } catch { /* best effort */ }
      const obs = await ctx.sessionQuery.observeSession(childId)
      const msgs = (obs?.events ?? obs?.snapshotEvents?.() ?? []).filter((e) => e.type === 'user/message')
      const text = msgs[0]?.data?.content?.find?.((b) => b.type === 'text')?.text ?? null
      record('content survives read-back', text === TOC_TEXT, {
        byteIdentical: text === TOC_TEXT,
        sourceKind: msgs[0]?.data?.source?.kind ?? null,
        sourceForm: msgs[0]?.data?.source?.form ?? null,
        sectionsPreserved: Array.isArray(msgs[0]?.data?.source?.sections),
        preview: text?.slice(0, 60),
      })
    }

    // ---------------------------------------- 7. bounded head, no token spend
    // A "parent" transcript of equivalent content, so the compression factor is measured, not asserted.
    const transcript = Array.from({ length: 12 }, (_, i) => [
      `**User:** Question ${i} about the migration runner and how ordering is resolved.`,
      `**Assistant:** Answer ${i}. ${'Explanation of the reasoning and the code changes involved. '.repeat(12)}`,
    ].join('\n')).join('\n\n')
    const tocM = meter(ctx, TOC_TEXT)
    const fullM = meter(ctx, transcript)
    record('bounded head (structural proxy for G1)', tocM.tokens < fullM.tokens, {
      tocTokens: tocM.tokens, via: tocM.via, fullTranscriptTokens: fullM.tokens,
      reductionFactor: +(fullM.tokens / Math.max(1, tocM.tokens)).toFixed(1),
      note: 'structural only: no provider round-trip, so this is not the cached-prefix measurement',
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
