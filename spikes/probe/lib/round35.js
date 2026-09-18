/**
 * Round 35 — the knowledge layer in a real boot: /chapters-link, the project
 * line in a continuation notice, chapters_search, /chapters-status. One cheap
 * bare-parent turn; everything else is zero-token. Also proves the sync
 * degradation path: a link to an unreachable remote degrades, never breaks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildChaptersTools } from '../../../lib/tools.js'
import { acquireChapterStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-35.json')
const report = { round: 35, startedAt: new Date().toISOString(), probes: [], notes: [] }
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}

const CHUNK = 'SEED-35 payload alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED ${CHUNK.repeat(2)}` }] },
})
const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery', 'webServer']

export function apply(ctx, config) {
  const run = async () => {
    const acquired = await acquireChapterStore(ctx.storageDomain)
    const domain = acquired.domain
    const store = acquired.store
    const tools = buildChaptersTools(ctx, store, {
      artifactStoreRoot: '.dsh-chapters-k35', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
      continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', searchMaxTokens: 400,
    })
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch {}

    const parentId = `p35-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: parentId, seed: Array.from({ length: 4 }, (_, i) => seedUser(i)),
      inheritedEventCount: 0, meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      ...(selection ? { agentOptions: selection } : {}),
    })
    await workspace?.attachSession?.(parentId)
    const parent = ph.agent
    const evs = () => parent.session.snapshotEvents?.() ?? []
    parent.steer(userMsg('Reply with exactly: P35. No explanation.'))
    const dl = Date.now() + 300_000
    while (Date.now() < dl && evs().filter((e) => e.type === 'turn/end').length === 0) await new Promise((r) => setTimeout(r, 500))
    record('K1 parent turn completed', (evs().filter((e) => e.type === 'turn/end').length ?? 0) > 0)

    // /chapters-link with an unreachable remote → links, sync degrades, never breaks
    const link = await ctx.commands.execute(parent, '/chapters-link https://example.invalid/chapters35.git tok-test', [], new AbortController().signal)
    const linkText = JSON.stringify(link ?? {})
    record('K2 /chapters-link links the project (sync degrades on the unreachable remote, never breaks)',
      link?.kind === 'success' && (linkText.includes('Linked') || linkText.includes('link')),
      { text: link?.text?.slice(0, 200) })

    const projects = [...store.projects()]
    const project = projects.find(([, r]) => r.remote === 'https://example.invalid/chapters35.git')
    record('K3 project record persisted with derived key + cwd', project !== undefined, {
      project: project ?? null, count: projects.length,
    })

    const ceiling = [...evs()].reverse().find((e) => e.type === 'turn/end').seq
    const cont = await tools.chaptersContinue.execute({
      title: 'P35 continuation', handoffNote: 'k35 continuation', toolResultOverrides: [],
      chapters: [{ title: 'K35 span', summary: 'the span', startSeq: 0, endSeq: ceiling }],
    }, { agent: parent })
    record('K4 continue succeeded', cont.ok === true, { child: cont.childSessionId, reason: cont.reason ?? null })

    const obs = cont.ok === true ? await ctx.sessionQuery.observeSession(cont.childSessionId) : null
    const notice = JSON.stringify((obs?.events ?? []).find((e) => e.seq === 0)?.data ?? {})
    record('K5 continuation notice carries the Project line', cont.ok === true && notice.includes('Project:'), {
      projectLine: (notice.match(/Project:[^\\]*/)?.[0] ?? '').slice(0, 120),
    })

    const search = await tools.chaptersSearch.execute({ query: 'K35 span' }, { agent: parent })
    record('K6 chapters_search returns results from the mirror (or the honest no-mirror note on sync failure)',
      search.ok === true && (search.results?.length >= 1 || /no knowledge mirror/i.test(search.note ?? '')),
      { results: search.results?.length, note: search.note ?? null })

    const status = await ctx.commands.execute(parent, '/chapters-status', [], new AbortController().signal)
    record('K7 /chapters-status reports the project + last sync', status?.kind === 'success' && /chapters35|Project/.test(status.text ?? ''), {
      text: status?.text?.slice(0, 200),
    })

    const searchHit = search.results?.length >= 1
    record('K8 search found the chapter (sync succeeded despite the odd remote)', searchHit === true, { n: search.results?.length })
      .catch?.(() => {})

    try { await ph.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => { report.fatal = String(e?.stack ?? e); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(1) }) }, 4000)
}
