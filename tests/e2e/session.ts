import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Shared e2e session plumbing: specs create THEIR OWN session through the
 * real UI ('New session' → composer → one genuine Local-model turn) instead
 * of hunting legacy fixtures in a sidebar that has accumulated dozens of
 * probe sessions. Turn-complete is watched on the DURABLE plane (the engine
 * signature listener writes state.collections at every real turn/end — realm
 * info logs never reach stdout, r19), after the submit is confirmed on the
 * visible plane.
 */
export const ROOT = path.resolve(import.meta.dirname, '..', '..')
const REGISTRY = path.join(ROOT, '.dshdev-local', 'storages', 'dsh_chapters.json')

/** total turn-signature collections across all sessions (the durable plane). */
export function collectionTotal(): number {
  try {
    const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { tables?: { sessions?: Record<string, { collections?: unknown[] }> } }
    return Object.values(d.tables?.sessions ?? {}).reduce((n, st) => n + (st.collections?.length ?? 0), 0)
  } catch { return -1 }
}

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
  await dismissTestingNotice(page)
}

/**
 * The app's 'Internal Testing Notice' dialog is a FOCUS TRAP: while open,
 * every click on the composer, the sidebar, and 'New session' silently
 * bounced (activeElement stayed on the dialog's H2 — the whole e2e debugging
 * saga of 2026-09-18). Dismissing it is the FIRST thing any browser flow
 * must do.
 */
export async function dismissTestingNotice(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dlg = Array.from(document.querySelectorAll('div')).find((d) => (d.textContent ?? '').includes('Internal Testing Notice') && d.querySelector('button'))
    const btn = Array.from(dlg?.querySelectorAll('button') ?? []).find((b) => /^continue$/i.test((b.textContent ?? '').trim()))
    ;(btn as HTMLButtonElement | undefined)?.click()
  })
  await page.waitForTimeout(1000)
}

/**
 * Focus the composer with a TRUSTED pointer click at its center — JS
 * .focus() never armed this editor (measured: text went nowhere) and the
 * actionability .click() stalls behind the app's tooltip layer (measured:
 * 7 minutes of 'visible, enabled and stable'). Then VERIFY the caret; fail
 * loud with the active element named — every silent step here cost a full
 * suite round this week.
 */
export async function focusComposer(page: Page): Promise<void> {
  const composer = page.locator('div[aria-label^="Message or run a task"]')
  await composer.waitFor({ state: 'attached', timeout: 15_000 })
  const box = await composer.boundingBox()
  if (box === null) throw new Error('composer has no box')
  await page.mouse.click(box.x + Math.min(60, box.width / 2), box.y + box.height / 2)
  await page.waitForTimeout(400)
  const focused = await page.evaluate(() => {
    const ae = document.activeElement
    return ae !== null && (ae.matches('div[aria-label^="Message or run a task"]') || ae.closest('div[aria-label^="Message or run a task"]') !== null)
  })
  if (!focused) {
    const ae = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none')
    throw new Error(`composer did not take focus (active: ${ae})`)
  }
}

/**
 * Type via insertText (one real input event — contenteditable editors can
 * ignore synthetic keystroke streams) and submit VERIFIED: the send button
 * path worked on calm transcripts but silently failed after a heavy turn
 * (oversized-turn run 6: focus verified, message never arrived), so every
 * stage now checks itself and the Enter retry is a fallback that must also
 * show the text leaving the composer. Failures carry full diagnostics.
 */
export async function typeComposer(page: Page, line: string): Promise<void> {
  await focusComposer(page)
  await page.keyboard.insertText(line)
  const composerSel = 'div[aria-label^="Message or run a task"]'
  const inEditor = await page.evaluate((sel) => (document.querySelector(sel)?.textContent ?? '').includes(line.slice(0, 24)), composerSel)
  if (!inEditor) throw new Error(`insertText did not reach the composer (head: ${(await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? 'ABSENT', composerSel)).slice(0, 60)})`)
  const emptied = async (): Promise<boolean> => page.evaluate((sel) => (document.querySelector(sel)?.textContent ?? '').trim().length === 0, composerSel)
  const send = page.locator('button[aria-label="Send message"]')
  if (await send.count() > 0 && await send.first().isEnabled().catch(() => false)) {
    await send.first().click({ force: true })
    for (let i = 0; i < 16 && !(await emptied()); i++) await page.waitForTimeout(500)
    if (await emptied()) return
  }
  await page.keyboard.press('Enter')
  for (let i = 0; i < 16 && !(await emptied()); i++) await page.waitForTimeout(500)
  if (await emptied()) return
  const diag = await page.evaluate((sel) => {
    const btn = document.querySelector('button[aria-label="Send message"]')
    const b = btn?.getBoundingClientRect()
    const topAt = b !== undefined ? (document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.getAttribute('aria-label') ?? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.tagName ?? 'nil') : 'no-button'
    return { sendTop: topAt, disabled: (btn as HTMLButtonElement | null)?.disabled ?? 'absent', left: (document.querySelector(sel)?.textContent ?? '').slice(0, 40) }
  }, composerSel)
  throw new Error(`composer never emptied after send+Enter (send covered by: ${diag.sendTop}, disabled: ${String(diag.disabled)}, text left: "${diag.left}")`)
}

/** Create a session via the top 'New session' button (JS-dispatched click —
 * the pointer path is tooltip-intercepted) and complete one real turn. */
export async function newSessionWithTurn(page: Page, question: string, turnMs = 420_000, actionGraceMs = 20_000 | false): Promise<void> {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      .find((b) => /New Session/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined
    btn?.click()
  })
  await page.waitForTimeout(3000)
  const mark = collectionTotal()
  await typeComposer(page, question)
  await expect(page.getByText(question.slice(0, 30), { exact: false }).first(), 'user message rendered (submit worked)').toBeVisible({ timeout: 30_000 })
  await expect.poll(() => collectionTotal() > mark, { timeout: turnMs, intervals: [2500] }, 'turn to complete (signature collected at turn/end)').toBe(true)
  // actionGraceMs=false: skip the per-row action probe entirely (a heavy
  // turn may have ended without a text-bearing assistant row until the NEXT
  // render settles; the fork-button spec owns that affordance's assertion).
  if (actionGraceMs !== false) {
    await expect(page.locator('button[aria-label="Fork with chapters"]').first(), 'assistant row exposes the fork action').toBeVisible({ timeout: actionGraceMs })
  }
}
