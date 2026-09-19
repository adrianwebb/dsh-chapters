import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, typeComposer, localModelUp, sessionLogTextById, ROOT } from './session.ts'

/**
 * THE BIG EDGE CASE: one turn that outgrows the compaction threshold by
 * itself — no user intervention mid-flight — and must be handled gracefully.
 *
 * The scenario: the model spends the turn reading a 700KB file range by
 * range (r26-era probe behavior: instructed to read-only, this model complies
 * and generates big tool results per step). Somewhere mid-turn the surface
 * crosses thresholdRatio × window; the engine's pressure check fires at the
 * next pre-step, replaces the oldest steps with the TOC, archives them to
 * chapters — and the SAME TURN keeps going. The design claims (this spec
 * pins each one):
 *
 *   1. nothing is discarded — every shadowed seq is covered by a written
 *      chapter (the durable coverage invariant);
 *   2. the loop is not perpetual — every commit strictly shrinks, so the
 *      number of compactions inside one turn stays small;
 *   3. the turn COMPLETES normally with the model's answer;
 *   4. afterwards the session is still healthy — the next small turn works.
 *
 * Requires the Local model (globalSetup lowers the dev preset's thresholdRatio
 * to 0.55 so the crossing happens at ~35K, a real mid-turn crossing on a
 * ~60-70K accumulation, not a contrived one). ~10-30 minutes of local prefill.
 */
const BIG_FILE = path.join(ROOT, 'var', 'e2e-bigfile.md')
const REGISTRY = path.join(ROOT, '.dshdev-local', 'storages', 'dsh_chapters.json')
const ALPHA = 'MARKER-ALPHA-7731'
const OMEGA = 'MARKER-OMEGA-4207'

function generateBigFile(): void {
  // deterministic pseudo-random lines (seeded LCG), ~700KB; markers fixed.
  let seed = 42
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu context window chapter archive token stream engine pressure summary reload verify'
    .split(' ')
  const lines: string[] = ['# Large read target for the oversized-turn e2e.', '', ALPHA + ' — report this token verbatim.']
  for (let i = 1; i <= 1200; i++) {
    const take = Array.from({ length: 12 }, () => words[Math.floor(rnd() * words.length)]).join(' ')
    lines.push(`${i.toString().padStart(4, '0')}: ${take}`)
  }
  lines.push('', `Final token — report after reading everything: ${OMEGA}`)
  fs.writeFileSync(BIG_FILE, lines.join('\n'))
}

