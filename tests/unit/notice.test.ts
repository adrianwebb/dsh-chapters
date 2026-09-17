/**
 * Format-watch: the vocabulary pin (Phase 0b check 5).
 *
 * `dsh-session-fork` paid for a retired message source with 66 stored logs
 * that then refused to load. Our continuation seed is one synthetic
 * `user/message`, so the accepted vocabulary must be pinned BEFORE any
 * archive traffic exists — this test is that pin. It is pure: no harness, no
 * boot, no tokens (layer L0/L1, docs/development.md).
 *
 * Part 1 pins behavior recorded from the real kernel (spikes/probe/FINDINGS.md
 * § The seed contract — every rejection message is reproduced verbatim in the
 * probe rounds). Part 2 drift-checks the pinned lists against the installed
 * host's published type declarations when they are readable, and says so
 * rather than silently skipping.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import {
  ACCEPTED_CONTEXT_FORMS, ACCEPTED_SOURCE_KINDS, NOTICE_PLUGIN, NOTICE_SECTION,
  assertKernelAcceptedUserMessage, buildTocNotice,
} from '../../src/notice.ts'

const TOC = '## Conversation TOC\n\n1. [Setup](.dsh-chapters/root/chapters/001-setup.md) — Project setup.\n2. [Auth](.dsh-chapters/root/chapters/002-auth.md) — Auth debugging.'

const build = () => buildTocNotice(TOC, { newId: () => 'aa1bb2cc-dd33-44ee-55ff-001122334455', time: 1700000000000 })

// ------------------------------------------------------------------ the accepted shape

test('the notice is one user/message at seq 0, appended, kernel-shaped', () => {
  const event = build()
  assert.equal(event.type, 'user/message')
  assert.equal(event.seq, 0)
  assert.equal(event.surfaceOp, 'append')
  const data = event.data as Record<string, any>
  assert.equal(data.role, 'user')
  assert.equal(data.id, 'aa1bb2cc-dd33-44ee-55ff-001122334455')
  // source is an OBJECT. The Phase 0 rejections that taught this:
  //   { source: 'user' }  ->  "message has invalid source"
  assert.equal(typeof data.source, 'object')
  assert.equal(data.source.kind, 'plugin')
  assert.equal(data.source.plugin, NOTICE_PLUGIN)
  assert.equal(data.source.form, 'snapshot')
  assert.deepEqual(data.source.sections, [{ name: NOTICE_SECTION, text: TOC }])
})

test('content mirrors the section text byte-identically', () => {
  const data = build().data as Record<string, any>
  assert.equal(data.content.length, 1)
  assert.equal(data.content[0].type, 'text')
  assert.equal(data.content[0].text, data.source.sections[0].text)
  assert.equal(data.content[0].text, TOC) // no invisible edits en route
})

// ------------------------------------------------------------------ the measured rejections, reproduced

test('empty text is refused at authorship, not at seed time', () => {
  assert.throws(() => buildTocNotice('   ', { newId: () => 'x' }), /must not be empty/)
})

test('a missing id reproduces the kernels rejection ("lacks an identified message")', () => {
  assert.throws(
    () => assertKernelAcceptedUserMessage({
      type: 'user/message', seq: 0,
      data: { content: [{ type: 'text', text: TOC }] },
    }),
    /lacks an identified message/,
  )
})

test('a missing role reproduces the kernels rejection (role "user")', () => {
  assert.throws(
    () => assertKernelAcceptedUserMessage({
      type: 'user/message', seq: 0,
      data: { id: 'm', content: [], source: { kind: 'plugin', plugin: NOTICE_PLUGIN } },
    }),
    /must have role "user"/,
  )
})

test('a STRING source reproduces the most expensive possible mistake', () => {
  assert.throws(
    () => assertKernelAcceptedUserMessage({
      type: 'user/message', seq: 0,
      data: { id: 'm', role: 'user', source: 'plugin', content: [{ type: 'text', text: 'x' }] },
    }),
    /invalid source/,
  )
})

test('a plugin source without a producer name is refused', () => {
  assert.throws(
    () => assertKernelAcceptedUserMessage({
      type: 'user/message', seq: 0,
      data: { id: 'm', role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'x' }] },
    }),
    /must name its producer/,
  )
})

test('kinds outside the pinned vocabulary are refused', () => {
  assert.throws(
    () => assertKernelAcceptedUserMessage({
      type: 'user/message', seq: 0,
      data: { id: 'm', role: 'user', source: { kind: 'chapters-internal' }, content: [{ type: 'text', text: 'x' }] },
    }),
    /outside the pinned vocabulary/,
  )
})

test('context forms outside the published ContextForm union are refused', () => {
  assert.throws(
    () => assertKernelAcceptedUserMessage({
      type: 'user/message', seq: 0,
      data: { id: 'm', role: 'user', source: { kind: 'plugin', plugin: NOTICE_PLUGIN, form: 'archive' }, content: [{ type: 'text', text: 'x' }] },
    }),
    /outside the published ContextForm union/,
  )
})

// ------------------------------------------------------------------ drift guard against the installed host

const MESSAGE_DTS = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts'

test('pinned vocabulary still matches the installed host types (drift => re-anchor, never relax)', (t) => {
  if (!existsSync(MESSAGE_DTS)) {
    t.skip(`installed host types not readable at ${MESSAGE_DTS}; the pin above still stands`)
    return
  }
  const src = readFileSync(MESSAGE_DTS, 'utf8')
  // MessageSourceMap must still carry all four base kinds...
  for (const kind of ACCEPTED_SOURCE_KINDS) {
    assert.match(src, new RegExp(`kind: '${kind}'`), `host MessageSourceMap no longer mentions kind '${kind}'`)
  }
  // ...and ContextForm must still carry every pinned form. A REMOVED form is
  // the 66-log class of event and must fail here (the map only ever ADDS).
  for (const form of ACCEPTED_CONTEXT_FORMS) {
    assert.ok(src.includes(`'${form}'`), `ContextForm no longer includes '${form}'`)
  }
  // The seed validator's core rules we transcribe (assertMessageEventShape):
  // kind must be a non-empty string; system/message additionally requires plugin sources.
  assert.match(src, /Merge-extensible sum type/)
})
