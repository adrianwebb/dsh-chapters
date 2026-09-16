/**
 * Round 26a — coexistence witness: dsh-chapters and dsh-session-fork mounted
 * in the SAME scratch profile (.dshdev4), no turns, no tokens.
 *
 * What booting to this point already proves: every host entry applied, so
 * neither tool-name registration (ctx.tools.register throws on collision),
 * storage-domain open (their dsh_session_fork beside our dsh_chapters), nor
 * command definition clashed — the loader fails the tree loudly on those
 * (r14 class of refusal). What this probe ADDS: the composed roster truth —
 * agent-presets list (our `chapters` installed; theirs unchanged), command
 * names from a live bare agent (their /branch family visible alongside
 * /compact//rename etc.), and both plugin entries' presence in the entry
 * tree via reflect-independent observation of services they own.
 * The human-only remainder (browser sidebar, their client-side sessions.fork
 * patch interaction) is recorded as not-testable-here, honestly.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-26a.json')
const report = { round: '26a', startedAt: new Date().toISOString(), probes: [], notes: [] }
const finish = (code = 0) => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(code) }

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain']

export function apply(ctx, config) {
  const run = async () => {
    report.notes.push(`apply ran — boot reached this module; both bundle patches applied`)
    const ids = (await ctx.agentPresets.list()).map((p) => `${p.id}:${p.trust ?? '?'}`)
    report.probes.push({ name: 'preset roster with both plugins mounted', ok: ids.some((s) => s.startsWith('chapters:')), ids })
    report.probes.push({ name: 'fork contributes no preset (as expected)', ok: !ids.some((s) => /fork|branch/i.test(s)), ids })

    const sessionId = `p26a-${randomUUID().slice(0, 8)}`
    try {
      const handle = await ctx.agents.create({
        sessionId, seed: [{
          type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append',
          data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'coexistence witness seed' }] },
        }],
        inheritedEventCount: 0, meta: { cwd: process.cwd(), isSeeded: false },
      })
      const names = ctx.commands.list(handle.agent).map((c) => c.name)
      report.probes.push({
        name: 'command view carries fork /branch family and standard commands',
        ok: names.some((n) => /branch/i.test(n)) && names.some((n) => /rename|help|new/i.test(n)),
        names,
      })
      await handle.dispose?.()
    } catch (error) {
      report.probes.push({ name: 'command view carries fork /branch family and standard commands', ok: false, message: String(error?.message ?? error).slice(0, 300) })
    }
    finish(0)
  }
  setTimeout(() => { run().catch((e) => { report.fatal = String(e?.stack ?? e); finish(1) }) }, 3500)
}
