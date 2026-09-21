import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleNotice } from '../../src/continue-core.ts'

const base = {
  title: 'T', handoffNote: 'N', entries: [], rootSession: 'r', parentSession: 'p', storeRoot: '.dsh-chapters',
}

test('rulesSection ABSENT (or empty) is byte-identical to the pre-P3 notice (tape-safety)', () => {
  const a = assembleNotice({ ...base, projectLine: 'Project: s · K' })
  const b = assembleNotice({ ...base, projectLine: 'Project: s · K', rulesSection: '' })
  const c = assembleNotice({ ...base })
  assert.equal(a, b)
  assert.ok(!a.includes('CORE RULES') && !c.includes('CORE RULES'))
})

test('rules section lands after the project line, before the preamble', () => {
  const t = assembleNotice({ ...base, projectLine: 'Project: s · K', rulesSection: '## CORE RULES\n[hA/001] (security) rule text' })
  assert.ok(t.includes('Project: s · K\n\n## CORE RULES'), t.slice(0, 220))
  assert.ok(t.indexOf('CORE RULES') < t.indexOf('This session continues'))
})
