/**
 * P3 S6 — the rule lifecycle end to end in the browser, over a local-path
 * pool: add (proposed) -> approve (per-machine fact) -> real turn (tape) ->
 * UI fork -> the CHILD's own log carries the rule verbatim inside the
 * notice. The child's first durable event is the strongest possible proof:
 * the notice bytes the child session actually starts from.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, typeComposer, E2E_SESS_DIR } from './session.ts'

const RULE_TEXT = 'Never log raw tokens or bearer headers anywhere in command output'

function childLogWithRule(after: Set<string>): string {
  for (const f of fs.readdirSync(E2E_SESS_DIR)) {
    if (after.has(f)) continue
    try {
      const t = fs.readFileSync(path.join(E2E_SESS_DIR, f), 'utf8')
      if (t.includes('CORE RULES') && t.includes('Never log raw tokens')) return f
    } catch { /* not a log file */ }
  }
  return ''
}

test('a rule proposed and approved in the UI renders verbatim into the next continuation', async ({ page }) => {
  test.setTimeout(900_000)
  await openApp(page)
  // commands need a REAL session to render flow nodes into — the draft screen
  // turns composer text into a first message, not a command (r38 lesson)
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-rules-pool-'))
  await newSessionWithTurn(page, 'Name one HTTP status code for a redirect. One short sentence, no tools.')
  await typeComposer(page, `/chapters-link ${path.join(pool, 'pool.git')} `)
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('pool'), { timeout: 120_000 }).toBe(true)

  await typeComposer(page, `/chapters-rule add security ${RULE_TEXT}`)
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('proposed'), { timeout: 60_000 }).toBe(true)
  await typeComposer(page, '/chapters-rule approve 001 ')
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('CORE on THIS machine'), { timeout: 60_000 }).toBe(true)

  const before = new Set(fs.readdirSync(E2E_SESS_DIR))
  await page.locator('button[aria-label="Fork with chapters"]').first().click({ force: true })
  const logFile = await expect.poll(() => childLogWithRule(before), { timeout: 600_000, intervals: [3000] }).not.toBe('')
  void logFile
  const text = fs.readFileSync(path.join(E2E_SESS_DIR, childLogWithRule(before)), 'utf8')
  expect(text).toContain('CORE RULES')
  expect(text).toContain(RULE_TEXT)
  fs.rmSync(pool, { recursive: true, force: true })
})
