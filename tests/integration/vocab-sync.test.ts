/**
 * The S4 pass inside the real sync machinery (fake driver, real fs, real
 * indexing): shadow reports, apply writes curation facts the index build
 * consumes, and search then crosses labels. No model, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, DEFAULT_CLONE_DIR, type ProjectRecord } from '../../src/sync.ts'
import { makeFakeDriver, makeFakeRemote } from '../support/fake-driver.ts'
import { searchKnowledge } from '../../src/search.ts'

const project: ProjectRecord = {
  projectKey: 'VK0', slug: 'vk', remote: 'https://example.invalid/vk.git',
  harnessId: 'h1', linkedAt: '2026-09-20T00:00:00Z', cwd: '',
}
const chapter = (title: string, topics: string[]) =>
  `---\ntitle: ${JSON.stringify(title)}\ntopics: [${topics.map((t) => JSON.stringify(t)).join(', ')}]\n---\n# ${title}\n\nbody text\n`

function tree(cwd: string) {
  const dir = path.join(cwd, '.dsh-chapters', 'sess-v1', 'chapters')
  fs.mkdirSync(dir, { recursive: true })
  // adjacent legacy fragments + heavy auth/authentication co-occurrence
  fs.writeFileSync(path.join(dir, '001-earlier-history.md'), chapter('Earlier history (seqs 1-9)', ['auth', 'pipelines']))
  fs.writeFileSync(path.join(dir, '002-earlier-history.md'), chapter('Earlier history (seqs 10-18)', ['authentication', 'pipelines']))
  fs.writeFileSync(path.join(dir, '003-more.md'), chapter('Earlier history (seqs 19-25)', ['auth']))
}

test('shadow mode reports candidates and writes nothing; apply mode lands a curation entry the index honors', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vkw-'))
  project.cwd = cwd
  tree(cwd)
  const driver = makeFakeDriver(makeFakeRemote())
  const opts = (apply: boolean) => ({
    cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR,
    project: { ...project }, force: true, driver,
    vocab: { apply, coMin: 3, overlapMin: 0.5 },
  })
  const shadowed = await runSync(opts(false))
  assert.ok(shadowed.ok, shadowed.detail)
  const vline = shadowed.steps.find((x) => x.startsWith('vocabulary:')) ?? ''
  assert.match(vline, /SHADOWED/, vline)
  assert.equal(fs.existsSync(path.join(cwd, DEFAULT_CLONE_DIR, 'edits')), false, 'shadow writes nothing')

  const applied = await runSync(opts(true))
  assert.ok(applied.ok, applied.detail)
  const editsFile = path.join(cwd, DEFAULT_CLONE_DIR, 'edits', 'h1', 'curation.jsonl')
  assert.ok(fs.existsSync(editsFile), 'applied merge wrote a curation file')
  const lines = fs.readFileSync(editsFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, lines.join('|'))
  const fact = JSON.parse(lines[0]!) as { type: string; from: string; to: string; reason: string }
  assert.equal(fact.type, 'topic-alias')
  assert.equal(fact.to, 'auth', 'frequent label survives')
  assert.match(fact.reason, /cooccur=|overlap=/)

  // search now crosses labels: querying the dead alias finds the surviving-topic chapters
  const hits = searchKnowledge(path.join(cwd, DEFAULT_CLONE_DIR), 'authentication pipelines', 600, { projectKey: 'VK0' })
  assert.ok(hits.total >= 1, JSON.stringify(hits.results?.length ?? 0))
  // stitch view also visible: one entry covers all three fragments
  const stitched = hits.results.find((r) => (r as { paths?: string[] }).paths !== undefined)
  assert.ok(stitched !== undefined, 'S5 stitching visible through search after S4 apply')
  fs.rmSync(cwd, { recursive: true, force: true })
})
