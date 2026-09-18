import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Shared e2e session plumbing: specs create THEIR OWN session through the
 * real UI ('New session in dsh-chapters' → composer → one genuine turn on
 * the Local model) instead of hunting legacy fixtures in a sidebar that has
 * since accumulated dozens of probe sessions. The turn-complete signal the
 * specs can see is the assistant row's fork action — the same affordance
 * under test.
 */
export const ROOT = path.resolve(import.meta.dirname, '..', '..')

export async function localModelUp(): Promise<boolean> {
  try {
    const r = await fetch('http://localhost:8080/v1/models', { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return false
  }
}

export async function openApp(page: Page): Promise<void> {
  const boot = JSON.parse(fs.readFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), 'utf8')) as { url: string }
  await page.goto(boot.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
}

const REGISTRY = path.join(ROOT, '.dshdev-local', 'storages', 'dsh_chapters.json')
/** total turn-signature collections across all sessions (the durable plane the
 * engine listener writes to at every real turn/end). */
export function collectionTotal(): number {
  try {
    const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { tables?: { sessions?: Record<string, { collections?: unknown[] }> } }
    return Object.values(d.tables?.sessions ?? {}).reduce((n, st) => n + (st.collections?.length ?? 0), 0)
  } catch { return -1 }
}

/**
 * Create a session the way a human does: hover the workspace row (its
 * 'New session in dsh-chapters' icon button is hover-rendered — the plain
 * button is the fallback), ask one real question, and wait for the TURN to
 * complete. Turn-complete is watched on the durable plane — the realm
 * engine's 'signature collected' info line lands in the server log at every
 * real turn/end — with the assistant row's fork action as the UI-side
 * confirmation just after.
 */
export async function newSessionWithTurn(page: Page, question: string, turnMs = 480_000): Promise<void> {
  const ws = page.locator('[role="treeitem"]').filter({ hasText: 'dsh-chapters' }).first()
  await ws.hover()
  await page.waitForTimeout(500)
  const inWs = page.getByRole('button', { name: 'New session in dsh-chapters' })
  if (await inWs.count() > 0) await inWs.first().click()
  else await page.getByRole('button', { name: 'New session' }).first().click()
  await page.waitForTimeout(2500)
  const mark = collectionTotal()
  await page.locator('div[aria-label^="Message or run a task"]').click()
  await page.keyboard.type(question, { delay: 10 })
  await page.keyboard.press('Enter')
  // turn-complete signal on the DURABLE plane: the engine's signature listener
  // writes state.collections at turn/end (realm logs never reach stdout — r19).
  await expect.poll(() => collectionTotal() > mark, { timeout: turnMs, intervals: [2500] }, 'turn to complete (signature collected at turn/end)').toBe(true)
  await expect(page.locator('button[aria-label="Fork with chapters"]').first(), 'assistant row exposes the fork action').toBeVisible({ timeout: 15_000 })
}

export async function typeComposer(page: Page, line: string): Promise<void> {
  await page.locator('div[aria-label^="Message or run a task"]').click()
  await page.keyboard.type(line, { delay: 12 })
  await page.keyboard.press('Enter')
}
