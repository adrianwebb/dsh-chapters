import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

/**
 * Discovery pass: boots into the authenticated app and DUMPS the interactive
 * surface (buttons by aria-label, sidebar rows, plugin-load banners) to
 * var/e2e-discovery.json. This is the anti-guesswork layer: every later spec
 * derives its selectors from this artifact, and re-running it after any host
 * or plugin change shows the UI surface drift immediately.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('discover the live UI surface', async ({ page }) => {
  const boot = JSON.parse(fs.readFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), 'utf8')) as { url: string; base: string }
  const consoleErrors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(`${msg.type()}: ${msg.text()}`.slice(0, 200)) })
  const pageErrors: string[] = []
  page.on('pageerror', (err) => { pageErrors.push(String(err.message).slice(0, 200)) })

  await page.goto(boot.url, { waitUntil: 'domcontentloaded' })
  // let the SPA authenticate (token -> cookie), load client modules, render
  await page.waitForTimeout(6000)
  // the testing-notice dialog is a focus trap — dismiss before anything else
  await page.evaluate(() => {
    const dlg = Array.from(document.querySelectorAll('div')).find((d) => (d.textContent ?? '').includes('Internal Testing Notice') && d.querySelector('button'))
    const btn = Array.from(dlg?.querySelectorAll('button') ?? []).find((b) => /^continue$/i.test((b.textContent ?? '').trim()))
    ;(btn as HTMLButtonElement | undefined)?.click()
  })

  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
    .map((b) => ({
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      cls: (b.className ?? '').slice(0, 60),
      text: (b.textContent ?? '').trim().slice(0, 40),
    }))
    .slice(0, 120))
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('[role="treeitem"], nav a, [class*="session"]'))
    .map((el) => ({ role: el.getAttribute('role'), cls: (el.className ?? '').toString().slice(0, 60), text: (el.textContent ?? '').trim().slice(0, 60) }))
    .slice(0, 60))
  const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 1200))

  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-discovery.json'), JSON.stringify({
    urlAfter: page.url(),
    title: await page.title(),
    buttons,
    links,
    consoleErrors: consoleErrors.slice(0, 20),
    pageErrors: pageErrors.slice(0, 10),
    bodySnippet,
  }, null, 2))

  // Health assertions that encode what we already know must be true:
  expect(bodySnippet).not.toMatch(/did not activate/i)
  expect(bodySnippet).not.toMatch(/Failed to load plugins/i)
})
