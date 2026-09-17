/**
 * Round 32 — the controller-create + append contract, no model tokens.
 * Does sessionController.create() (a) succeed with cwd+preset, (b) make the
 * session visible to sessionQuery.listSessions (the client's source), (c)
 * leave a lease that lets a plugin resume-and-append the TOC notice? Dump the
 * real method surfaces either way — this is the fact-finding the switch fix
 * depends on.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-32.json')
const report = { round: 32, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'sessionQuery', 'commands']

export function apply(ctx, config) {
  const run = async () => {
    const controller = ctx.get('sessionController')
    record('C0 sessionController present', controller !== undefined, { methods: controller === undefined ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(controller)).slice(0, 16) })
    if (controller === undefined) { finish(); return }
    const id = `p32-${randomUUID().slice(0, 8)}`
    let created = null
    try { created = await controller.create({ sessionId: id, cwd: ROOT, agentPreset: 'chapters' }) }
    catch (e) { report.notes.push(`create threw: ${String(e?.message ?? e)}`) }
    record('C1 controller.create with sessionId+cwd+preset', created !== null, { created: JSON.stringify(created ?? null) })

    const listed = await ctx.sessionQuery.listSessions(new AbortController().signal)
    const arr = Array.isArray(listed) ? listed : (listed?.sessions ?? [])
    record('C2 session appears in listSessions (client visibility)', arr.some((s) => s?.header?.id === id), { total: arr.length })

    const notice = {
      type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append',
      data: { id: randomUUID(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: '# Continuation: probe notice append test' }] }, content: [{ type: 'text', text: '# Continuation: probe notice append test' }] },
    }
    let appended = null, appendErr = null
    try {
      const h = await ctx.agents.resume({ resumeSessionId: id })
      const sess = h.agent.session
      const keys = [...new Set([...Object.getOwnPropertyNames(sess ?? {}), ...Object.getOwnPropertyNames(Object.getPrototypeOf(sess) ?? {})])].filter((k) => !k.startsWith('_')).slice(0, 30)
      report.notes.push(`session surface: ${keys.join(',')}`)
      try {
        appended = await (sess.append?.(notice) ?? sess.appendEvent?.(notice) ?? h.agent.append?.(notice) ?? Promise.reject(new Error('no append-like method')))
      } catch (e) { appendErr = String(e?.message ?? e) }
      await h.dispose?.()
    } catch (e) {
      appendErr = `resume failed: ${String(e?.message ?? e)}`
    }
    record('C3 plugin can append the notice to a controller-created session', appendErr === null, { appended: JSON.stringify(appended ?? null).slice(0, 120), err: appendErr })

    const obs = await ctx.sessionQuery.observeSession(id)
    record('C4 durable check: notice present as seq-0 user/message', (obs?.events ?? []).some((e) => e.seq === 0 && e.type === 'user/message' && JSON.stringify(e.data).includes('chapters:toc')), {
      types: [...new Set((obs?.events ?? []).map((e) => e.type))],
    })
    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
