/**
 * Round 33 — listSessions membership: are plugin-created children in the
 * server list, and what distinguishes their entry from a controller-created
 * one? Prints the child ids seen, and a field-by-field sample of a ch-*
 * header vs the p32 controller child vs a parent. No model tokens.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-33.json')
const report = { round: 33, startedAt: new Date().toISOString(), probes: [], notes: [] }
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

export const name = 'dsh-chapters-probe'
export const inject = ['sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    const listed = await ctx.sessionQuery.listSessions(new AbortController().signal)
    const arr = Array.isArray(listed) ? listed : (listed?.sessions ?? [])
    const ids = arr.map((s) => s?.header?.id)
    const kids = ids.filter((i) => typeof i === 'string' && i.startsWith('ch-'))
    report.probes.push({ name: 'L1 plugin children visible in listSessions', ok: kids.length > 0, seen: kids.slice(0, 6), total: arr.length })
    const kid = arr.find((s) => s?.header?.id === 'ch-3c98d17c-b71e-47f9-b59e-d7e83be71785') ?? arr.find((s) => String(s?.header?.id).startsWith('ch-'))
    const parent = arr.find((s) => String(s?.header?.id).startsWith('p29-')) || arr.find((s) => String(s?.header?.id).startsWith('session-'))
    const p32 = arr.find((s) => String(s?.header?.id).startsWith('p32-'))
    report.notes.push(`kid: ${JSON.stringify(kid)}`.slice(0, 700))
    report.notes.push(`parent: ${JSON.stringify(parent)}`.slice(0, 700))
    report.notes.push(`p32: ${JSON.stringify(p32)}`.slice(0, 700))
    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