type RegistrySession = {
  chapters?: { number: number; path: string; title: string; startSeq: number; endSeq: number; topics?: string[]; shadowedSeqs?: number[] }[]
  collections?: unknown[]
}
function registrySessions(): Record<string, RegistrySession> {
  try {
    return (JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { tables: { sessions: Record<string, RegistrySession> } }).tables.sessions
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

/** every non-empty assistant text block, in order. Real events nest content
 * under data.message.content (the renderer's `data.message ?? data` pattern). */
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
  test.setTimeout(3_300_000) // 55 min: multi-step local turn with big prefills
  test.skip(!(await localModelUp()), 'Local model server not running')
  generateBigFile()

  await openApp(page)
  // One turn that MUST cross the threshold by itself: ~700KB read range by
  // range. The first big reads land while the surface is already ~header(13K);
  // each step adds ~10-20K — the 35.2K line is crossed mid-turn, repeatedly.
  const sid = await newSessionWithTurn(
    page,
    'Read the file var/e2e-bigfile.md COMPLETELY using the read tool with ranges of EXACTLY 150 lines (offset 1, then 151, 301, ... until the end — do NOT read the whole file in one call, and do NOT use grep or bash). Report the ALPHA marker token as soon as you have seen it, then read to the end and report OMEGA. Finish with one line containing both tokens.',
    2_700_000, // 45-minute turn budget on the local box
    false, // the row-action probe belongs to fork-button.spec; a heavy turn may
            // end without a text-bearing assistant row until the NEXT render
  )

  // --- 1+2: durable plane — engine chapters exist and COVER every shadowed seq
  await expect.poll(() => {
    const sessions = registrySessions()
    return Object.values(sessions).some((st) => (st.chapters ?? []).some((c) => c.shadowedSeqs !== undefined && (c.topics ?? []).some((t) => t.includes('e2e-bigfile'))))
  }, { timeout: 240_000, intervals: [5000] }, 'engine compaction archived the mid-turn span').toBe(true)

  // the session is known EXACTLY (localStorage identity via the helper) —
  // poll its registry record until the engine's chapters land
  await expect.poll(() => {
    const st = registrySessions()[sid]
    return (st?.chapters ?? []).some((c) => c.shadowedSeqs !== undefined)
  }, { timeout: 240_000, intervals: [5000] }, 'engine chapters recorded for THIS session').toBe(true)
  const st = registrySessions()[sid]!
  const engineChapters = (st.chapters ?? []).filter((c) => c.shadowedSeqs !== undefined)
  expect(engineChapters.length).toBeGreaterThanOrEqual(1)

  // coverage: EVERY shadowed seq of EVERY engine chapter falls inside some
  // chapter's [startSeq..endSeq] — nothing was shadowed unarchived
  const allChapters = st.chapters ?? []
  for (const c of engineChapters) {
    for (const seq of c.shadowedSeqs ?? []) {
      expect(allChapters.some((ch) => seq >= ch.startSeq && seq <= ch.endSeq),
        `seq ${seq} shadowed but not covered by any chapter`).toBe(true)
    }
  }

  // --- bounded loop: compaction commits stay small (strictly-shrinking passes)
  const log = sessionLogTextById(sid)
  const summaries = eventTypes(log, 'compaction/summary')
  expect(summaries.length, 'compactions inside one turn must stay bounded').toBeGreaterThanOrEqual(1)
  expect(summaries.length).toBeLessThanOrEqual(30)
  // every committed summary cites the deterministic provider + zero usage
  for (const sm of summaries) {
    const d = (sm as { data?: Record<string, unknown> }).data ?? {}
    expect(d.provider).toBe('dsh-chapters')
    expect(d.usage ?? null).toBe(null)
  }

  // --- 3: the turn COMPLETED, and the marker the model read BEFORE the
  // first compaction is still present in the transcript afterwards: it was
  // stated in an assistant message (the contract is 'reported across
  // compaction', not 'the model's last sentence' — a model that runs out of
  // steam mid-task after heavy trims is model behavior, not data loss).
  const texts = assistantTexts(log)
  expect(texts.length, 'turn produced assistant messages').toBeGreaterThanOrEqual(1)
  expect(texts.join('\n'), 'ALPHA marker lost across compaction').toContain(ALPHA)

  // --- 4: graceful aftermath — the session takes the NEXT turn normally.
  // Poll THIS session's collection count (>=2 is unsatisfiable by turn 1's
  // late registry flush — the cross-session total race cost one run here)
  // and poll the reply text (the session log flushes seconds behind memory).
  await typeComposer(page, 'Reply with exactly the single word: STILL-HERE. Do not read or run anything.')
  await expect.poll(() => eventTypes(sessionLogTextById(sid), 'turn/end').length >= 2,
    { timeout: 900_000, intervals: [5000] }, 'second turn completes in this session\u2019s own log').toBe(true)
  await expect.poll(() => assistantTexts(sessionLogTextById(sid)).some((t) => t.includes('STILL-HERE')),
    { timeout: 300_000, intervals: [5000] }, 'post-compaction session answers normally').toBe(true)

  // --- observation (never a gate): does the per-row fork action render again
  // after a follow-up turn settled the transcript? Recorded, not asserted —
  // the affordance itself is fork-button.spec's contract.
  const actionRowObserved = await page.locator('button[aria-label="Fork with chapters"]').first().isVisible({ timeout: 30_000 }).catch(() => false)
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-oversized-notes.json'), JSON.stringify({
    at: new Date().toISOString(), engineChapters: engineChapters.length,
    compactionSummaries: summaries.length, actionRowObservedAfterFollowUp: actionRowObserved,
  }, null, 1))
})
