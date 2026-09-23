/**
 * The conversation/injection boundary (src/injections.ts) and its render-time
 * application — the "the knowledge corpus carries no project instruction
 * files" rule (knowledge-repo.md §15 amendment). The durable session log is
 * never touched by any of this (invariant 1): screening happens as bytes are
 * rendered INTO chapters, and each omission leaves a countable marker.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHumanAuthored, omittedMarker, screenConversation, sourceLabel, stripReminderSpans } from '../../src/injections.ts'
import { renderChapter } from '../../src/render.ts'
import type { SessionEventLike } from '../../src/types.ts'

const ev = (seq: number, data: Record<string, unknown>, type = 'user/message'): SessionEventLike => ({
  type, seq, time: 0, data: { id: `e${seq}`, ...data },
})
const CONFIG = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 8000 }

// ------------------------------------------------------------------ the predicate

test('unlabelled and kind:user are human conversation; everything else is injected', () => {
  assert.equal(isHumanAuthored({}), true, 'unlabelled (seeded fixtures) counts')
  assert.equal(isHumanAuthored({ source: { kind: 'user' } }), true)
  assert.equal(isHumanAuthored({ source: { kind: 'agent-instructions' } }), false)
  assert.equal(isHumanAuthored({ source: { kind: 'plugin', plugin: 'dsh-chapters' } }), false)
  assert.equal(isHumanAuthored({ source: { kind: 'tool' } }), false)
  assert.equal(isHumanAuthored({ source: { kind: 'system' } }), false)
})

test('plugin sources are labeled with the plugin name in the marker', () => {
  assert.equal(sourceLabel({ source: { kind: 'plugin', plugin: 'dsh-chapters' } }), 'plugin:dsh-chapters')
  assert.equal(sourceLabel({ source: { kind: 'agent-instructions' } }), 'agent-instructions')
  assert.equal(sourceLabel({}), 'unlabelled')
})

// ------------------------------------------------------------------ span stripping

test('<system-reminder> spans are removed and counted; the rest survives', () => {
  const raw = 'fix the auth bug\n\n<system-reminder>\ninstructions from: AGENTS.md\n# big project doc\n</system-reminder>'
  const r = stripReminderSpans(raw)
  assert.equal(r.text, 'fix the auth bug')
  assert.equal(r.removedChars, raw.length - 'fix the auth bug'.length - 2)
  assert.ok(!r.text.includes('AGENTS.md'))
})

test('a truncated injection with no closing tag strips to end of text (tape-class parity)', () => {
  const raw = 'real question\n<system-reminder>Current runtime context. This snapshot'
  const r = stripReminderSpans(raw)
  assert.equal(r.text, 'real question')
  assert.ok(r.removedChars > 0)
})

test('stripping is idempotent — the marker text cannot re-trigger the rule', () => {
  const once = stripReminderSpans('a\n<system-reminder>x</system-reminder>')
  const twice = stripReminderSpans(once.text)
  assert.equal(twice.text, once.text)
  assert.equal(twice.removedChars, 0)
})

test('ordinary prose that merely MENTIONS instruction files survives verbatim', () => {
  const raw = 'Did you read AGENTS.md before editing docs/knowledge-repo.md? The system reminder thing is confusing.'
  const r = stripReminderSpans(raw)
  assert.equal(r.text, raw)
  assert.equal(r.removedChars, 0)
})

test('multiple spans in one message are all removed', () => {
  const raw = 'a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>c'
  const r = stripReminderSpans(raw)
  assert.equal(r.text, 'abc')
})

// ------------------------------------------------------------------ screen shape

test('screenConversation: non-human event → whole-event omission, no text', () => {
  const s = screenConversation({ source: { kind: 'agent-instructions' } }, 'project instructions here', 'user')
  assert.equal(s.omittedEvent, true)
  assert.equal(s.text, '')
  assert.equal(s.removedChars, 'project instructions here'.length)
})

test('screenConversation: human event → spans removed, text kept', () => {
  const s = screenConversation({ source: { kind: 'user' } }, 'hi\n<system-reminder>ctx</system-reminder>', 'user')
  assert.equal(s.omittedEvent, false)
  assert.equal(s.text, 'hi')
  assert.ok(s.removedChars > 0)
})

// ------------------------------------------------------------------ render integration

test('RENDER: an injected instruction event leaves a marker, never its bytes', () => {
  const events = [
    ev(0, { content: [{ type: 'text', text: 'do the work' }] }),
    ev(1, { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'instructions from: PROJECT-SENTINEL-XYZ\n# the project rules live here' }] }),
    ev(2, { source: { kind: 'user' }, content: [{ type: 'text', text: 'thanks' }] }),
  ]
  const r = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 2 }, CONFIG)
  assert.ok(!r.markdown.includes('PROJECT-SENTINEL-XYZ'), 'injected bytes must not ship')
  assert.ok(/⟦omitted:host-injected agent-instructions, \d+ chars/.test(r.markdown), 'marker present with count')
  assert.ok(r.markdown.includes('do the work') && r.markdown.includes('thanks'), 'conversation survives')
})

test('RENDER: a reminder span inside a human message is removed; the human text and header survive', () => {
  const events = [ev(0, { source: { kind: 'user' }, content: [{ type: 'text', text: 'the real ask\n<system-reminder>instructions from: SENTINEL-SPAN\nrules…</system-reminder>' }] })]
  const r = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)
  assert.ok(!r.markdown.includes('SENTINEL-SPAN'))
  assert.ok(r.markdown.includes('the real ask'))
  assert.ok(r.markdown.includes('**User:**'))
  assert.match(r.markdown, /⟦omitted:host-injected <system-reminder> span\(s\), \d+ chars/)
})

test('RENDER: our own TOC notice (plugin source) is omitted — children re-archiving themselves never bloat the corpus', () => {
  const events = [
    ev(0, { source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: 'CHAPLIST' }] }, content: [{ type: 'text', text: 'CHAPLIST-HUGE-SENTINEL-TEXT' }] }),
    ev(1, { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'child works' }] }, 'assistant/message'),
  ]
  const r = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 1 }, CONFIG)
  assert.ok(!r.markdown.includes('CHAPLIST-HUGE-SENTINEL-TEXT'))
  assert.match(r.markdown, /omitted:host-injected plugin:dsh-chapters/)
})

test('RENDER: a message that is PURE injection renders as marker only — not counted, not an unrendered hole', () => {
  const events = [
    ev(0, { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>all injected, nothing typed</system-reminder>' }] }),
    ev(1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'real' }] }),
  ]
  const r = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 1 }, CONFIG)
  assert.equal(r.stats.messages, 1, 'pure-injection is not a conversation message')
  assert.deepEqual(r.stats.unrenderedSeqs, [], 'but it rendered a marker — not a silent hole')
  assert.match(r.markdown, /omitted:host-injected <system-reminder> span/)
})

test('RENDER: the marker is deterministic — same bytes render to identical sha256', () => {
  const one = [ev(0, { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'abc' }] })]
  const a = renderChapter(one, { title: 'T', summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)
  const b = renderChapter(one, { title: 'T', summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)
  assert.equal(a.markdown, b.markdown)
})

test('omittedMarker has the one pinned shape (assertions + tests anchor on this prefix)', () => {
  const m = omittedMarker('agent-instructions', 12)
  assert.ok(m.startsWith('⟦omitted:host-injected '))
  assert.ok(m.includes('12 chars'))
})
