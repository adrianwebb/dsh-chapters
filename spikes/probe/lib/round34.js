/**
 * Round 34 — does resolveAgent() on the session-controller promote a
 * plugin-created session into the controller's own list (the set the browser
 * sidebar actually shows)? agents.create a tiny child -> controller.list
 * (before) -> controller.resolveAgent(child) + dispose -> controller.list
 * (after). No model turns.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-34.json')
const report = { round: 34, startedAt: new Date().toISOString(), probes: [], notes: [] }
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'sessionController']

export function apply(ctx, config) {
  const run = async () => {
    const controller = ctx.get('sessionController')
    const id = `p34-${randomUUID().slice(0, 8)}`
    const handle = await ctx.agents.create({
      sessionId: id, seed: [{ type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append',
        data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'p34 probe child' }] } }],
      inheritedEventCount: 0, meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters' },
    })
    await handle.dispose?.()
    const tryList = async (label) => {
      try {
        const l = await controller.list({})
        const arr = Array.isArray(l) ? l : (l?.sessions ?? [])
        const ids = arr.map((s) => s?.header?.id ?? s?.id)
        report.notes.push(`${label}: ${ids.length} ids, has child: ${ids.includes(id)}`)
        return ids
      } catch (e) { report.notes.push(`${label} threw: ${String(e?.message ?? e).slice(0, 140)}`); return null }
    }
    await tryList('list BEFORE resolveAgent')
    try {
      const r = await controller.resolveAgent(id)
      report.notes.push(`resolveAgent ok: ${JSON.stringify(Object.keys(r ?? {})).slice(0, 120)}`)
      if (r?.agent !== undefined) await r.agent.dispose?.()
      else if (typeof r?.dispose === 'function') await r.dispose()
    } catch (e) { report.notes.push(`resolveAgent threw: ${String(e?.message ?? e).slice(0, 200)}`) }
    const after = await tryList('list AFTER resolveAgent')
    report.probes.push({ name: 'P34 resolveAgent promotes plugin child into controller list', ok: after !== null && after.includes(id) })
    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
