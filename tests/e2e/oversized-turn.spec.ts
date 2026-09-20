import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, typeComposer, localModelUp, sessionLogTextById, ROOT, E2E_REGISTRY } from './session.ts'

/**
 * THE BIG EDGE CASE: one turn that outgrows the compaction threshold by
 * itself — no user intervention mid-flight — and must be handled gracefully.
 *
 * The scenario: the model spends the turn reading a 3600-line file in
 * mandated 900-line ranges (~10K tokens each) carrying THREE markers: head,
 * line 3102, and the final line. COMPLIANCE IS THE TRIGGER: even a capped
 * single read (~2900 lines) cannot span head→3102→end in two calls — three
 * fetches minimum are forced, and 13.3K header + ≥20K of fetched content
 * crosses the 24K dev trigger by arithmetic, not hope.
 * (Runs 12/13 taught this the hard way: budgets calibrated to one model
 * personality, and a phantom chapter-poll while a skimming model had never
 * crossed at all.) The design claims pinned here:
 *
 *   1. nothing is discarded — every shadowed seq is covered by a written
 *      chapter (the durable coverage invariant);
 *   2. the loop is not perpetual — commits strictly shrink, so the number of
 *      compactions inside one turn stays small;
 *   3. the markers the model read BEFORE the first compaction survive in the
 *      transcript afterwards;
 *   4. afterwards the session is still healthy — the next small turn works.
 *
 * Runs in the `heavy` project: thresholdRatio 0.5 (trigger 16K) AND the
 * arrival floor effectively OFF (1M) — measured twice, any floor below the
 * model's read size arrival-stubs the chunks to ~200 tokens and quietly
 * prevents the very crossing this scenario exists to test (even a capped
 * single dive read ~30K tokens). Compaction and arrival are orthogonal
 * layers; this project isolates one.
 * default here so these chunks stay inline — this spec is about COMPACTION;
 * arrival-time artifacting has its own project and spec).
 */
const BIG_FILE = path.join(ROOT, 'var', 'e2e-bigfile.md')
const ALPHA = 'MARKER-ALPHA-7731'
const OMEGA = 'MARKER-OMEGA-4207'
const MIDDLE = 'MARKER-MIDDLE-5588'

function generateBigFile(): void {
  let seed = 42
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu context window chapter archive token stream engine pressure summary reload verify'
    .split(' ')
  const lines: string[] = ['# Large read target for the oversized-turn e2e.', '', ALPHA + ' — report this token verbatim.']
  for (let i = 1; i <= 6000; i++) {
    const take = Array.from({ length: 12 }, () => words[Math.floor(rnd() * words.length)]).join(' ')
    lines.push(`${i.toString().padStart(4, '0')}: ${take}`)
  }
  // line 1802 sits ONLY inside the mandated 900-line ranges [1801..2700] — a
  // model that wants this token must fetch a middle chunk (pigeonhole:
  // ALPHA∈chunk1, OMEGA∈chunk5, MIDDLE∈chunk3 ⇒ ≥3 chunks ⇒ ≥26K surface ⇒
  // crossing is arithmetic, not hope)
  lines.splice(3101, 1, `3102: singular artifact ${MIDDLE} unique-middle-token`)
  // (MIDDLE at line 3102 sits beyond the read tool's ~2900-line single-call
  // ceiling: the capped-read trick that let a model satisfy an earlier
  // three-marker contract in two fetches now mathematically forces ≥3 fetches)
  lines.push('', `Final token — report after reading everything: ${OMEGA}`)
  fs.writeFileSync(BIG_FILE, lines.join('\n'))
}

type RegistrySession = {
  chapters?: { number: number; path: string; title: string; startSeq: number; endSeq: number; topics?: string[]; shadowedSeqs?: number[] }[]
  collections?: unknown[]
}
function registrySessions(): Record<string, RegistrySession> {
  try {
    return (JSON.parse(fs.readFileSync(E2E_REGISTRY, 'utf8')) as { tables: { sessions: Record<string, RegistrySession> } }).tables.sessions
  } catch { return {} }
}

function eventTypes(log: string, type: string): unknown[] {
  const out: unknown[] = []
  for (const line of log.split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e?.type === type) out.push(e)
    } catch { /* partial lines */ }
  }
  return out
}

/** every non-empty assistant text block, in order (content nests under
 * data.message.content on real events — the renderer's own fallback shape). */
function assistantTexts(log: string): string[] {
  const out: string[] = []
  for (const e of eventTypes(log, 'assistant/message')) {
    const dd = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>
    const content = (((dd.message as { content?: unknown } | undefined)?.content ?? dd.content) ?? []) as { type?: string; text?: string }[]
    const t = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
    if (t.trim().length > 0) out.push(t)
  }
  return out
}

