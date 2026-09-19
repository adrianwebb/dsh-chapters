import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { openApp, newSessionWithTurn, typeComposer, localModelUp, currentSessionId, sessionLogTextById, ROOT } from './session.ts'

/**
 * The record §13 P1 exit criterion as a browser journey on a session this
 * spec created with a real turn:
 *
 *   /chapters-link (composer) → REAL git smart-HTTP remote receives the
 *   workspace knowledge (chapters + derived index, read back through the
 *   product's own isomorphic-git clone path) → /chapters-status reports
 *   synced → the fork carries the knowledge forward (child TOC shows the
 *   Project line and §7.3 message counts) → the debounced post-archive push
 *   lands collections JSONL on the remote → a second machine, fresh
 *   workspace, same remote: sync + chapters_search FINDS the first
 *   machine's chapter.
 */
const registryPath = path.join(ROOT, '.dshdev-local', 'storages', 'dsh_chapters.json')
const statusPath = path.join(ROOT, '.dsh-chapters', '.sync-status.json')
const sessDir = path.join(ROOT, '.dshdev-local', 'sessions', '--home-adrian-Projects-dsh-chapters--')

const readRegistry = () => {
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      tables: { projects: Record<string, { projectKey: string; remote: string; cwd: string; slug: string; harnessId: string; linkedAt: string }>; sessions: Record<string, { parentSession?: string | null }> }
    }
  } catch { return { tables: { projects: {}, sessions: {} } } }
}
const projectRecords = () => Object.values(readRegistry().tables.projects ?? {})
const childCount = () => Object.values(readRegistry().tables.sessions).filter((s) => typeof s.parentSession === 'string').length

test('the knowledge loop end to end over a real git remote, from the browser', async ({ page }) => {
  test.setTimeout(840_000)
  test.skip(!(await localModelUp()), 'Local model server not running')
  const httpMod = await import('../integration/http-git-server.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-git-'))
  const server = await httpMod.startGitHttpServer(path.join(tmp, 'gitserver'))
  test.skip(server === null, 'git http-backend unavailable')
  const repoUrl = server!.serveRepo('kb-e2e.git')
  try {
    await openApp(page)
    const sid = await newSessionWithTurn(page, 'Which file defines the chapter composer merge rule? Use only file reads (no shell commands); answer with the file and the rule in one sentence.')

    // ---- 1. link through the composer; the immediate pass PUSHES for real
    await typeComposer(page, `/chapters-link ${repoUrl} tok-e2e`)
    await expect.poll(() => projectRecords().some((r) => r.remote === repoUrl), { timeout: 30_000, intervals: [1000] }).toBe(true)
    const { remoteFiles } = httpMod
    await expect.poll(async () => {
      try {
        const files = await remoteFiles(repoUrl, 'tok-e2e')
        return files.some((f) => f.startsWith('chapters/') && f.endsWith('.md')) && files.some((f) => f.startsWith('index/'))
      } catch { return false }
    }, { timeout: 90_000, intervals: [3000] }).toBe(true)

    // ---- 2. status command: synced, with the numbers behind it
    await typeComposer(page, '/chapters-status ')
    await expect.poll(() => {
      try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')).mode } catch { return null }
    }, { timeout: 30_000, intervals: [1000] }).toBe('synced')

    // ---- 3. fork carries the knowledge: Project line + message counts in
    // the child — identified EXACTLY: the app switches the live session to
    // the child, and localStorage names it (no freshest-file guessing).
    const before = childCount()
    await page.locator('button[aria-label="Fork with chapters"]').first().click()
    await expect.poll(() => childCount(), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(before)
    let kid: string | null = null
    await expect.poll(async () => { const cur = await currentSessionId(page); if (cur !== null && cur !== sid) { kid = cur; return true } return false },
      { timeout: 60_000, intervals: [1000] }, 'app switches to the child session').toBe(true)
    await expect.poll(() => sessionLogTextById(kid!).includes('Project:'), { timeout: 30_000, intervals: [1000] }, 'child TOC cites the project').toBe(true)
    expect(sessionLogTextById(kid!)).toMatch(/\(\d+ msgs\)/)

    // ---- 4. the debounced post-archive push lands the collections JSONL (§4.1 → §5)
    await expect.poll(async () => {
      try { return (await remoteFiles(repoUrl, 'tok-e2e')).some((f) => f.startsWith('collections/')) } catch { return false }
    }, { timeout: 90_000, intervals: [4000] }).toBe(true)

    // ---- 5. second machine: fresh workspace, same remote, search finds the work
    const { runSync, DEFAULT_CLONE_DIR } = await import('../../src/sync.ts')
    const { searchKnowledge } = await import('../../src/search.ts')
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-machine-b-'))
    try {
      const rec = projectRecords().find((r) => r.remote === repoUrl)
      expect(rec).toBeDefined()
      const sync = await runSync({
        cwd: cwd2, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR,
        project: rec!, token: 'tok-e2e', force: true,
      })
      expect(sync.ok, `machine B sync: ${sync.detail} | ${sync.steps.join('; ')}`).toBe(true)
      const hits = searchKnowledge(path.join(cwd2, DEFAULT_CLONE_DIR), 'composer merge rule chapter', 600)
      expect(hits.total).toBeGreaterThanOrEqual(1)
      expect(hits.results[0]!.path).toMatch(/^chapters\//)
    } finally {
      fs.rmSync(cwd2, { recursive: true, force: true })
    }
  } finally {
    await server!.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
