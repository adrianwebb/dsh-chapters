/** S0 normalization pipeline: the object side and the legacy-string side must
 * land on the SAME canonical text (that equality is the whole matcher). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, substituteAll } from './model-proxy.ts'

test('object normalization substitutes volatile shapes', () => {
  const msg = { role: 'user', content: 'On Sep 19 at 14:22 with "id":"abc1234567890abc", "callId":"def1234567890def", "toolCallId":"ghi1234567890ghi", "seq":12, ref 0d4f2a66-1111-2222-3333-444455556666, and A skill is a catalogue </system-reminder>' }
  const n = normalize(msg)
  assert.ok(!n.includes('Sep 19') && n.includes('<DATE>'))
  assert.ok(!n.includes('14:22') && n.includes('<TIME>'))
  assert.ok(n.includes('<UUID>') && n.includes('<CALL>') && n.includes('<ID>'))
  assert.ok(n.includes('<SKILL-CATALOG>'))
})

test('legacy stored strings reach the SAME text via substituteAll (no double stringify)', () => {
  const msg = { role: 'user', content: 'Sep 19 rolled at 09:00' }
  const once = normalize(msg)
  const legacyDoubleNormalized = substituteAll(once) // what loadTape now does to stored strings
  assert.equal(legacyDoubleNormalized, once, 'substitutions are idempotent on their own output')
  assert.ok(once.includes('<DATE>') && once.includes('<TIME>'))
})

test('seq shapes normalize in bare AND escaped forms', () => {
  assert.ok(normalize({ text: 'payload {"seq":42} end' }).includes('"seq":<SEQ>'))
  assert.ok(normalize({ text: 'payload [{\\"seq\\":8,\\"text\\":\\"hi\\"}]' }).includes('<SEQ>'))
})

test('tool-role messages normalize to identity on BOTH sides (harness-generated content is not model signal)', async () => {
  const { normalize: n } = await import('./model-proxy.ts')
  const a = n({ role: 'tool', content: [{ type: 'text', text: 'FILE VERSION A ' + 'x'.repeat(500) }] })
  const b = n({ role: 'tool', content: [{ type: 'text', text: 'COMPLETELY DIFFERENT REPLAY-TIME CONTENT' }] })
  assert.equal(a, b)
  assert.equal(a, '{"role":"tool"}')
  const u = n({ role: 'user', content: 'a tool-looking string {"role":"tool"} inside user text stays intact' })
  assert.ok(u.includes('stays intact'), 'user messages untouched')
})
