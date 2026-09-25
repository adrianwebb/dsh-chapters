import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp, sessionLogTextById, logEvents, typeComposer } from './session.ts'

/**
 * CACHE TRAJECTORY PROBE — opt-in, live-only (`npm run test:e2e:cache`).
 *
 * Born of the 2026-09-25 user investigation (real machine, real llama.cpp @ n_ctx 65,536,
 * total_slots 1). The decoded truth, from the session logs themselves — this probe exists to
 * keep both halves pinned:
 *
 *   1. PRESSURE UNITS: the compaction engine fires on the host tokenMeter's number
 *      (provider-reported baseline + 4-chars-per-token ESTIMATE of everything added since the
 *      last request), not on the provider's last usage line. A session looked like it compacted
 *      "at 29,656 of a 64,000 window"; the surface at decision time was ~66,700 meter tokens
 *      (>= 0.9 x 64,000). Nothing is hardcoded here — thresholds follow the configured window.
 *   2. CAPACITY, NOT POLICY: prefix cache lookup worked exactly as configured — every
 *      interleaved session kept reusing the same 9,613-token shared header. What could NOT be
 *      cached: four divergent session tails + one large agent session simultaneously inside a
 *      65,536-token KV pool (~150K demand). LRU keeps the shared prefix and churns the tails —
 *      cacheRead pins at the header and every request re-prefills its own tail. A serial probe
 *      (this test, CONCUR=1) fit in the pool and measured a clean 0 -> 99.7% warm curve.
 *
 * Contract (AGENTS formula: totalPrompt = input + cacheRead; hit = cacheRead/totalPrompt):
 *   A. NO COMPACTION during the probe window (tiny turns must not pressurize; if one fires the
 *      trajectory measures the wrong thing — fail loudly instead of asserting through it).
 *   B. NO COLLAPSE: no turn's cacheRead below HALF the best seen (one collision refills and
 *      re-grows; the measured pathology sat at ~32% and STAYED).
 *   C. GROWTH LANDS CACHED: from turn 2 to the last, >= 50% of prompt growth must arrive as
 *      cacheRead growth, not uncached input — the assertion that catches the PINNED-HEADER
 *      signature (capacity oversubscription or permanent tail invalidation).
 *   D. FINAL HIT RATE >= 0.90 for the probe session (small turns over a fat header).
 * Every failure prints the FULL per-turn ledger — refuse-with-numbers, never a bare false.
 *
 * Runbook:
 *   npm run test:e2e:cache                          # serial: the design's warm-cache promise
 *   E2E_CACHE_CONCURRENCY=3 npm run test:e2e:cache  # contention: N extra live sessions
 * Interleave fan-out against the probe and it measures whether THIS server's KV pool can hold
 * N+1 warm chains — pass means the sub-agent flow caches fine at this concurrency; fail with a
 * pinned header means the pool is oversubscribed (raise llama --ctx-size / --parallel, or cap
 * concurrency). Pause your own agent sessions for honest numbers either way.
 */

const tenantErrors: string[] = []

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

function ledgerTable(label: string, turns: TurnUsage[]): string {
  const best: number[] = []
  let m = 0
  for (const t of turns) { m = Math.max(m, t.read); best.push(m) }
  return [`${label}:`, ...turns.map((t, i) =>
    `  turn ${t.index}: input ${String(t.input).padStart(6)} | cacheRead ${String(t.read).padStart(6)}` +
    ` | total ${String(t.total).padStart(6)} | hit ${(t.read / (t.read + t.input)).toFixed(3)}` +
    ` | minRatio ${(t.read / Math.max(1, best[i])).toFixed(2)}`)].join('\n')
}

