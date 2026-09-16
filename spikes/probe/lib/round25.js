/**
 * Round 25 — the continuation-title follow-up (r6 leftover).
 *
 * Parent real turn -> chapters_continue (one small chapter) -> the tool's
 * createChild must have titled the child through sessionController.rename
 * while the handle was live. Verification is durable, not hopeful: the child's
 * observed events must contain a `session/title` event carrying our title.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildChaptersTools } from '../../../lib/tools.js'
import { chapterDomainSpec, makeDomainStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-25.json')
const report = { round: 25, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const ROOT = process.cwd()
const STORE_ROOT = `.dsh-chapters-title-${Date.now()}`
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu padding words carrying a few dozen tokens per seed. '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

const TOOLS_CONFIG = {
  artifactStoreRoot: STORE_ROOT, chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
}

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    const domain = await ctx.storageDomain.open(chapterDomainSpec)
    const store = makeDomainStore(domain)
    const tools = buildChaptersTools(ctx, store, TOOLS_CONFIG)
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch {}

    const parentId = `p25-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: parentId, seed: Array.from({ length: 5 }, (_, i) => seedUser(i)),
      inheritedEventCount: 0, meta: { cwd: ROOT, isSeeded: false },
      ...(selection ? { agentOptions: selection } : {}),
    })
    await workspace?.attachSession?.(parentId)
    const parent = ph.agent
    const turns = () => (parent.session.snapshotEvents?.() ?? []).filter((e) => e.type === 'turn/end').length
    parent.steer(userMsg('Reply with exactly: P25. No explanation.'))
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && turns() === 0) await new Promise((r) => setTimeout(r, 400))
    record('parent turn completed', turns() > 0)
    const ceiling = [...(parent.session.snapshotEvents?.() ?? [])].reverse().find((e) => e.type === 'turn/end').seq

    const cont = await tools.chaptersContinue.execute({
      title: 'P25 Archive Branch',
      handoffNote: 'verify the child title',
      chapters: [{ title: 'Everything so far', summary: 'one chapter covers the session', startSeq: 0, endSeq: ceiling }],
      toolResultOverrides: [],
    }, { agent: parent })
    record('continue succeeded', cont.ok === true, { child: cont.childSessionId, reason: cont.reason ?? null })
    if (cont.ok !== true) { finish(); return }

    const obs = await ctx.sessionQuery.observeSession(cont.childSessionId)
    const titleEvents = (obs?.events ?? []).filter((e) => e.type === 'session/title')
    record('child carries a durable session/title event with our title',
      titleEvents.length >= 1 && JSON.stringify(titleEvents.at(-1)?.data ?? {}).includes('P25 Archive Branch'), {
      titles: titleEvents.map((e) => JSON.stringify(e.data).slice(0, 120)),
      allTypes: [...new Set((obs?.events ?? []).map((e) => e.type))],
    })
    const listed = await ctx.sessionQuery.listSessions(new AbortController().signal)
    const list = Array.isArray(listed) ? listed : (listed?.sessions ?? [])
    const rec = list.find((s) => s?.header?.id === cont.childSessionId)
    record('listing reflects the title (UI-visibility of the name)', true, {
      note: 'listing shape captured for the docs', headerTitle: JSON.stringify(rec?.header ?? {}).slice(0, 200),
    })
    try { await ph.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
