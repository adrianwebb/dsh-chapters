import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseChapterFile, bodyHash, updateChapterFrontmatter } from '../../src/enrich-store.ts'

function chapterFile(text = '# body\nhello\n'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-'))
  const f = path.join(dir, '001-x.md')
  fs.writeFileSync(f, `---\nnumber: 1\ntitle: "Old Title"\ntopics: [a, b]\n---\n${text}`)
  return f
}

test('round trip: untouched file rewrites to byte-identical text via no-change update', () => {
  const f = chapterFile()
  const before = fs.readFileSync(f, 'utf8')
  const r = updateChapterFrontmatter(f, { title: '"Old Title"' })
  assert.equal(r.changed, false)
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'no-op must not touch the file')
})

test('field update: replaces in place, preserves order and body byte-for-byte', () => {
  const f = chapterFile()
  const r = updateChapterFrontmatter(f, { title: '"New Title"', extra: 'yes' })
  assert.equal(r.changed, true)
  const text = fs.readFileSync(f, 'utf8')
  assert.ok(text.includes('number: 1\ntitle: "New Title"\ntopics: [a, b]\nextra: yes\nsha256:'), text)
  assert.equal(r.body, '# body\nhello\n')
  assert.equal(bodyHash(parseChapterFile(text).body), bodyHash('# body\nhello\n'))
})

test('body-hash guard: registry mismatch refuses WITHOUT writing', () => {
  const f = chapterFile()
  const before = fs.readFileSync(f, 'utf8')
  assert.throws(() => updateChapterFrontmatter(f, { title: 'x' }, 'deadbeef'), /!= registry/)
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'refusal must leave the file untouched')
})

test('a writing update stamps bodySha256; later writes verify against it', () => {
  const f = chapterFile()
  updateChapterFrontmatter(f, { title: '"T2"' })
  const doc = parseChapterFile(fs.readFileSync(f, 'utf8'))
  assert.equal(doc.fmLines.find((l) => l.startsWith('sha256:'))?.split(': ')[1], bodyHash(doc.body))
  // simulate body corruption -> next sanctioned write must refuse
  const text = fs.readFileSync(f, 'utf8')
  fs.writeFileSync(f, text.replace('hello', 'HELDERANGED'))
  assert.throws(() => updateChapterFrontmatter(f, { title: '"T3"' }), /body altered on disk/)
})

test('block values (generated chains) replace their key and indented continuation lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-'))
  const f = path.join(dir, '002-y.md')
  fs.writeFileSync(f, '---\nnumber: 2\ntitle: "T"\ngenerated:\n  title:\n    - by: model\n      model: m1\n---\nbody\n')
  updateChapterFrontmatter(f, { generated: '\n  title:\n    - by: model\n      model: m2\n' })
  const doc = parseChapterFile(fs.readFileSync(f, 'utf8'))
  const fm = doc.fmLines.join('\n')
  assert.ok(fm.includes('model: m2') && !fm.includes('model: m1'), fm)
  assert.ok(fm.includes('number: 2') && fm.includes('title: "T"'), 'sibling keys survive')
  assert.equal(doc.body, 'body\n')
})

test('declared anchor: legacy (bare-bodyText) form still enrichable; corruption still refuses', async () => {
  const { sha256 } = await import('../../src/render.ts')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'es-legacy-'))
  const body = '# topic\n\nsome verbatim body\n'
  // legacy chapters declared sha256(bodyText) WITHOUT the writer's appended newline
  const legacy = `---\ntitle: "t"\nsha256: ${sha256(body)}\n---\n${body}\n`
  const f = path.join(dir, '001-t.md')
  fs.writeFileSync(f, legacy)
  const w = updateChapterFrontmatter(f, { title: JSON.stringify('Enriched') })
  assert.equal(w.changed, true, 'legacy anchor accepts the sanctioned write')
  // a body that matches NEITHER form is corruption — refuse
  const tampered = legacy.replace('some verbatim body', 'rewritten verbatim body')
  fs.writeFileSync(f, tampered)
  assert.throws(() => updateChapterFrontmatter(f, { title: JSON.stringify('x') }), /body altered on disk/)
  fs.rmSync(dir, { recursive: true, force: true })
})
