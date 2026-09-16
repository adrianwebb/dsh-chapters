/**
 * Round 20 — S3a delivery probe (zero provider cost).
 *
 * The profile patch adds `roots: [!!js <package path>/presets]` to agent-presets.
 * If `require` is in !!js scope and discovery scans the added root, then
 * 'probe-roots' appears in the roster, a session can setup-mount it, and the
 * cordis group row `dsh-chapters/engine` (auto:false — construction only)
 * mounts inside the realm. That makes the delivery story: a plugin bundle ships
 * its preset; NO writes to the user's DSH_HOME are required.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-20.json')
const report = { round: 20, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec padding words so the seeded events are not empty. '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'sessionQuery', 'agentPresets']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()

    // 1. Does the roster include the package-delivered preset?
    let rosterOk = false, rosterIds = []
    try {
      const listed = await ctx.agentPresets.list()
      rosterIds = listed.map((p) => `${p.id}:${p.trust ?? '?'}`)
      rosterOk = rosterIds.some((s) => s.startsWith('probe-roots'))
    } catch (error) { report.notes.push(`list failed: ${String(error?.message ?? error).slice(0, 200)}`) }
    record('package roots entry delivered probe-roots into the roster', rosterOk, { rosterIds })

    // 2. Mount it for a created session (engine row is auto:false — this step
    // proves realm construction resolves the subpath from a roots-delivered preset).
    const sessionId = `p20-${randomUUID().slice(0, 8)}`
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}
    try {
      const handle = await ctx.agents.create({
        sessionId, seed: Array.from({ length: 4 }, (_, seq) => seedUser(seq)),
        inheritedEventCount: 0,
        meta: { cwd, isSeeded: false, agentPreset: 'probe-roots' },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'probe-roots') },
      })
      await workspace?.attachSession?.(sessionId)
      handle.dispose?.()
      record('setup-mount of a roots-delivered preset constructs the realm engine', true, { sessionId })
    } catch (error) {
      record('setup-mount of a roots-delivered preset constructs the realm engine', false, {
        message: String(error?.message ?? error).slice(0, 400),
      })
    }
    finish()
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
