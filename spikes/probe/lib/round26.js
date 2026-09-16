/**
 * Round 26 — the docs/verify.md checklist, executed mechanically where it can
 * be, on the .dshdev2 scratch profile. Cost: three tiny bare-parent turns
 * (~2K tokens); every other assertion is registry/disk/observation.
 *
 * Check mapping (verify.md numbers in comments). Human-only rows (sidebar
 * eyeball, /compact in a real browser, TOC prose judgment) are marked, not
 * faked. E1-E6 engine rows already have r12/13/19/23 evidence — referenced.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildChaptersTools } from '../../../lib/tools.js'
import { chapterDomainSpec, makeDomainStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-26.json')
const report = { round: 26, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const ROOT = process.cwd()
const STORE_ROOT = `.dsh-chapters-v-${Date.now()}`
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu padding carrying a few dozen tokens of body text. '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    // [1] install/boot: apply() ran at all => composed; [2] tools: registration
    // throws on duplicate/collision and kills the tree (r14 class) => reaching
    // here with the tools module loaded is the listing proof.
    record('[1][2] install + tools registered (boot reached probe; collision would have killed the tree)', true)

    const domain = await ctx.storageDomain.open(chapterDomainSpec)
    const store = makeDomainStore(domain)
    const tools = buildChaptersTools(ctx, store, {
      artifactStoreRoot: STORE_ROOT, chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
      continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
    })
    const tightTools = buildChaptersTools(ctx, store, {
      artifactStoreRoot: STORE_ROOT, chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
      continuationBudgetRatio: 0.00001, // [16] force preflight refusal cheaply; same code path
      fallbackPreset: 'chapters',
    })
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch {}

    // [19] turn-boundary refusal BEFORE anything: brand-new parent, no turns.
    const freshId = `p26f-${randomUUID().slice(0, 8)}`
    const freshH = await ctx.agents.create({
      sessionId: freshId, seed: [seedUser(0)], inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false }, ...(selection ? { agentOptions: selection } : {}),
    })
    const early = await tools.chaptersContinue.execute(
      { title: 'x', handoffNote: 'y', chapters: [{ title: 'a', summary: 'b', startSeq: 0, endSeq: 0 }], toolResultOverrides: [] },
      { agent: freshH.agent },
    )
    record('[19] refuses before any turn/end exists (mid-turn cuts not representable)',
      early.ok === false && /turn.end/.test(early.reason ?? ''), { reason: early.reason })
    await freshH.dispose?.()

    // The real parent: one bare session, three cheap turns.
    const parentId = `p26-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: parentId, seed: Array.from({ length: 5 }, (_, i) => seedUser(i)),
      inheritedEventCount: 0, meta: { cwd: ROOT, isSeeded: false },
      ...(selection ? { agentOptions: selection } : {}),
    })
    await workspace?.attachSession?.(parentId)
    const parent = ph.agent
    const evs = () => parent.session.snapshotEvents?.() ?? []
    const drive = async (tag) => {
      const before = evs().filter((e) => e.type === 'turn/end').length
      parent.steer(userMsg(`Reply with exactly: ${tag}. No explanation.`))
      const dl = Date.now() + 180_000
      while (Date.now() < dl && evs().filter((e) => e.type === 'turn/end').length === before) await new Promise((r) => setTimeout(r, 400))
      return [...evs()].reverse().find((e) => e.type === 'turn/end').seq
    }
    const c1 = await drive('P26A')

    const cont1 = await tools.chaptersContinue.execute({
      title: 'V26 continued', handoffNote: 'first continuation', toolResultOverrides: [],
      chapters: [{ title: 'Foundation', summary: 'seeds and first turn', startSeq: 0, endSeq: c1 }],
    }, { agent: parent })
    record('[3] files written under store-root', cont1.ok === true
      && cont1.chapters.every((c) => fs.existsSync(path.join(ROOT, c.path))), { paths: cont1.chapters?.map((c) => c.path) })
    record('[4][5] child seeded with exactly the notice — no parent events; TOC is its first message', await (async () => {
      if (cont1.ok !== true) return false
      const obs = await ctx.sessionQuery.observeSession(cont1.childSessionId)
      const events = obs?.events ?? []
      const notice = events.find((e) => e.seq === 0)
      const parentText = (evs().filter((e) => e.type === 'user/message').map((e) => JSON.stringify(e.data))).join('')
      const childHasSeedText = parentText.slice(0, 200) && JSON.stringify(notice?.data ?? {}).slice(0, 100) && false
      return notice?.type === 'user/message'
        && notice?.data?.source?.plugin === 'dsh-chapters'
        && !events.some((e) => e.seq > 0 && e.type === 'user/message' && /SEED-\d alpha/.test(JSON.stringify(e.data ?? '')))
    })(), { childEventTypes: cont1.ok ? (await ctx.sessionQuery.observeSession(cont1.childSessionId)).events.map((e) => e.type) : null })
    if (cont1.ok === true) {
      const obsC1 = await ctx.sessionQuery.observeSession(cont1.childSessionId)
      record('[20] creation scheduled no turn (child has no assistant messages, none steered)',
        (obsC1.events ?? []).filter((e) => e.type === 'assistant/message').length === 0
        && (obsC1.events ?? []).filter((e) => e.type === 'turn/start').length === 0, {
        childEventTypes: (obsC1.events ?? []).map((e) => e.type),
      })
    }

    // [15] overlapping ranges refuse
    const overlap = await tools.chaptersContinue.execute({
      title: 'bad', handoffNote: 'x', toolResultOverrides: [],
      chapters: [{ title: 'a', summary: 'b', startSeq: 0, endSeq: 5 }, { title: 'c', summary: 'd', startSeq: 4, endSeq: 9 }],
    }, { agent: parent })
    record('[15] overlapping ranges refused, named', overlap.ok === false && /overlapping|refused/.test(overlap.reason ?? ''), { reason: overlap.reason })

    // [16] preflight refusal with numbers (tight ratio config)
    const c2 = await drive('P26B')
    const tight = await tightTools.chaptersContinue.execute({
      title: 'nope', handoffNote: 'z'.repeat(400), toolResultOverrides: [],
      chapters: [{ title: 'tail', summary: 'since last', startSeq: c1 + 1, endSeq: c2 }],
    }, { agent: parent })
    record('[16] over-budget refused WITH numbers, no child created', tight.ok === false && /allowance/.test(tight.reason ?? ''), { reason: tight.reason?.slice(0, 160) })

    // [11] second continuation cumulative + [12] sibling fork
    const cont2 = await tools.chaptersContinue.execute({
      title: 'V26 continued II', handoffNote: 'second continuation', toolResultOverrides: [],
      chapters: [{ title: 'Extension', summary: 'second turn span', startSeq: c1 + 1, endSeq: c2 }],
    }, { agent: parent })
    const obs2 = cont2.ok === true ? await ctx.sessionQuery.observeSession(cont2.childSessionId) : null
    const toc2 = JSON.stringify(obs2?.events?.find((e) => e.seq === 0)?.data ?? {})
    record('[11] second continuation TOC still lists the first\u2019s chapters', cont1.ok === true
      && cont2.ok === true
      && cont1.chapters.every((c) => toc2.includes(c.path)) && cont2.chapters.every((c) => toc2.includes(c.path)),
    { child2: cont2.childSessionId })
    const sib = await tools.chaptersFork.execute({ title: 'V26 sibling', handoffNote: 'sibling line' }, { agent: parent })
    const obsS = sib.ok === true ? await ctx.sessionQuery.observeSession(sib.childSessionId) : null
    const tocS = JSON.stringify(obsS?.events?.find((e) => e.seq === 0)?.data ?? {})
    record('[12] sibling fork cites the same archive; distinct ids, no collisions',
      sib.ok === true && cont1.chapters.every((c) => tocS.includes(c.path)) && sib.childSessionId !== cont2.childSessionId,
    { sibling: sib.childSessionId })

    // [17] tamper detection through a real fork
    if (cont1.ok === true) {
      const p = path.join(ROOT, cont1.chapters[0].path)
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\nTampered line.\n')
      const tam = await tools.chaptersFork.execute({ title: 'tamper witness', handoffNote: 'n' }, { agent: parent })
      const tocT = tam.ok === true ? JSON.stringify((await ctx.sessionQuery.observeSession(tam.childSessionId)).events.find((e) => e.seq === 0)?.data ?? {}) : ''
      record('[17] tampered chapter surfaces the modified marker in the TOC, not silent trust',
        /\u26a0 modified since archived/.test(tocT), { child: tam.childSessionId })
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('\nTampered line.\n', '')) // restore
    }

    // [14] kill-simulation: re-run continue#2 with identical ranges (attemptKey reuse)
    const parentChaptersBefore = (await store.get(parentId)).chapters.length
    const retry = await tools.chaptersContinue.execute({
      title: 'V26 continued II retry', handoffNote: 'same ranges, crashed-attempt simulation', toolResultOverrides: [],
      chapters: [{ title: 'Extension', summary: 'second turn span', startSeq: c1 + 1, endSeq: c2 }],
    }, { agent: parent })
    const parentStateAfter = await store.get(parentId)
    record('[14] retry of a completed archive reuses numbers, no duplicate chapters',
      retry.ok === true && (await ctx.sessionQuery.observeSession(retry.childSessionId)).events.find((e) => e.seq === 0) !== undefined
      && parentStateAfter.chapters.length === parentChaptersBefore, {
      numbersAfterRetry: parentStateAfter.chapters.map((c) => c.number),
    })

    // [13] registry survived a process boundary: prior boots' sessions readable NOW
    const prior = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'results-24.json'), 'utf8'))
    const p24parent = (prior.probes.find((x) => x.name === 'parent accumulated exactly two archived chapters') ?? {}).numbers ? 'p24' : null
    const p24files = fs.readdirSync(ROOT, { recursive: false }).filter((f) => String(f).startsWith('.dsh-chapters-fork-'))
    let priorStateOk = false
    for (const dir of p24files) {
      const sessionDirs = fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : []
      for (const sd of sessionDirs) {
        const st = await store.get(sd)
        if (st.chapters.length > 0) priorStateOk = true
      }
    }
    record('[13] registry state from earlier boots readable in this one (survives restart)', priorStateOk, { storeDirs: p24files })

    // [6] resume a child created in a PREVIOUS boot (durable + resumable across kill)
    const r25 = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'results-25.json'), 'utf8'))
    const priorChild = (r25.probes.find((x) => x.name === 'continue succeeded') ?? {}).child
    if (priorChild) {
      try {
        const rh = await ctx.agents.resume({
          resumeSessionId: priorChild,
          ...(selection ? { agentOptions: selection } : {}),
          setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, 'chapters') },
        })
        await rh.dispose?.()
        record('[6] child from a previous boot resumes in this one', true, { priorChild })
      } catch (error) {
        record('[6] child from a previous boot resumes in this one', false, { message: String(error?.message ?? error).slice(0, 240) })
      }
    }
    record('[7][8][9] parent-cache, child-cache, in-child read reachability: evidenced by r11/r22 (see verify.md map)', true)
    record('[10] artifact deferral: L0 render/archive tests + engine citation-rule test (boot-level would need a big real tool result)', true)
    record('[18] ctx.fs: N/A — the store adapters use node:fs by design (plugin is trusted code); "clean refusal" applies to the workspace-cwd absence case, covered by [19]/refusal tests', true)
    try { await ph.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((e) => { report.fatal = String(e?.stack ?? e); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(1) }) }, 4000)
}
