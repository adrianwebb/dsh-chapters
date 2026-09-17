import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

/**
 * Behavior spec for the assistant-row fork action. Two planes of truth per
 * assertion: the registry file (what the plugin durably wrote) and the browser
 * (what the user actually sees after the click — including the switch to the
 * branch, the reported defect this spec exists to keep fixed).
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const registry = () => JSON.parse(fs.readFileSync(path.join(ROOT, '.dshdev-local/storages/dsh_chapters.json'), 'utf8')) as
  { tables: { sessions: Record<string, { parentSession?: string | null }> } }
const childCount = () => Object.values(registry().tables.sessions).filter((s) => typeof s.parentSession === 'string').length
function newestLinkedChild(): string | null {
  const dir = path.join(ROOT, '.dshdev-local/sessions/--home-adrian-Projects-dsh-chapters--')
  const kids = fs.readdirSync(dir).filter((d) => d.startsWith('session-ch-') || d.startsWith('ch-') || d.startsWith('session-')).map((d) => ({ d, t: fs.statSync(path.join(dir, d)).mtimeMs })).filter((x) => x.d.includes('ch-'))
  if (kids.length === 0) return null
  kids.sort((a, b) => b.t - a.t)
  return kids[0]!.d.replace(/^session-/, '')
}

async function openR29(page: import('@playwright/test').Page) {
  const boot = JSON.parse(fs.readFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), 'utf8')) as { url: string }
  await page.goto(boot.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  await page.locator('[role="treeitem"]', { hasText: 'R29 Research Session' }).first().click()
  await page.waitForTimeout(2500)
}

test('the row keeps its promises: ours present, native branch hidden', async ({ page }) => {
  await openR29(page)
  await expect(page.locator('button[aria-label="Fork with chapters"]')).toBeVisible()
  await expect(page.locator('button[aria-label="Branch into a new conversation"]')).toBeHidden()
})

test('clicking forks and the UI SWITCHES to the branch showing its TOC', async ({ page }) => {
  test.setTimeout(120_000)
  const logs: string[] = []
  const pageErrs: string[] = []
  page.on('console', (m) => { if (m.text().includes('dsh-chapters')) logs.push(m.text().slice(0, 240)) })
  page.on('pageerror', (e) => { pageErrs.push(String(e.message).slice(0, 240)) })
  await openR29(page)
  const childrenBefore = childCount()
  await page.locator('button[aria-label="Fork with chapters"]').first().click()

  // durable plane: a new linked child appears in the registry
  await expect.poll(() => childCount(), { timeout: 20_000, intervals: [500] }).toBeGreaterThan(childrenBefore)

  // visible plane: the app switched — the browser title carries the branch's
  // title (the ONLY view of it: a plugin-sourced notice is rendered as context
  // injection, not as a chat message — the chat opens empty by design).
  await expect.poll(() => page.title(), { timeout: 30_000, intervals: [500, 1000] }).toMatch(/branch —/)
  // The sidebar row is deliberately NOT asserted: this host hides never-
  // opened sessions from the list (measured 2026-09-17), yet sessions.open()
  // switches anyway — asserting the row would encode a host quirk we do not
  // own. Durable plane: the newest linked child exists and its seed carries
  // the TOC notice (read from the session file — zero UI drift).
  const kid = newestLinkedChild()
  expect(kid).not.toBeNull()
  const sessDir = path.join(ROOT, '.dshdev-local/sessions/--home-adrian-Projects-dsh-chapters--')
  const dirName = fs.readdirSync(sessDir).find((d) => d.includes(kid!.slice(0, 13)))
  expect(dirName).toBeDefined()
  const { execFileSync } = await import('node:child_process')
  const log = execFileSync('zstd', ['-dc', path.join(sessDir, dirName!, 'session.v3.jsonl.zstd')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  expect(log).toContain('chapters:toc')
  expect(log).toContain('.dsh-chapters/')
})
