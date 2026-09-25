import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp, sessionLogTextById, logEvents, typeComposer } from './session.ts'

/**
 * CACHE TRAJECTORY PROBE — opt-in, live-only (`npm run test:e2e:cache`).
 *
 * Why this exists (measured 2026-09-25, user report): a real machine run showed cache hit rates
 * FALLING over time — a session whose cacheRead rode 11,386→29,656 for seven healthy turns then
 * collapsed to a PINNED 9,613 (the shared system-prompt header) at a compaction span-replacement,
 * and three fan-out children whose cacheRead never grew past 9,613 at all because four
 * interleaved sessions were thrashing a single llama.cpp slot (each prefill evicts the others;
 * only the common header prefix survives). Tape replay cannot measure THIS class of failure —
 * recorded usage bytes are not physical caching — so this probe asks the real server, in a
 * serial session, and asserts the trajectory the whole design depends on.
 *
 * Contract (AGENTS formula: totalPrompt = input + cacheRead; hit = cacheRead/totalPrompt):
 *   A. NO COMPACTION fires during the probe (tiny turns must not pressurize; if one does, the
 *      trajectory is measuring the wrong thing — fail loudly instead of asserting through it).
 *   B. NO COLLAPSE: no turn's cacheRead may fall below HALF the best seen so far. (One off
 *      collision from another tenant refills and re-grows — tolerance exists; the measured
 *      pathology sat at ~32% and STAYED.)
 *   C. GROWTH LANDS CACHED: from the 2nd turn to the last, at least half of the prompt growth
 *      must arrive as cacheRead growth, not uncached input. This is the assertion that catches
 *      the PINNED-HEADER signature (cacheRead flat while history grows = slot thrash or
 *      permanent tail invalidation).
 *   D. FINAL HIT RATE >= 0.90 (small turns over a fat header — this is the steady state the
 *      design promises, e.g. 99.79% measured in a live session).
 * Every failure prints the FULL per-turn ledger — refuse-with-numbers, never a bare false.
 *
 * Runbook: this probe measures physical prefix caching on a shared model slot — run it while
 * NOTHING else uses the model (close other live sessions; pause agent work). A failure with
 * cacheRead pinned near the header value is the slot-contention signature, not necessarily a
 * product bug: read the ledger's SHAPE (collapse-and-stay vs flat-pin vs clean dip-and-recover).
 */

interface TurnUsage { index: number; input: number; read: number; out: number; total: number }

function usageLedger(sid: string): TurnUsage[] {
  const evs = logEvents(sessionLogTextById(sid))
  const turns: TurnUsage[] = []
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    try {
      const data = (JSON.parse(e.raw) as { data?: { usage?: Record<string, number> } }).data
      const u = data?.usage
      if (u === undefined) continue
      const input = u.inputTokens ?? 0
      const read = u.cacheReadTokens ?? 0
      const out = u.outputTokens ?? 0
      turns.push({ index: turns.length + 1, input, read, out, total: input + read })
    } catch { /* partial frame — the log streams; next read sees it whole */ }
  }
  return turns
}

function ledgerTable(turns: TurnUsage[]): string {
  const best: number[] = []
  let m = 0
  for (const t of turns) { m = Math.max(m, t.read); best.push(m) }
  return turns.map((t, i) =>
    `  turn ${t.index}: input ${String(t.input).padStart(6)} | cacheRead ${String(t.read).padStart(6)}` +
    ` | total ${String(t.total).padStart(6)} | hit ${(t.read / (t.read + t.input)).toFixed(3)}` +
    ` | minRatio ${(t.read / Math.max(1, best[i])).toFixed(2)}`).join('\n')
}

test('a serial session cache-warms: hit rate rises and cacheRead grows with the conversation', async ({ page }) => {
  test.setTimeout(900_000)
  const mode = process.env.E2E_MODEL ?? 'live'
  test.skip(mode !== 'live', `the cache probe measures PHYSICAL prefix caching — tape ${mode} mode cannot show it (run without E2E_MODEL)`)
  test.skip(!(await localModelUp()), 'Local model server not running (the probe asks it)')

  await openApp(page)
  const TURNS = 8
  const ledger: TurnUsage[] = []
  let sid = ''
  let seenSeq = 0

  for (let t = 1; t <= TURNS; t++) {
    const q = `Cache probe turn ${t} of ${TURNS}: answer in exactly two short sentences about how a prefix cache stays warm, and end your reply with the token PROBE-${t}. No tools.`
    if (t === 1) {
      sid = await newSessionWithTurn(page, q, 240_000, false)
    } else {
      const before = usageLedger(sid).length
      await typeComposer(page, q)
      const ok = await expect.poll(() => usageLedger(sid).length > before, { timeout: 240_000, intervals: [5000] },
        `turn ${t} completes in this session\u2019s own log`).toBe(true)
      void ok
    }
    // settle: the last assistant/message usage event + turn/end must both be durable
    await expect.poll(() => {
      const evs = logEvents(sessionLogTextById(sid))
      seenSeq = Math.max(seenSeq, ...evs.map((e) => e.seq))
      return usageLedger(sid).length
    }, { timeout: 60_000, intervals: [2000] }).toBeGreaterThanOrEqual(t)
    const turns = usageLedger(sid)
    ledger.push(turns[turns.length - 1]!)
  }

  const table = ledgerTable(ledger)
  console.log(`e2e cache probe: session ${sid}\n${table}`)

  // A. no compaction during the probe window
  const compaction = logEvents(sessionLogTextById(sid)).filter((e) => e.type.startsWith('compaction/') && e.seq <= seenSeq)
  expect(compaction.length, `probe must stay below pressure compaction (a span replacement mid-probe invalidates the trajectory); saw ${compaction.length} compaction events\n${table}`).toBe(0)

  // B. no collapse below half of the best seen
  let best = 0
  for (const t of ledger) {
    best = Math.max(best, t.read)
    expect(t.read, `turn ${t.index}: cacheRead collapsed (best ${best}) — permanent tail invalidation is the 2026-09-25 pathology\n${table}`).toBeGreaterThanOrEqual(0.5 * best)
  }

  // C. growth lands cached: prompt growth from turn 2 onward at least half cached by the end
  const start = ledger[1]!
  const end = ledger[ledger.length - 1]!
  const promptGrowth = end.total - start.total
  const cachedGrowth = end.read - start.read
  expect(promptGrowth, `conversation grew at all across ${TURNS} turns\n${table}`).toBeGreaterThan(200)
  expect(cachedGrowth, `only ${Math.round(100 * cachedGrowth / Math.max(1, promptGrowth))}% of the ${promptGrowth}-token prompt growth landed cached; a pinned cacheRead is the slot-thrash signature\n${table}`)
    .toBeGreaterThanOrEqual(0.5 * promptGrowth)

  // D. final hit rate
  const hit = end.read / (end.read + end.input)
  expect(hit, `final-turn hit rate ${hit.toFixed(3)} below 0.90\n${table}`).toBeGreaterThanOrEqual(0.9)
})
