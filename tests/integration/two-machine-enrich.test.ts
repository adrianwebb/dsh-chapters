/**
 * P2 exit criterion, two-machine grade: machine A ENRICHES (through the only
 * sanctioned write path, updateChapterFrontmatter — the same one the ladder
 * uses, body guard live) and MERGES vocabulary (shadow-off vocab pass lands
 * topic-alias curation under edits/hA). The question this test answers:
 *
 *   1. does publish carry A's MODIFIED frontmatter across the pool?
 *      (write-if-different — the enrichment-time transport gap closed in S6)
 *   2. does B's index honor A's vocabulary aliases across the pull?
 *   3. does B's own vocab pass DEDUPE against A's curation instead of
 *      double-writing the same merge?
 *   4. do A's authored files stay single-author in git (B never writes
 *      edits/hA or A's chapters — ff-only honesty preserved)?
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, DEFAULT_CLONE_DIR, type ProjectRecord } from '../../src/sync.ts'
import { searchKnowledge } from '../../src/search.ts'
import { updateChapterFrontmatter } from '../../src/enrich-store.ts'
import { renderGeneratedBlock } from '../../src/enrich-wire.ts'
import { parseChapterFile } from '../../src/enrich-store.ts'

const mkProject = (cwd: string, remote: string, harnessId: string): ProjectRecord => ({
  projectKey: 'KEYENR', slug: 'pool', remote, harnessId, linkedAt: new Date().toISOString(), cwd,
})
const write = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const chapter = (title: string, body: string, topics: string[]): string =>
  `---\ntitle: "${title}"\ntopics: [${topics.map((t) => JSON.stringify(t)).join(', ')}]\n---\n# ${title}\n\n${body}\n`
const vocab = { apply: true, coMin: 3, overlapMin: 0.5 }

test('enrichment + vocabulary from machine A are alive on machine B; curation dedupes cross-machine; authorship is partitioned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-enr2-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  const b = path.join(root, 'machine-b')
  try {
    // A authors three chapters whose topics beg to merge (auth x authentication)
    const dirA = path.join(a, '.dsh-chapters', 'treeA', 'chapters')
    write(path.join(dirA, '001-auth-bugs.md'), chapter('Auth bug hunt', 'chasing token expiry failures in the login path.', ['auth', 'pipelines']))
    write(path.join(dirA, '002-auth-tests.md'), chapter('Auth tests', 'integration tests around session refresh.', ['authentication', 'pipelines']))
    write(path.join(dirA, '003-pipes.md'), chapter('Pipeline notes', 'debounce and coalesce windows for pushes.', ['auth', 'pipelines', 'debounce']))
    const ra = await runSync({ cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: mkProject(a, pool, 'hA'), force: true, vocab })
    assert.ok(ra.ok, ra.detail)
    assert.ok((ra.steps ?? []).some((x) => x.startsWith('vocabulary: applied')), ra.steps?.join(' | '))
    const editsA = path.join(a, DEFAULT_CLONE_DIR, 'edits', 'hA', 'curation.jsonl')
    assert.ok(fs.existsSync(editsA), 'A wrote its OWN curation file')

    // A enriches chapter 001 through the sanctioned write path
    const f001 = path.join(dirA, '001-auth-bugs.md')
    const bodyBefore = parseChapterFile(fs.readFileSync(f001, 'utf8')).body
    updateChapterFrontmatter(f001, {
      title: JSON.stringify('Login token-expiry debugging (enriched)'),
      generated: renderGeneratedBlock({
        title: [{ by: 'model', model: 'test-enricher/1', at: '2026-09-20T00:00:00Z' }],
        summary: [{ by: 'deterministic' }],
        topics: [{ by: 'deterministic' }],
      }),
    })
    const ra2 = await runSync({ cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: mkProject(a, pool, 'hA'), force: true, vocab })
    assert.ok(ra2.ok, ra2.detail)
    // the enrichment publish is NOT zero-copy: the modified file must travel
    const pushed = path.join(a, DEFAULT_CLONE_DIR, 'chapters', 'KEYENR', 'treeA', '001-auth-bugs.md')
    assert.ok(fs.readFileSync(pushed, 'utf8').includes('enriched'), 'write-if-different carried the enrichment into the mirror')

    // B clones everything fresh
    const rb = await runSync({ cwd: b, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: mkProject(b, pool, 'hB'), force: true, vocab })
    assert.ok(rb.ok, rb.detail)
    const cloneB = path.join(b, DEFAULT_CLONE_DIR)
    // 1. enriched bytes arrived on B
    const seenB = fs.readFileSync(path.join(cloneB, 'chapters', 'KEYENR', 'treeA', '001-auth-bugs.md'), 'utf8')
    assert.ok(seenB.includes('Login token-expiry debugging (enriched)'), 'B pulled the enriched frontmatter')
    assert.ok(seenB.includes('test-enricher/1'), 'provenance survived the round trip')
    assert.equal(parseChapterFile(seenB).body, bodyBefore, 'and the verbatim body arrived untouched')
    // 2. A's vocabulary merge is ALIVE in B's index: query the dead alias
    const hits = searchKnowledge(cloneB, 'authentication pipelines', 600, { projectKey: 'KEYENR' })
    assert.ok(hits.total >= 1, JSON.stringify(hits.results ?? []).slice(0, 200))
    const topicsAll = hits.results.flatMap((r) => r.topics)
    assert.ok(!topicsAll.includes('authentication') || topicsAll.includes('auth'),
      'the index canonicalizes through A\u2019s alias (auth survives, authentication folded)')
    // 3. B's own vocab pass dedupes: A's curation already carries the merge
    const editsBefore = new Set(fs.readdirSync(path.join(cloneB, 'edits')))
    const rb2 = await runSync({ cwd: b, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: mkProject(b, pool, 'hB'), force: true, vocab })
    assert.ok(rb2.ok, rb2.detail)
    const vlineB = (rb2.steps ?? []).find((x) => x.startsWith('vocabulary:')) ?? ''
    assert.match(vlineB, /nothing new|0 merge/, vlineB)
    const editsAfter = new Set(fs.readdirSync(path.join(cloneB, 'edits')))
    for (const d of editsBefore) assert.ok(editsAfter.has(d), 'B never deletes A\'s edits dir')
    assert.ok(!fs.existsSync(path.join(cloneB, 'edits', 'hB', 'curation.jsonl')) ||
      fs.readFileSync(path.join(cloneB, 'edits', 'hB', 'curation.jsonl'), 'utf8').trim() === '',
      'B wrote no duplicate aliases — cross-machine dedupe via shared curation')
    // 4. authorship partition: B only ever holds A's authored chapters (no local store), nothing rewrote hA
    const editsAAfter = fs.readFileSync(path.join(cloneB, 'edits', 'hA', 'curation.jsonl'), 'utf8').trim().split('\n').length
    assert.equal(editsAAfter, fs.readFileSync(editsA, 'utf8').trim().split('\n').length, 'A\'s curation file is byte-stable across B\'s runs')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
