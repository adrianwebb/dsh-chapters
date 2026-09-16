/**
 * Round 22 — the MVP end-to-end loop, through the REAL wiring:
 *
 *   parent session (bare, one real turn for a turn/end boundary + usage)
 *     -> chapters_segment via the actual tool definition (real store, real
 *        snapshotEvents, real resolveModelInfo budget probe)
 *     -> chapters_continue via the actual tool definition (real writeArchive
 *        to disk, real notice, real agents.create + presets.mount('chapters'),
 *        real workspace attach, handle disposed)
 *     -> resume the child (r3 lesson: resume only works after dispose)
 *     -> child REAL turn asking it to read its first chapter and echo a line
 *        (the reachability check: the child's tool roster proves the mounted
 *        preset composed; a successful read proves the store is reachable).
 *
 * Provider turns: parent 1 (~600), child 1-2 (~13K header each on the
 * chapters preset). A few cents; the decisive MVP measurement.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildChaptersTools } from '../../../lib/tools.js'
import { chapterDomainSpec, makeDomainStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results-22.json')
const report = { round: 22, startedAt: new Date().toISOString(), probes: [], notes: [], steps: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const ROOT = process.cwd()
const STORE_ROOT = `.dsh-chapters-e2e-${Date.now()}`
const PAD = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten padding words for realistic chapter sizes. '
const seedUser = (seq) => ({
  type: 'user/message', seq, time: Date.now(), surfaceOp: 'append',
  data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `SEED-${seq} ${PAD}` }] },
})
const userMsg = (text) => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

const TOOLS_CONFIG = {
  artifactStoreRoot: STORE_ROOT,
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25,
  fallbackPreset: 'chapters',
}

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'sessionQuery', 'storageDomain', 'llm', 'sessionProjections']

export function apply(ctx, config) {
  const run = async () => {
    const domain = await ctx.storageDomain.open(chapterDomainSpec)
    const store = makeDomainStore(domain)
    const tools = buildChaptersTools(ctx, store, TOOLS_CONFIG)

    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    record('model selection', Boolean(selection), { selection: selection && `${selection.provider}/${selection.model}` })

    let workspace = null
    try { workspace = await ctx.get('workspaceRegistry')?.createCanonical?.(ROOT) ?? null } catch {}

    // ---- parent: seeded, one real turn (for turn/end + usage), then archive
    const parentId = `p22-parent-${randomUUID().slice(0, 8)}`
    const ph = await ctx.agents.create({
      sessionId: parentId,
      seed: Array.from({ length: 6 }, (_, seq) => seedUser(seq)),
      inheritedEventCount: 0,
      meta: { cwd: ROOT, isSeeded: false },
      ...(selection ? { agentOptions: selection } : {}),
    })
    await workspace?.attachSession?.(parentId)
    const parent = ph.agent
    const events = () => parent.session.snapshotEvents?.() ?? []
    const turns = () => events().filter((e) => e.type === 'turn/end').length
    const usages = () => events().filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean)
    parent.steer(userMsg('Reply with exactly: P22P. No explanation.'))
    const t0 = Date.now()
    while (Date.now() - t0 < 180_000 && turns() === 0) await new Promise((r) => setTimeout(r, 400))
    record('parent turn 1 completed (boundary + usage exist)', turns() > 0 && usages().length > 0, { usage: usages().at(-1) })

    const ceiling = [...events()].reverse().find((e) => e.type === 'turn/end').seq
    const seg = await tools.segment.execute({}, { agent: parent })
    record('chapters_segment returns real facts through the wired tool', seg.ok === true && seg.archiveCeiling === ceiling, {
      ceiling: seg.archiveCeiling, toolResults: seg.toolResults?.length ?? 0,
    })

    // ---- continue through the wired tool (ranges: seeds..ceiling in two chapters)
    const half = Math.floor(ceiling / 2)
    const cont = await tools.chaptersContinue.execute({
      title: 'E2E continuation',
      handoffNote: 'Stage 4 wiring verification; expect a chapter read next.',
      chapters: [
        { title: 'Seeds one', summary: 'seeded messages first half', startSeq: 0, endSeq: half },
        { title: 'Seeds two', summary: 'seeded messages second half plus turn one', startSeq: half + 1, endSeq: ceiling },
      ],
      toolResultOverrides: [],
    }, { agent: parent })
    record('chapters_continue succeeded end to end', cont.ok === true, {
      childSessionId: cont.childSessionId, presetUsed: cont.presetUsed, chapters: cont.chapters, budget: cont.budget, warnings: cont.warnings,
      reason: cont.reason ?? null,
    })
    if (cont.ok !== true) { finish(); return }

    const childId = cont.childSessionId
    const childFiles = cont.chapters.map((c) => fs.existsSync(path.join(ROOT, c.path)))
    record('chapter files exist on real disk', childFiles.every(Boolean), { paths: cont.chapters.map((c) => c.path) })

    // ---- resume the child (handles disposed by the tool) and check composition
    let childHandle
    try {
      // Mirror what session-controller's resume path does (raw agents.resume
      // composes nothing — no model, no preset — exactly the r10/r15 lesson).
      childHandle = await ctx.agents.resume({
        resumeSessionId: childId,
        ...(selection ? { agentOptions: selection } : {}),
        setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, 'chapters') },
      })
      record('child resumes after create-handle disposal', true, { childId })
    } catch (error) {
      record('child resumes after create-handle disposal', false, { message: String(error?.message ?? error).slice(0, 300) })
      finish(); return
    }
    const child = childHandle.agent
    const childEvents = () => child.session.snapshotEvents?.() ?? []
    const childTurns = () => childEvents().filter((e) => e.type === 'turn/end').length
    const before = childTurns()
    child.steer(userMsg('Use the read tool on the FIRST path in your Chapters index; from the chapter body, reply with the Markdown H1 title line exactly, prefixed REPLIED:'))
    const t1 = Date.now()
    while (Date.now() - t1 < 180_000 && childTurns() === before) await new Promise((r) => setTimeout(r, 500))
    const childUsage = childEvents().filter((e) => e.type === 'assistant/message').map((e) => e.data?.usage).filter(Boolean).at(-1) ?? null
    const totalChildPrompt = childUsage ? (childUsage.inputTokens ?? 0) + (childUsage.cacheReadTokens ?? 0) : null
    record('child turn completed with a composed header (preset mounted via tool createChild)',
      childTurns() > before && totalChildPrompt !== null && totalChildPrompt > 5000, {
      totalChildPrompt, note: 'threshold proves the real system prompt + tool schemas rode the request',
    })
    const readCalls = childEvents().filter((e) => e.type === 'tool/call' && String(e.data?.name ?? '').includes('read'))
    // assistant/message carries the Message at data.message (measured: the
    // envelope is { message, usage, ... }), not data.content.
    const blocksOf = (e) => {
      const d = e?.data ?? {}
      const c = Array.isArray(d.content) ? d.content : (d.message?.content ?? [])
      return (c ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
    }
    const reply = [...childEvents()].reverse().find((e) => e.type === 'assistant/message' && blocksOf(e).trim().length > 0)
    const replyText = blocksOf(reply)
    record('child actually reached for the read tool (reachability, not existence)', readCalls.length > 0, {
      calls: readCalls.map((c) => c.data?.arguments).slice(0, 2).map(String),
    })
    record('child reply carries chapter text', /REPLIED:.*#\s+Seeds/i.test(replyText), {
      reply: replyText.slice(0, 200),
    })
    report.notes.push(`child final reply snippet: ${replyText.slice(0, 160)}`)
    try { await childHandle.dispose?.() } catch {}
    finish()
  }
  setTimeout(() => { run().catch((error) => {
    report.fatal = String(error?.stack ?? error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
