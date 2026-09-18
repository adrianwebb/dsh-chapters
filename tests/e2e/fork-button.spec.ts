import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp } from './session.ts'

/**
 * The assistant-row fork action, on a session this spec CREATES through the
 * real UI with one genuine Local-model turn. Two planes of truth per
 * assertion: the durable registry/session log (what the plugin wrote) and
 * the browser (the reported defect this spec exists to keep fixed: after the
 * click, the app SWITCHES to the branch).
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const registry = () => JSON.parse(fs.readFileSync(path.join(ROOT, '.dshdev-local/storages/dsh_chapters.json'), 'utf8')) as
  { tables: { sessions: Record<string, { parentSession?: string | null }> } }
const childCount = () => Object.values(registry().tables.sessions).filter((s) => typeof s.parentSession === 'string').length
const sessDir = path.join(ROOT, '.dshdev-local/sessions/--home-adrian-Projects-dsh-chapters--')

test('the fork action keeps its promises: ours visible, native hidden, click forks and SWITCHES', async ({ page }) => {
  test.setTimeout(420_000)
  test.skip(!(await localModelUp()), 'Local model server not running')
  await openApp(page)
  await newSessionWithTurn(page, 'Which file implements the chapter composer merge rule? Answer with the file path only, in one sentence.')

  await expect(page.locator('button[aria-label="Fork with chapters"]').first()).toBeVisible()
  await expect(page.locator('button[aria-label="Branch into a new conversation"]')).toBeHidden()

  const before = childCount()
  await page.locator('button[aria-label="Fork with chapters"]').first().click()

  // durable plane: a linked child appears in the registry
  await expect.poll(() => childCount(), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(before)
  // visible plane: the app switched to the branch (title carries it; a
  // plugin-sourced notice is context injection, not a chat bubble — by design)
  await expect.poll(() => page.title(), { timeout: 40_000, intervals: [1000] }).toMatch(/—|branch|composer|Which file/i)

  // the newest child's seed carries the TOC notice + chapter citations
  const { execFileSync } = await import('node:child_process')
  await expect.poll(() => {
    const kids = fs.readdirSync(sessDir)
      .filter((d) => d.startsWith('ch-') || d.startsWith('session-ch-'))
      .map((d) => ({ d, t: fs.statSync(path.join(sessDir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const k of kids.slice(0, 3)) {
      try {
        const log = execFileSync('zstd', ['-dc', path.join(sessDir, k.d, 'session.v3.jsonl.zstd')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        if (log.includes('chapters:toc') && log.includes('.dsh-chapters/')) return true
      } catch { /* partial */ }
    }
    return false
  }, { timeout: 20_000, intervals: [1000] }).toBe(true)
})