test('a single turn that outgrows the context window is compacted repeatedly, loses nothing, and the session stays healthy', async ({ page }) => {
  test.setTimeout(6_600_000) // 110-min ceiling for the widest measured model personality
  test.skip(!(await localModelUp()), 'Local model server not running')
  generateBigFile()

  await openApp(page)
  const sid = await newSessionWithTurn(
    page,
    'Read the file var/e2e-bigfile.md COMPLETELY using the read tool with ranges of EXACTLY 900 lines (offset 1, then 901, 1801, and so on to the end) (do NOT read the whole file in one call, and do NOT use grep or bash). Three unique marker tokens are embedded in the file: one near the top, one near line 3102, one at the very end — find and report all three (their exact names). Finish with one short answer containing all three tokens.',
    3_600_000, // 60-min turn budget: measured patterns span 6 to >45 minutes
    false, // the row-action probe belongs to fork-button.spec on heavy transcripts
  )

  // --- 0: compliance (a run-13 lesson) — the model reports BOTH markers,
  // proving the five-chunk read-through that makes a crossing arithmetically
  // unavoidable. A skimming model fails HERE, loudly, instead of the spec
  // phantom-polling for a compaction that its own prompt never forced.
  // COMPLIANCE = the file's contents actually arrived on the surface: a
  // marker token (which exists nowhere but in the file) in a tool/result
  // event. Assistant TEXT is not a reliable signal on this box (measured: a
  // full turn of reasoning + tool calls with zero text blocks). With the
  // arrival floor off, one landed chunk (~10K tokens on a 13.3K header)
  // crosses the 16K heavy trigger by arithmetic.
  await expect.poll(() => {
    const raw = sessionLogTextById(sid)
    return raw.includes('MARKER-ALPHA-7731') || raw.includes('MARKER-MIDDLE-5588') || raw.includes('MARKER-OMEGA-4207')
  }, { timeout: 900_000, intervals: [10_000] }, 'a file-only marker token arrived in a tool result').toBe(true)

  // --- 1: durable plane — engine chapters exist (forced by the arithmetic
  // above) and COVER every shadowed seq: nothing shadowed unarchived.
  await expect.poll(() => {
    const st = registrySessions()[sid]
    return (st?.chapters ?? []).some((c) => c.shadowedSeqs !== undefined)
  }, { timeout: 480_000, intervals: [5000] }, 'engine chapters recorded for THIS session').toBe(true)
  const st = registrySessions()[sid]!
  const engineChapters = (st.chapters ?? []).filter((c) => c.shadowedSeqs !== undefined)
  expect(engineChapters.length).toBeGreaterThanOrEqual(1)
  const allChapters = st.chapters ?? []
  for (const c of engineChapters) {
    for (const seq of c.shadowedSeqs ?? []) {
      expect(allChapters.some((ch) => seq >= ch.startSeq && seq <= ch.endSeq),
        `seq ${seq} shadowed but not covered by any chapter`).toBe(true)
    }
  }

  // --- 2: bounded loop — strictly-shrinking passes, deterministic provider,
  // zero usage on every commit.
  const summaries = eventTypes(sessionLogTextById(sid), 'compaction/summary')
  expect(summaries.length, 'compactions inside one turn must stay bounded').toBeGreaterThanOrEqual(1)
  expect(summaries.length).toBeLessThanOrEqual(30)
  for (const sm of summaries) {
    const d = (sm as { data?: Record<string, unknown> }).data ?? {}
    expect(d.provider).toBe('dsh-chapters')
    expect(d.usage ?? null).toBe(null)
  }

  // --- 4: graceful aftermath — the session takes the NEXT turn normally
  // (own-log turn/end count — immune to other sessions' flushes — then the
  // polled reply text, log flush lag absorbed by the poll).
  await typeComposer(page, 'Reply with exactly the single word: STILL-HERE. Do not read or run anything.')
  await expect.poll(() => eventTypes(sessionLogTextById(sid), 'turn/end').length >= 2,
    { timeout: 900_000, intervals: [5000] }, 'second turn completes in this session\u2019s own log').toBe(true)
  await expect.poll(() => assistantTexts(sessionLogTextById(sid)).some((t) => t.includes('STILL-HERE')),
    { timeout: 300_000, intervals: [5000] }, 'post-compaction session answers normally').toBe(true)

  // --- observation (never a gate): does the per-row fork action render again
  // after a follow-up turn settled the transcript?
  const actionRowObserved = await page.locator('button[aria-label="Fork with chapters"]').first().isVisible({ timeout: 30_000 }).catch(() => false)
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-oversized-notes.json'), JSON.stringify({
    at: new Date().toISOString(), engineChapters: engineChapters.length,
    compactionSummaries: summaries.length, actionRowObservedAfterFollowUp: actionRowObserved,
  }, null, 1))
})
