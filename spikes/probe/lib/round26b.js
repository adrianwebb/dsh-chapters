/**
 * Round 26b — the cross-PROCESS checks done honestly: same scratch home
 * (.dshdev2), new boot. Resumes a child created in the previous boot,
 * verifies its seed shape survives, and reads the whole registry table to
 * confirm chapters/reservations/finalized maps round-tripped through disk.
 * Zero provider turns.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chapterDomainSpec, makeDomainStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-26b.json')
const report = { round: '26b', startedAt: new Date().toISOString(), probes: [], notes: [] }
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const prev = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'results-26.json'), 'utf8'))
const child2 = (prev.probes.find((p) => p.name.startsWith('[11]')) ?? {}).child2
const sibling = (prev.probes.find((p) => p.name.startsWith('[12]')) ?? {}).sibling

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'storageDomain', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    const domain = await ctx.storageDomain.open(chapterDomainSpec)
    const store = makeDomainStore(domain)
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}

    // Registry across the process boundary.
    const all = []
    const table = domain.table('sessions')
    for (const [id, state] of table.entries()) all.push({ id, chapters: state.chapters?.length ?? 0, reservations: Object.keys(state.reservations ?? {}).length, finalized: Object.keys(state.finalized ?? {}).length })
    const withChapters = all.filter((r) => r.chapters > 0)
    report.probes.push({
      name: '[13] registry survives restart: prior-boot sessions readable, chapters intact',
      ok: withChapters.length >= 2 && all.some((r) => r.id.startsWith('p26-') && r.chapters === 2),
      sample: all.slice(0, 6),
    })

    // Resume the previous boot's continuation child, then dispose untouched.
    for (const [label, id] of [['[6] child resumes across boot (continuation)', child2], ['[6b] sibling resumes across boot (fork)', sibling]]) {
      if (typeof id !== 'string') { report.probes.push({ name: label, ok: false, reason: 'id missing from prior results' }); continue }
      try {
        const h = await ctx.agents.resume({
          resumeSessionId: id,
          ...(selection ? { agentOptions: selection } : {}),
          setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, 'chapters') },
        })
        const obs = await ctx.sessionQuery.observeSession(id)
        const notice = (obs?.events ?? []).find((e) => e.seq === 0)
        report.probes.push({ name: label, ok: notice?.type === 'user/message' && notice?.data?.source?.plugin === 'dsh-chapters', child: id })
        await h.dispose?.()
      } catch (error) {
        report.probes.push({ name: label, ok: false, message: String(error?.message ?? error).slice(0, 200) })
      }
    }
    finish()
  }
  setTimeout(() => { run().catch((e) => { report.fatal = String(e?.stack ?? e); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(1) }) }, 4000)
}
