/**
 * Round 30 — the user's proposed test, made durable: fork THEIR compacted
 * session (session-ecf4353f…, the "second Describe" the deterministic engine
 * compacted on 16:57) via the palette path and prove the TOC carries over.
 *
 * Expectation from the watermark design: chapter 1 (engine, events 8..~106)
 * stays exactly as the compaction wrote it; the fork appends chapter 2
 * covering ~107..last-turn; the child's seed notice lists BOTH paths; the
 * child's title is what we passed. Cost: ZERO model tokens — resume without
 * steer, fork without turns. If anything re-prefills llama.cpp during this,
 * the run is wrong, and /metrics proves it either way.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { acquireChapterStore } from '../../../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'results-30.json')
const report = { round: 30, startedAt: new Date().toISOString(), probes: [], notes: [] }
const record = (name, ok, details = {}) => {
  report.probes.push({ name, ok, ...details })
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch {}
}
const finish = () => { report.finishedAt = new Date().toISOString(); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.exit(0) }

const TARGET = 'session-ecf4353f-685e-4ac9-96a8-0818899a4ecc'

async function metrics() {
  try {
    const text = await (await fetch('http://localhost:8080/metrics')).text()
    const grab = (n) => Number(new RegExp(`^llamacpp:${n} ([0-9.e+]+)$`, 'm').exec(text)?.[1] ?? NaN)
    return { prompt: grab('prompt_tokens_total'), predicted: grab('tokens_predicted_total') }
  } catch { return { prompt: null, predicted: null } }
}

export const name = 'dsh-chapters-probe'
export const inject = ['agents', 'agentPresets', 'commands', 'storageDomain', 'llm', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const run = async () => {
    const m0 = await metrics()
    const { store, domain } = await acquireChapterStore(ctx.storageDomain)
    const before = await store.get(TARGET)
    record('R0 the compacted session is in the registry with its engine chapter', before.chapters.length >= 1, {
      existing: before.chapters.map((c) => ({ number: c.number, startSeq: c.startSeq, endSeq: c.endSeq, path: c.path })),
    })
    if (before.chapters.length === 0) { record('nothing to carry over — abort', false); finish() }

    // The live session is leased by its browser's server; read-only durable
    // observation gives the same events. The runContinue + deriveRanges +
    // registry machinery below is the EXACT code the command handler calls
    // (its palette wiring was proven in r29); only the event source and the
    // caller handle differ, and neither participates in archiving semantics.
    let selection = null
    try { selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch {}
    const obs = await ctx.sessionQuery.observeSession(TARGET)
    const events = (obs?.events ?? [])
    const anchor = [...events].reverse().find((e) => e.type === 'turn/end')?.seq
    const presetId = [...events].reverse().find((e) => e.type === 'agent-preset/selected')?.data?.agentPreset ?? null
    const usageAt = (seq) => [...events].reverse().find((e) => e.type === 'assistant/message' && e.seq <= seq)?.data?.usage
    const lastUsage = usageAt(anchor ?? 0)
    report.notes.push(`anchor=${anchor} preset=${presetId} lastUsage=${JSON.stringify(lastUsage ?? null)}`)

    const { deriveRanges, runContinue } = await import('../../../lib/continue-core.js')
    const { makeArchiveFs } = await import('../../../lib/store.js')
    const CONFIG = {
      artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
      continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
    }
    const ports = {
      readCallerEvents: async () => events,
      getState: (id) => store.get(id),
      putState: (id, st) => store.put(id, st),
      fs: () => makeArchiveFs(ROOT),
      budgetProbe: async () => {
        let windowTokens = null
        try {
          const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, new AbortController().signal)
          windowTokens = info?.context?.contextWindow ?? null
        } catch {}
        const headerBoundTokens = lastUsage !== undefined && lastUsage !== null
          ? (lastUsage.inputTokens ?? 0) + (lastUsage.cacheReadTokens ?? 0) : null
        return { windowTokens, headerBoundTokens }
      },
      newId: () => `r30-${randomUUID().slice(0, 8)}`,
      now: () => Date.now(),
      createChild: async ({ sessionId, noticeEvent, presetId: mountPreset, title }) => {
        const child = await ctx.agents.create({
          sessionId, seed: [noticeEvent], inheritedEventCount: 0,
          meta: { cwd: ROOT, isSeeded: false, ...(mountPreset ? { agentPreset: mountPreset } : {}) },
          ...(selection ? { agentOptions: selection } : {}),
          ...(mountPreset !== null ? { setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, mountPreset) } } : {}),
        })
        try {
          const controller = ctx.get('sessionController')
          if (controller?.rename !== undefined) await controller.rename({ sessionId, title })
        } catch {}
        await child.dispose?.()
      },
    }
    // Mirror the command's branch exactly: watermark -> archive-new-tail, or
    // citation-only fork when everything up to the anchor is already archived
    // (true for THIS rerun, since the previous pass committed chapter 2).
    const lastArchived = before.chapters.reduce((m, c) => Math.max(m, c.endSeq), 0)
    const fromSeq = lastArchived > 0 ? lastArchived + 1 : 0
    let branch = 'citation'
    let chapters = []
    let result = null
    const callerArgs = {
      callerSessionId: TARGET,
      callerPreset: presetId,
      title: 'ECF carry-over test II',
      toolResultOverrides: [],
    }
    if (anchor > lastArchived) {
      branch = 'archive'
      const seg = deriveRanges(events, anchor, CONFIG.chapterTokenTarget, fromSeq)
      chapters = seg.chapters
      result = await runContinue(ports, {
        ...callerArgs,
        handoffNote: 'Round 30 rerun: proving the table of contents carries over from an engine-compacted parent.',
        chapters,
      }, CONFIG)
    } else {
      const { runFork } = await import('../../../lib/continue-core.js')
      result = await runFork(ports, {
        ...callerArgs,
        handoffNote: 'Round 30 rerun: nothing new since the last archive; this branch cites the existing chapters unchanged.',
      }, CONFIG)
    }
    record('R2 fork executed on the expected branch', branch === 'citation' && result.childSessionId !== undefined, {
      branch, ranges: chapters.map((c) => `${c.startSeq}..${c.endSeq}`), child: result.childSessionId, budget: result.budget,
    })

    const after = await store.get(TARGET)
    const oldPaths = before.chapters.map((c) => c.path)
    const untouched = after.chapters.length >= 2 && oldPaths.every((p, i) => after.chapters[i]?.path === p && after.chapters[i]?.endSeq === before.chapters[i]?.endSeq)
    record('R3 chapter 1 (the compaction archive) untouched; chapter 2 appended after the watermark', untouched, {
      numbers: after.chapters.map((c) => c.number),
      ranges: after.chapters.map((c) => `${c.startSeq}..${c.endSeq}`),
    })
    const noOverlap = after.chapters.every((c, i) => i === 0 || c.startSeq > after.chapters[i - 1].endSeq)
    record('R4 ranges do not overlap (append-only AND duplicate-free)', noOverlap)

    let childId = result.childSessionId
    const obsC = childId !== undefined ? await ctx.sessionQuery.observeSession(childId) : null
    const noticeC = JSON.stringify((obsC?.events ?? []).find((e) => e.seq === 0)?.data ?? {})
    const afterNow = await store.get(TARGET)
    const carried = afterNow.chapters.length >= 2 && afterNow.chapters.every((c) => noticeC.includes(c.path))
    record('R5 THE CARRY-OVER: child notice lists the engine chapter AND the fork chapter', carried, {
      childId, chaptersAtFork: afterNow.chapters.map((c) => c.path),
      cited: afterNow.chapters.map((c) => noticeC.includes(c.path)),
    })
    const titleEventsC = (obsC?.events ?? []).filter((e) => e.type === 'session/title').map((e) => JSON.stringify(e.data))
    record('R6 child titled', titleEventsC.some((t) => t.includes('ECF carry-over test II')), { titleEventsC })
    const stateKeys = [...domain.table('sessions').entries()].filter(([, st]) => st.chapters.length > (before.chapters.length)).map(([id]) => id)
    record('R7b citation fork wrote NO chapters (parent count unchanged, no state put for parent)',
      (await store.get(TARGET)).chapters.length === before.chapters.length && !domain.table('sessions').get(TARGET)?.chapters.some((c, i) => c !== before.chapters[i]), { changed: stateKeys })

    const m1 = await metrics()
    record('R7 the whole operation cost ZERO prompt tokens at llama.cpp',
      m0.prompt !== null && m1.prompt !== null && m1.prompt === m0.prompt, { delta: m1.prompt - m0.prompt })
    const chapterFiles = after.chapters.map((c) => fs.existsSync(path.join(ROOT, c.path)))
    record('R8 all listed chapter files exist on disk', chapterFiles.every(Boolean), { files: after.chapters.map((c) => c.path) })

    finish()
  }
  setTimeout(() => { run().catch((e) => {
    report.fatal = String(e?.stack ?? e)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  }) }, 4000)
}
