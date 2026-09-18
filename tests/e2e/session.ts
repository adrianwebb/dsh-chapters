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

export async function newSessionWithTurn(page: Page, question: string, turnMs = 300_000): Promise<void> {
  await page.getByRole('button', { name: 'New session in dsh-chapters' }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('div[aria-label^="Message or run a task"]').click()
  await page.keyboard.type(question, { delay: 10 })
  await page.keyboard.press('Enter')
  // the assistant row's fork action exists once a reply rendered
  await expect(page.locator('button[aria-label="Fork with chapters"]').first(), 'assistant reply (turn complete)').toBeVisible({ timeout: turnMs })
}

export async function typeComposer(page: Page, line: string): Promise<void> {
  await page.locator('div[aria-label^="Message or run a task"]').click()
  await page.keyboard.type(line, { delay: 12 })
  await page.keyboard.press('Enter')
}
