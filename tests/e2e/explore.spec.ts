import fs from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('explore a session with assistant messages', async ({ page }) => {
  const boot = JSON.parse(fs.readFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), 'utf8')) as { url: string }
  await page.goto(boot.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  // click into R29 session
  await page.locator('[role="treeitem"]', { hasText: 'R29 Research Session' }).first().click()
  await page.waitForTimeout(5000)
  const dump = await page.evaluate(() => {
    const aria = Array.from(document.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label')!).filter((v, i, a) => a.indexOf(v) === i)
    const msgs = Array.from(document.querySelectorAll('[class*="essage"], [class*="_turn"], article, li[data-message-id]'))
      .slice(0, 40).map((el) => ({ tag: el.tagName, cls: (el.className ?? '').toString().slice(0, 70), aria: el.getAttribute('data-message-id'), text: (el.textContent ?? '').trim().slice(0, 50) }))
    const url = location.href
    return { url, aria, msgs }
  })
  // hover the last assistant-ish block to see if actions appear
  const target = page.locator('[aria-label="Fork with chapters"]')
  const beforeHover = await target.count()
  let afterHover = beforeHover
  if (beforeHover === 0) {
    await page.mouse.move(600, 400)
    const anyMsg = dump.msgs.find((m) => m.text.length > 0)
    if (anyMsg !== undefined) {
      const box = await page.locator(`text=${anyMsg.text.slice(0, 24)}`).first().boundingBox().catch(() => null)
      if (box !== null) await page.mouse.move(box.x + 20, box.y + 20)
    }
    await page.waitForTimeout(1200)
    afterHover = await target.count()
  }
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-explore.json'), JSON.stringify({ ...dump, forkBeforeHover: beforeHover, forkAfterHover: afterHover }, null, 2))
})
