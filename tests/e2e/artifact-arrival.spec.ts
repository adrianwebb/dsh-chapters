import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp, sessionLogTextById, E2E_HOME, ROOT } from './session.ts'

/**
 * ARRIVAL-TIME ARTIFACTING, end to end (architecture.md amendment, G1+G2).
 * Boot pins toolResultArtifactTokens=500 and the production threshold 0.9:
 * a single huge read must be stubbed at the tail node BEFORE the next request
 * composes — so compaction is never even needed to keep the turn alive.
 * Proofs, in the session's own durable log:
 *   - the arrival pair (compaction/prune 'by:dsh-chapters-arrival' + stubbed
 *     tool/result) exists;
 *   - the blob's fingerprint NEVER appears in any request/* event (the blob
 *     was prefilled zero times — the cache-safety claim at the transcript
 *     level; llama.cpp counters land in the sidecar);
 *   - the model WORKS the artifact via chapters_artifact (toc + search) and
 *     returns facts that only exist inside the blob.
 */
const BOOK = path.join(ROOT, 'var', 'e2e-book.md')
const FINGERPRINT = 'BLOB-FINGERPRINT-9182736450-qzxv'
const CENTER_TOKEN = 'EMBED-CENTER-4417'

function generateBook(): void {
  const lines: string[] = ['# The Big Reference Book', '', 'Structure probe target: 40 chapters.']
  for (let c = 1; c <= 40; c++) {
    lines.push('', `## Chapter ${c} of 40`, `Chapter ${c} discusses windowing, filing, and retrieval.`)
    for (let l = 0; l < 96; l++) lines.push(`line ${c}-${l}: reference material regarding context economics and archival discipline number ${c * 100 + l}.`)
    if (c === 21) {
      lines.push(FINGERPRINT + ' ' + 'filler-'.repeat(600))
      lines.push(`buried here: ${CENTER_TOKEN}`)
    }
  }
  fs.writeFileSync(BOOK, lines.join('\n'))
}

function parseRows(text: string): { seq: number; type: string; raw: string }[] {
  const out: { seq: number; type: string; raw: string }[] = []
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (typeof e?.seq === 'number') out.push({ seq: e.seq, type: String(e.type ?? ''), raw: line }) } catch { /* partial */ }
  }
  return out
}

test('one oversized read is artifacted at arrival, never prefilled, and answered through chapters_artifact', async ({ page }) => {
  test.setTimeout(1_500_000) // 25 min
  test.skip(!(await localModelUp()), 'Local model server not running')
  generateBook()
  const bookBytes = fs.statSync(BOOK).size
  expect(bookBytes, 'book exceeds any plausible inline budget').toBeGreaterThan(250_000)

  await openApp(page)
  const sid = await newSessionWithTurn(page,
    'var/e2e-book.md is a large reference document. Step 1: fetch it ONCE with the read tool at offset 1, limit 5000 (one call — whatever comes back is handled by the system). '
    + 'Step 2: answer using the chapters_artifact tool ONLY (never another whole-file read): (a) how many lines start with "## Chapter"; (b) the exact token beginning EMBED- that is buried near chapter 21 (use search). '
    + 'Final answer: one short line "<count> chapters; <token>".',
    1_000_000, false)

  const rows = parseRows(sessionLogTextById(sid))

  // --- the arrival pair landed
  const prunes = rows.filter((r) => r.type === 'compaction/prune' && r.raw.includes('dsh-chapters-arrival'))
  expect(prunes.length, 'at least one arrival stub pair (one oversized read)').toBeGreaterThanOrEqual(1)
  expect(rows.some((r) => r.type === 'tool/result' && r.raw.includes('[dsh:artifact')), 'stubbed tool/result present').toBe(true)
  expect(rows.some((r) => r.type === 'user/message' && r.raw.includes('auto-generated checkpoint')),
    'production threshold 0.9 ⇒ NO compaction was needed — arrival did it alone').toBe(false)

  // --- the fingerprint blob never entered a model request
  const requestBlob = rows.filter((r) => r.type.startsWith('request/')).map((r) => r.raw).join('\n')
  const hasRequests = rows.some((r) => r.type.startsWith('request/'))
  if (hasRequests) expect(requestBlob, 'blob fingerprint leaked into a request — arrival stubbing failed').not.toContain(FINGERPRINT)

  // --- the model worked the artifact and surfaced facts that only exist inside it
  const finalText = rows.filter((r) => r.type === 'assistant/message').map((r) => r.raw).join('\n')
  expect(finalText, 'model never found the buried token via the artifact tool').toContain(CENTER_TOKEN)
  expect(finalText).toContain('40')
  const artifactCalls = rows.filter((r) => r.type === 'tool/call' && r.raw.includes('chapters_artifact'))
  expect(artifactCalls.length, 'chapters_artifact used to query, not re-read').toBeGreaterThanOrEqual(1)

  // --- sidecar: usage/cache observations after the stub (never a gate)
  const usages = rows.filter((r) => r.type === 'assistant/usage' || r.raw.includes('cacheReadTokens'))
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-arrival-notes.json'), JSON.stringify({
    at: new Date().toISOString(), bookBytes, prunes: prunes.length, artifactCalls: artifactCalls.length,
    usageCarryingEvents: usages.length, home: E2E_HOME,
  }, null, 1))
})
