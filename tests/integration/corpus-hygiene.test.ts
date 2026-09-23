/**
 * Corpus hygiene, end to end (knowledge-repo.md §15 amendment, "host-injected
 * context is not conversation"): a session whose log carries a project's own
 * instruction text (the sentinel stands in for it) is archived, published to
 * the remote, and pulled by a second machine. The instruction bytes must appear
 * NOWHERE along the path — not in the chapter file, not on the remote, not in
 * machine B's mirror, not in what machine B's search surfaces — while the human
 * conversation survives verbatim and the omission is marked and countable.
 *
 * The durable session log is out of reach of every write here by construction:
 * the renderer only ever reads events (invariant: append-only log), which is
 * what makes this a screen at the archive chokepoint, not a rewrite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderChapter } from '../../src/render.ts'
import { runSync, DEFAULT_CLONE_DIR } from '../../src/sync.ts'
import { searchKnowledge } from '../../src/search.ts'
import { makeFakeRemote, makeFakeDriver } from '../support/fake-driver.ts'
import type { SessionEventLike } from '../../src/types.ts'

const SENTINEL = 'PROJECT-SENTINEL the private rules of some other workspace'

const ev = (seq: number, data: Record<string, unknown>, type = 'user/message'): SessionEventLike => ({
  type, seq, time: 0, data: { id: `e${seq}`, ...data },
})

test('a chapter archived from an injected-context session carries no instruction bytes — and syncs that way', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chapters-hygiene-'))
  const machineA = path.join(root, 'machine-a')
  const storeDir = path.join(machineA, '.dsh-chapters', 'rootS')

  // The session log: human asks (with a reminder riding INSIDE the message),
  // an injected instruction event, our own TOC notice (plugin), an answer.
  const events = [
    ev(0, { source: { kind: 'user' }, content: [{ type: 'text', text: `please fix login\n\n<system-reminder>\ninstructions from: AGENTS.md\n${SENTINEL}\n</system-reminder>` }] }),
    ev(1, { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: `${SENTINEL} (whole-event form)` }] }),
    ev(2, { source: { kind: 'plugin', plugin: 'dsh-chapters' }, content: [{ type: 'text', text: `${SENTINEL} (toc-notice form)` }] }),
    ev(3, { content: [{ type: 'text', text: 'the patched line is src/login.ts:42' }] }, 'assistant/message'),
  ]
  const chapter = renderChapter(events, { title: 'login-fix', summary: 'fixed login', startSeq: 0, endSeq: 3 }, {
    toolResultDeferFloorTokens: 200, chapterTokenTarget: 8000,
  })

  // The chapter itself: conversation verbatim, injections marked, sentinel gone.
  assert.ok(!chapter.markdown.includes(SENTINEL), 'chapter body must not carry the sentinel')
  assert.ok(chapter.markdown.includes('please fix login'), 'human text survives')
  assert.ok(chapter.markdown.includes('src/login.ts:42'), 'assistant text survives')
  const marks = chapter.markdown.match(/⟦omitted:host-injected/g)
  assert.ok(marks !== null && marks.length >= 3, 'each injected form leaves its own marker (span + 2 events)')

  // Publish through the real sync loop (fake driver models the remote), then
  // pull on machine B and search there.
  fs.mkdirSync(path.join(storeDir, 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(storeDir, 'chapters', '001-login-fix.md'), chapter.markdown)
  const remote = makeFakeRemote()
  const driver = makeFakeDriver(remote)
  const project = { projectKey: 'HYG', slug: 'hyg', remote: 'https://remote.example/h.git', harnessId: 'h-a', linkedAt: 'now' }
  const synced = await runSync({ cwd: machineA, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project, provider: driver, force: true })
  assert.ok(synced.ok, synced.detail)

  const published = [...remote.files.entries()].filter(([k]) => k.endsWith('001-login-fix.md'))
  assert.equal(published.length, 1)
  assert.ok(!published[0]![1].includes(SENTINEL), 'remote bytes carry no instruction text')
  assert.ok(published[0]![1].includes('⟦omitted:host-injected'), 'the marker traveled — omissions are visible in the shared corpus')

  const machineB = path.join(root, 'machine-b')
  fs.mkdirSync(machineB)
  const pulledB = await runSync({ cwd: machineB, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: { ...project, harnessId: 'h-b' }, provider: driver, force: true })
  assert.ok(pulledB.ok, pulledB.detail)
  const mirrorFile = path.join(machineB, DEFAULT_CLONE_DIR, 'chapters', 'HYG', 'rootS', '001-login-fix.md')
  const bText = fs.readFileSync(mirrorFile, 'utf8')
  assert.ok(!bText.includes(SENTINEL))

  // And machine B's search over its mirror can never surface instruction text:
  // it finds the chapter for the HUMAN words, and nothing for the sentinel.
  const hit = searchKnowledge(path.join(machineB, DEFAULT_CLONE_DIR), 'login fix', 400)
  assert.ok(hit.results.some((r) => r.path.includes('001-login-fix')), 'the chapter is discoverable by its real content')
  const miss = searchKnowledge(path.join(machineB, DEFAULT_CLONE_DIR), 'PROJECT SENTINEL private rules workspace', 400)
  assert.ok(!miss.line.includes(SENTINEL), 'search output can never quote instruction bytes (they are not in the corpus)')
})

test('chapters written before the screen existed still publish (append-only store, no migration)', async () => {
  // A legacy-shaped chapter (may contain an old inline reminder) is data on
  // disk: the sync layer publishes bytes as they are. Hygiene is enforced at
  // the RENDER chokepoint going forward; rewriting stored files would violate
  // §1.3, and the one sanctioned mutation (body-hash-guarded enrichment)
  // touches frontmatter only. This test pins that we did NOT sneak a store
  // rewrite into this change.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chapters-legacy-'))
  const storeDir = path.join(root, '.dsh-chapters', 'oldS', 'chapters')
  fs.mkdirSync(storeDir, { recursive: true })
  const legacy = '---\ntitle: "legacy"\n---\n# legacy\n\n<system-reminder>old inline content</system-reminder>\n'
  fs.writeFileSync(path.join(storeDir, '000-legacy.md'), legacy)
  const remote = makeFakeRemote()
  const driver = makeFakeDriver(remote)
  const res = await runSync({
    cwd: root, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR,
    project: { projectKey: 'LEG', slug: 'leg', remote: 'https://remote.example/l.git', harnessId: 'h-l', linkedAt: 'now' },
    provider: driver, force: true,
  })
  assert.ok(res.ok, res.detail)
  assert.equal(remote.files.get(path.join('chapters', 'LEG', 'oldS', '000-legacy.md')), legacy,
    'sync is transport: it ships what the store holds, unchanged')
})
