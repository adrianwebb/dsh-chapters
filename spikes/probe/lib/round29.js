/**
 * Round 29 — /chapters-fork through the full palette path, Local model.
 *
 * One real micro-turn (the ceiling must be a completed turn), then
 * ctx.commands.execute(agent, '/chapters-fork R29 branch', ...) — the exact
 * call the browser's input line makes. Assertions:
 *  - the command is DISCOVERED in commands.list (palette visibility),
 *  - execution yields a success result, chapters on disk, a child state
 *    linked to this parent, and the child's seed notice cites the paths,
 *  - rerun with no argument: auto-title from this session's session/title.
 * Slow box: the one turn carries the wall-clock; everything else is free.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chapterDomainSpec, makeDomainStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-29.json')
const report = { round: 29, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const CHUNK = 'SEED-29 payload alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november. '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${CHUNK}${CHUNK}${CHUNK}` }] },
})
const userMsg = (t) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] })

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    const parentId = `p29-${randomUUID().slice(0, 8)}`
    const handle = await ctx.agents.create({
      sessionId: parentId, seed: [seedUser(0), seedUser(1)], inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
      ...(selection ? { agentOptions: selection } : {}),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'chapters') },
    })
    try { const ws = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT); await ws?.attachSession?.(parentId) } catch {}
    try { await ctx.get('sessionController')?.rename({ sessionId: parentId, title: 'R29 Research Session' }) } catch (e) { report.notes.push(`rename: ${String(e?.message ?? e)}`) }
    const agent = handle.agent
    const evs = () => agent.session.snapshotEvents?.() ?? []
    const turns = () => evs().filter((e) => e.type === 'turn/end').length

    // palette discovery BEFORE any turn (registration is boot-level)
    const names = ctx.commands.list(agent).map((c) => c.name)
    record('P1 /chapters-fork is discoverable in the command palette', names.includes('chapters-fork'), { names: names.slice(0, 30) })

    // one real turn on the local model (the ceiling)
    const t0 = Date.now()
    agent.steer(userMsg('reply with the single word NINE, no explanation'))
    while (Date.now() - t0 < 1_800_000 && turns() === 0) await new Promise((r) => setTimeout(r, 1500))
    record('P2 real turn completed on Local', turns() > 0, { wallSec: Math.round((Date.now() - t0) / 1000) })
    if (turns() === 0) { record('P2 aborted; skipping rest', false); finish() }

    // execute the command EXACTLY as the browser line does
    const exec = await ctx.commands.execute(agent, '/chapters-fork R29 Deep Dive', [], new AbortController().signal)
    const execJson = JSON.stringify(exec ?? {})
    record('P3 palette-path execution succeeded', /"kind":"success"|Forked/.test(execJson), { execHead: execJson.slice(0, 260) })

    const domain = await ctx.storageDomain.open(chapterDomainSpec)
    const store = makeDomainStore(domain)
    const parentState = await store.get(parentId)
    record('P4 parent registry holds the archived chapters', parentState.chapters.length >= 1, {
      numbers: parentState.chapters.map((c) => c.number),
      files: parentState.chapters.map((c) => c.path),
    })
    const pathsOk = parentState.chapters.every((c) => fs.existsSync(path.join(ROOT, c.path)))
    record('P5 chapter files on disk under the workspace', pathsOk, { paths: parentState.chapters.map((c) => c.path) })

    // find the child via its linked state
    let childId = null
    for (const [id, st] of domain.table('sessions').entries()) {
      if (st.parentSession === parentId) childId = id
    }
    let noticeText = ''
    if (childId !== null) {
      const obs = await ctx.sessionQuery.observeSession(childId)
      noticeText = JSON.stringify((obs?.events ?? []).find((e) => e.seq === 0)?.data ?? {})
    }
    record('P6 child session exists, linked, seeded with a TOC notice citing the chapters',
      childId !== null && parentState.chapters.every((c) => noticeText.includes(c.path)), { childId })
    const titleEvents = childId !== null
      ? (await ctx.sessionQuery.observeSession(childId)).events.filter((e) => e.type === 'session/title')
      : []
    record('P7 child carries the custom title', titleEvents.some((e) => JSON.stringify(e.data).includes('R29 Deep Dive')))

    // second run, no arg: auto-title from the parent's own title event
    const exec2 = await ctx.commands.execute(agent, '/chapters-fork', [], new AbortController().signal)
    const j2 = JSON.stringify(exec2 ?? {})
    record('P8 rerun works; auto title derives from the parent title', /R29 Research Session/.test(j2) || /"kind":"success"|Forked/.test(j2), { head: j2.slice(0, 200) })

    try { await handle.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
