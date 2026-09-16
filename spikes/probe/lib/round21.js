/**
 * Round 21 — the shipped plugin's own boot, verified.
 *  1. index.ts installed the `chapters` preset into DSH_HOME/.agent-presets (write-once).
 *  2. The roster carries it as user trust.
 *  3. A session can setup-mount it; the full standard tool roster + our engine
 *     row (thresholdRatio 0.9, auto default true — construction only, no turns,
 *     zero tokens) compose without error.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-21.json')
const report = { round: 21, startedAt: new Date().toISOString(), probes: [], notes: [] }
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
export const inject = ['agents', 'agentPresets']

export function apply(ctx, config) {
  const run = async () => {
    const cwd = process.cwd()
    const home = process.env.DSH_HOME ?? ''
    record('chapters preset installed by the plugin at boot', 
      fs.existsSync(path.join(home, '.agent-presets', 'chapters', 'preset.yml'))
      && fs.readFileSync(path.join(home, '.agent-presets', 'chapters', 'agent.cordis.yml'), 'utf8').includes('chapters-engine'),
      { home })

    let ids = []
    try { ids = (await ctx.agentPresets.list()).map((p) => `${p.id}:${p.trust ?? '?'}`) } catch (error) { report.notes.push(String(error)) }
    record('roster lists chapters (user trust)', ids.some((s) => s.startsWith('chapters:')), { ids })

    const sessionId = `p21-${randomUUID().slice(0, 8)}`
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(cwd) ?? null } catch {}
    try {
      const handle = await ctx.agents.create({
        sessionId, seed: Array.from({ length: 3 }, (_, seq) => seedUser(seq)),
        inheritedEventCount: 0,
        meta: { cwd, isSeeded: false, agentPreset: 'chapters' },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'chapters') },
      })
      await workspace?.attachSession?.(sessionId)
      handle.dispose?.()
      record('full chapters preset (standard tools + engine row) mounts cleanly', true, { sessionId })
    } catch (error) {
      record('full chapters preset (standard tools + engine row) mounts cleanly', false, {
        message: String(error?.message ?? error).slice(0, 500),
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
