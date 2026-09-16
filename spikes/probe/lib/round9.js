/** Round 9: read listSessions records correctly (header.id) and confirm prior probe sessions survived. */
import fs from 'node:fs'
import path from 'node:path'
const HOME = '/home/adrian/Projects/dsh-chapter-fork/spikes/probe'
const report = { startedAt: new Date().toISOString(), probes: [] }
const record = (n, ok, d) => report.probes.push({ name: n, ok, ...d })
const prior = ['p7-cont-c1db78c5-bd3b-4b19-92d3-58d016a9a35a']
export const name = 'dsh-chapters-probe'
export const inject = ['sessions', 'sessionQuery', 'sessionPersistence', 'agents']
export function apply(ctx, config) {
  const run = async () => {
    const ac = new AbortController()
    const r = await ctx.sessionQuery.listSessions(ac.signal)
    const list = Array.isArray(r) ? r : (r?.sessions ?? [])
    const ids = list.map((s) => String(s?.header?.id ?? s?.id ?? ''))
    record('listSessions record shape', true, { total: list.length, keys: Object.keys(list[0] ?? {}).sort(), sampleId: ids.slice(0, 3) })
    record('probe sessions ARE listed', ids.some((i) => i.startsWith('p7-') || i.startsWith('p8-')), {
      probeListed: ids.filter((i) => /^(p[789]|probe)-/.test(i)).slice(0, 8),
    })
    for (const id of prior) {
      let obs = null, err = null
      try { obs = await ctx.sessionQuery.observeSession(id) } catch (e) { err = String(e?.message ?? e) }
      const evs = obs?.events ?? obs?.snapshotEvents?.() ?? []
      const msg = evs.find((e) => e.type === 'user/message')
      record(`prior session survived a full restart: ${id.slice(0, 12)}`, evs.length > 0, {
        events: evs.length, hasNotice: Boolean(msg), sourceKind: msg?.data?.source?.kind ?? null,
        title: await ctx.sessionQuery.readTitle?.(id).catch?.(() => null) ?? null, err,
      })
    }
    fs.writeFileSync(path.join(HOME, 'results-9.json'), JSON.stringify(report, null, 2))
    process.exit(0)
  }
  setTimeout(() => run().catch((e) => { report.fatal = String(e?.stack ?? e); fs.writeFileSync(path.join(HOME, 'results-9.json'), JSON.stringify(report, null, 2)); process.exit(1) }), 4000)
}
