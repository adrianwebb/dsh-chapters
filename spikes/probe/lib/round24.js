/**
 * Round 24 — chapters_fork through the real wiring.
 *
 * Parent (real turn) -> chapters_continue (archives two chapters, child A)
 * -> chapters_fork (child B, nothing new archived) -> assertions:
 *   - both children exist, both linked to the parent, same root
 *   - child B's registry state holds no chapters/reservations of its own
 *   - the fork's notice cites the same two chapter paths as the continue's
 *   - the parent's registry accumulated exactly the two archived records
 * One real turn; session creations are durable-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildChaptersTools } from '../../../lib/tools.js'
import { chapterDomainSpec, makeDomainStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-24.json')
const report = { round: 24, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const ROOT = process.cwd()
const STORE_ROOT = `.dsh-chapters-fork-${Date.now()}`
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten padding words here. '
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

    const parentId = `p24-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: parentId, seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
      inheritedEventCount: 0, meta: { cwd: ROOT, isSeeded: false },
      ...(selection ? { agentOptions: selection } : {}),
    })
    await workspace?.attachSession?.(parentId)
    const parent = ph.agent
    const evs = () => parent.session.snapshotEvents?.() ?? []
    const turns = () => evs().filter((e) => e.type === 'turn/end').length
    parent.steer(userMsg('Reply with exactly: P24. No explanation.'))
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && turns() === 0) await new Promise((r) => setTimeout(r, 400))
    record('parent has a completed turn', turns() > 0)
    const ceiling = [...evs()].reverse().find((e) => e.type === 'turn/end').seq

    const cont = await tools.chaptersContinue.execute({
      title: 'P24 continued', handoffNote: 'continue path', toolResultOverrides: [],
      chapters: [
        { title: 'Half one', summary: 'first', startSeq: 0, endSeq: Math.floor(ceiling / 2) },
        { title: 'Half two', summary: 'second', startSeq: Math.floor(ceiling / 2) + 1, endSeq: ceiling },
      ],
    }, { agent: parent })
    record('continue succeeded', cont.ok === true, { child: cont.childSessionId, reason: cont.reason ?? null })
    if (cont.ok !== true) { finish(); return }

    const fork = await tools.chaptersFork.execute(
      { title: 'P24 branch', handoffNote: 'Try the alternative approach; the archive is shared.' },
      { agent: parent },
    )
    record('fork succeeded', fork.ok === true, { child: fork.childSessionId, reason: fork.reason ?? null })
    if (fork.ok !== true) { finish(); return }

    const childB = await store.get(fork.childSessionId)
    const parentState = await store.get(parentId)
    record('forked child cites nothing of its own',
      childB.chapters.length === 0 && Object.keys(childB.reservations).length === 0, { reservations: Object.keys(childB.reservations) })
    record('both children link to the parent, same root',
      childB.parentSession === parentId
      && childB.rootSession === parentState.rootSession
      && (await store.get(cont.childSessionId)).parentSession === parentId, {
      forkParent: childB.parentSession, root: childB.rootSession,
    })
    record('parent accumulated exactly two archived chapters', parentState.chapters.length === 2, {
      numbers: parentState.chapters.map((c) => c.number),
    })

    // Both children's seed notices cite the same two paths (sibling equality).
    const paths = cont.chapters.map((c) => c.path)
    const obsA = await (await ctx.sessionQuery?.observeSession(cont.childSessionId))?.events ?? []
    const obsB = (await ctx.sessionQuery.observeSession(fork.childSessionId)).events ?? []
    const textOf = (events) => (events.find((e) => e.type === 'user/message')?.data?.content ?? [])
      .filter((b) => b.type === 'text').map((b) => b.text).join(' ')
    const tB = textOf(obsB)
    record('fork child notice cites the SAME archive paths', paths.every((p) => tB.includes(p)), {
      paths, snippet: tB.slice(0, 160),
    })
    record('continue child notice also cites them (control)', paths.every((p) => textOf(obsA).includes(p)))

    try { await ph.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
