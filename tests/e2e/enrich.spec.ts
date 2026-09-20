/**
 * P2 S6 — the enrichment scenario, end to end through the real UI and the
 * tape: /compact archives a chapter (deterministic, zero-token), then
 * /chapters-enrich run drives ONE ladder call (record §6.1) and the durable
 * plane must show it: model title + generated: provenance in the chapter
 * frontmatter, the verbatim body byte-identical, and a clean report.
 * The recording pass also captures the enrichment exchange into
 * var/model-tape/enrich; replays then prove the ladder plumbing without GPU.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, typeComposer, ROOT } from './session.ts'

const storeRoot = path.join(ROOT, '.dsh-chapters')

function chapterFile(sid: string): string {
  const dir = path.join(storeRoot, sid, 'chapters')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []
  return files.length > 0 ? path.join(dir, files[0]!) : ''
}

test('an archived chapter enriches through the ladder with the body provably untouched', async ({ page }) => {
  test.setTimeout(900_000)
  await openApp(page)
  const sid = await newSessionWithTurn(page, 'What does the read tool do? One sentence, no tools.')
  await typeComposer(page, '/compact ')
  await expect.poll(async () => chapterFile(sid), { timeout: 360_000, intervals: [2000] }).not.toBe('')
  const f = chapterFile(sid)
  const before = fs.readFileSync(f, 'utf8')
  const bodyBefore = before.slice(before.indexOf('\n---\n') + 5)

  await typeComposer(page, '/chapters-enrich run ')
  await expect.poll(() => {
    const now = chapterFile(sid)
    const text = now === '' ? '' : fs.readFileSync(now, 'utf8')
    return text.includes('generated:') ? 'yes' : ''
  }, { timeout: 420_000, intervals: [3000] }).toBe('yes')
  const after = fs.readFileSync(chapterFile(sid), 'utf8')
  expect(after).toContain('generated:')
  expect(after.slice(after.indexOf('\n---\n') + 5)).toBe(bodyBefore, 'the verbatim body must survive the sanctioned write')
  const fm = after.slice(0, after.indexOf('\n---\n'))
  expect(fm).toMatch(/model: \S/, 'provenance names the model author')

  await typeComposer(page, '/chapters-enrich report ')
  await expect.poll(async () => (await page.textContent('body'))?.includes('pending'), { timeout: 60_000 }).toBe(true)
})