test('a serial session cache-warms: hit rate rises and cacheRead grows with the conversation', async ({ page, browser }) => {
  const CONCUR = Math.max(1, Math.min(4, Number(process.env.E2E_CACHE_CONCURRENCY ?? 1)))
  const TURN_MS = CONCUR > 1 ? 900_000 : 240_000
  test.setTimeout(CONCUR > 1 ? 2_700_000 : 900_000)
  const mode = process.env.E2E_MODEL ?? 'live'
  test.skip(mode !== 'live', `the cache probe measures PHYSICAL prefix caching — tape ${mode} mode cannot show it (run without E2E_MODEL)`)
  test.skip(!(await localModelUp()), 'Local model server not running (the probe asks it)')

  await openApp(page)
  const TURNS = 8
  const ledger: TurnUsage[] = []
  let sid = ''
  let seenSeq = 0

  // Contention tenants: live browser sessions that interleave requests with the probe. Each is
  // brought up serially (its turn 1 completes) so its chain is WARM before contention starts —
  // afterwards its later turns fire unawaited, landing mid-probe on purpose.
  interface Tenant { label: string; sid: string; ledger: TurnUsage[]; page: import('@playwright/test').Page; inflight: Promise<void> }
  const tenants: Tenant[] = []
  for (let c = 1; c < CONCUR; c++) {
    const tPage = await browser.newPage()
    await openApp(tPage)
    const tq = `Cache probe tenant ${c} turn 1: answer in two short sentences about KV cache eviction, ending with TENANT-${c}-1. No tools.`
    const tSid = await newSessionWithTurn(tPage, tq, TURN_MS, false)
    tenants.push({ label: `tenant ${c}`, sid: tSid, ledger: [usageLedger(tSid).at(-1)!], page: tPage, inflight: Promise.resolve() })
    console.log(`cache probe: contention tenant ${c} session ${tSid} warm (turn 1 recorded)`)
  }

  for (let t = 1; t <= TURNS; t++) {
    // Fire this round's tenant turns WITHOUT awaiting — their requests queue ahead of /
    // interleave with the probe's on the shared slot (that's the measurement). Each tenant
    // promise re-arms only after its own turn lands, so one inflight turn per tenant.
    for (const tn of tenants) {
      const q = `Cache probe tenant turn: answer in two short sentences about prompt prefixes, ending with ${tn.label.replace(' ', '-')}-${tn.ledger.length + 1}. No tools.`
      tn.inflight = (async () => {
        await typeComposer(tn.page, q)
        await expect.poll(() => usageLedger(tn.sid).length > tn.ledger.length, { timeout: TURN_MS, intervals: [5000] },
          `tenant chain grows (CONCUR=${CONCUR}: a timeout = QUEUE STARVATION — the slot cannot serve ${CONCUR} chains in budget)`).toBe(true)
        tn.ledger = usageLedger(tn.sid)
      })().catch((e: unknown) => { tenantErrors.push(`${tn.label}: ${String((e as Error)?.message ?? e).slice(0, 160)}`) })
    }

    const q = `Cache probe turn ${t} of ${TURNS}: answer in exactly two short sentences about how a prefix cache stays warm, and end your reply with the token PROBE-${t}. No tools.`
    if (t === 1) {
      sid = await newSessionWithTurn(page, q, TURN_MS, false)
    } else {
      const before = usageLedger(sid).length
      await typeComposer(page, q)
      await expect.poll(() => usageLedger(sid).length > before, { timeout: TURN_MS + 60_000, intervals: [5000] },
        `turn ${t} completes (CONCUR=${CONCUR}: a timeout here means QUEUE STARVATION on the shared slot — the server cannot serve ${CONCUR} chains inside the budget; a completed-but-flat-cacheRead ledger instead means KV eviction — different fix)`).toBe(true)
    }
    await expect.poll(() => {
      const evs = logEvents(sessionLogTextById(sid))
      seenSeq = Math.max(seenSeq, ...evs.map((e) => e.seq))
      return usageLedger(sid).length
    }, { timeout: CONCUR > 1 ? 240_000 : 60_000, intervals: [5000] }).toBeGreaterThanOrEqual(t)
    ledger.push(usageLedger(sid).at(-1)!)
  }
  // Drain tenants; their ledgers report next turn.
  await Promise.all(tenants.map((tn) => tn.inflight.catch(() => undefined)))
  await page.waitForTimeout(2000)
  for (const tn of tenants) {
    const full = usageLedger(tn.sid)
    tn.ledger = full
    console.log(ledgerTable(`cache probe ${tn.label} (contention tenant, E2E_CACHE_CONCURRENCY=${CONCUR})`, full))
  }

  const table = ledgerTable('cache probe (serial session)', ledger)
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
  if (CONCUR === 1) {
    expect(cachedGrowth, `only ${Math.round(100 * cachedGrowth / Math.max(1, promptGrowth))}% of the ${promptGrowth}-token prompt growth landed cached; a pinned cacheRead is the slot-thrash signature\n${table}`)
      .toBeGreaterThanOrEqual(0.5 * promptGrowth)
  } else {
    // Contention mode reports the cliff but the HARD gate stays the serial contract; print the
    // comparison so a server-capacity change is measurable as a number moving.
    console.log(`cache probe CONCUR=${CONCUR}: serial cachedGrowth ${(100 * cachedGrowth / Math.max(1, promptGrowth)).toFixed(1)}% of ${promptGrowth} prompt tokens; probe final hit ${(end.read / (end.read + end.input)).toFixed(3)}; tenant errors: ${tenantErrors.length ? tenantErrors.join(' | ') : 'none'}`)
  }

  // D. final hit rate (the serial contract; under contention still demanded of the probe chain)
  const hit = end.read / (end.read + end.input)
  expect(hit, `final-turn hit rate ${hit.toFixed(3)} below 0.90${CONCUR > 1 ? ` (CONCUR=${CONCUR}: a pinned header + low growth = this server's KV pool cannot hold ${CONCUR}+ warm chains; raise --ctx-size/--parallel or drop concurrency)` : ''}\n${table}`).toBeGreaterThanOrEqual(0.9)
})

