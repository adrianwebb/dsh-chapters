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
import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, typeComposer, E2E_SESS_DIR } from './session.ts'

const RULE_TEXT = 'Never log raw tokens or bearer headers anywhere in command output'

function childLogWithRule(after: Set<string>): string {
  // r39 mystery, solved 2026-09-22: session logs are DIRECTORIES containing a
  // zstd-compressed session.v3.jsonl.zstd — the original readFileSync of a
  // directory entry always threw, so this poll could never succeed regardless
  // of product behavior. Decompress via the same zstd route session.ts uses.
  let dirs: string[] = []
  try { dirs = fs.readdirSync(E2E_SESS_DIR) } catch { return '' }
  for (const dir of dirs) {
    if (after.has(dir) || !dir.startsWith('ch-')) continue
    try {
      const t = execFileSync('zstd', ['-dc', path.join(E2E_SESS_DIR, dir, 'session.v3.jsonl.zstd')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      if (t.includes('CORE RULES') && t.includes(RULE_TEXT)) return dir
    } catch { /* not flushed yet */ }
  }
  return ''
}

test('a rule proposed and approved in the UI renders verbatim into the next continuation', async ({ page }) => {
  test.setTimeout(900_000)
  await openApp(page)
  // commands need a REAL session to render flow nodes into — the draft screen
  // turns composer text into a first message, not a command (r38 lesson)
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-rules-pool-'))
  await newSessionWithTurn(page, 'Reply with exactly one short sentence naming an HTTP redirect status code. Make ZERO tool calls.')
  await typeComposer(page, `/chapters-link ${path.join(pool, 'pool.git')} `)
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('pool'), { timeout: 120_000 }).toBe(true)

  await typeComposer(page, `/chapters-rule add security ${RULE_TEXT}`)
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('proposed'), { timeout: 60_000 }).toBe(true)
  // approve the id add actually returned (rule files are write-once; a dirty
  // store advances the number — hard-coding 001 would approve a different rule)
  const ruleId = await expect.poll(async () => {
    const m = /rule (\S+\/\d{3}) proposed/.exec((await page.textContent('body')) ?? '')
    return m?.[1] ?? ''
  }, { timeout: 30_000 }).not.toBe('')
  void ruleId
  const approveTarget = /rule (\S+\/\d{3}) proposed/.exec((await page.textContent('body')) ?? '')?.[1] ?? ''
  await typeComposer(page, `/chapters-rule approve ${approveTarget} `)
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('CORE on THIS machine'), { timeout: 60_000 }).toBe(true)

  const before = new Set<string>((() => { try { return fs.readdirSync(E2E_SESS_DIR) } catch { return [] } })())
  await page.locator('button[aria-label="Fork with chapters"]').first().click({ force: true })
  let childDir = ''
  await expect.poll(() => { childDir = childLogWithRule(before); return childDir; }, { timeout: 600_000, intervals: [3000] }).not.toBe('')
  const text = execFileSync('zstd', ['-dc', path.join(E2E_SESS_DIR, childDir, 'session.v3.jsonl.zstd')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  expect(text).toContain('CORE RULES')
  expect(text).toContain(RULE_TEXT)
  fs.rmSync(pool, { recursive: true, force: true })
})
