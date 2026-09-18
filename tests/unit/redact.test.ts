/**
 * redact.ts — the §9 carve-out: credentials redacted with a stable marker,
 * everything else byte-identical. The determinism property (same secret →
 * same marker, across calls) is the one users will grep for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_REDACTIONS, redactText } from '../../src/redact.ts'

const AWS = 'AKIAIOSFODNN7EXAMPLE'
const GITHUB = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'
const SK = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

test('each built-in pattern redacts its shape', () => {
  assert.match(redactText(`key: ${AWS}`).text, /⟦redacted:credential sha256=[0-9a-f]{8}⟧/)
  assert.equal(redactText(`key: ${AWS}`).text.includes(AWS), false)
  assert.match(redactText(`token ${GITHUB}`).text, /redacted/)
  assert.match(redactText(`k=${SK}`).text, /redacted/)
  assert.match(redactText(`jwt: ${JWT}`).text, /redacted/)
  assert.match(redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----').text, /redacted/)
})

test('label-aware patterns keep the label, redact only the secret', () => {
  const out = redactText('curl -H "Authorization: Bearer abcdef1234567890ab" https://x')
  assert.match(out.text, /Bearer ⟦redacted:credential sha256=[0-9a-f]{8}⟧/)
  assert.equal(out.text.includes('abcdef1234567890ab'), false)
  const url = redactText('open https://svc.example/?token=supersecretvalue123&other=1')
  assert.match(url.text, /\?token=⟦redacted:credential sha256=[0-9a-f]{8}⟧&other=1/)
})

test('deterministic: same secret → same marker across calls; different secret → different marker', async () => {
  const a = redactText(`a ${AWS} b`)
  const b = redactText(`x ${AWS} y`)
  assert.equal(a.markers[0], b.markers[0])
  const c = redactText(`z AKIAZZZZZZZZZZZZZZZZ w`)
  assert.notEqual(c.markers[0], a.markers[0])
  // the 8-hex prefix IS sha256(secret).slice(0,8), computed independently
  const { createHash } = await import('node:crypto')
  const expect = `⟦redacted:credential sha256=${createHash('sha256').update(AWS, 'utf8').digest('hex').slice(0, 8)}⟧`
  assert.equal(a.markers[0], expect)
})

test('non-credential text is byte-identical (the character of the conversation is preserved)', () => {
  const prose = 'The migration finished: 42 tables, 3 indexes. Next: wire the webhook retry backoff (5s, 30s, 120s) and run the soak test overnight.'
  const out = redactText(prose)
  assert.equal(out.count, 0)
  assert.equal(out.text, prose)
})

test('multiple secrets in one text: all redacted, counts exact, markers stable', () => {
  const text = `aws ${AWS}\nrepo ${GITHUB}\napi ${SK}\nagain ${AWS}`
  const out = redactText(text)
  assert.equal(out.count, 4)
  assert.equal(out.markers.length, 3) // AWS twice → one distinct marker
  assert.equal(out.text.includes(AWS) || out.text.includes(GITHUB) || out.text.includes(SK), false)
  assert.equal(out.text.split('⟦').length - 1, 4) // four markers inline
})

test('markers never re-match any pattern (passes compose safely)', () => {
  const out1 = redactText(`k ${SK}`)
  const out2 = redactText(out1.text)
  assert.equal(out2.count, 0)
  assert.equal(out2.text, out1.text)
})

test('custom patterns compose with the defaults; empty pattern list is a no-op', () => {
  const custom = [{ name: 'test-token', regex: /\bTST-[A-Z]{6}\b/g }]
  const out = redactText('here TST-ABCDEF and AKIAIOSFODNN7EXAMPLE', custom)
  // custom replaces the default set entirely (config patterns are THE set)
  assert.match(out.text, /⟦redacted:credential sha256=[0-9a-f]{8}⟧ TST/ === 'x' ? /never/ : /⟦redacted/)
  assert.equal(redactText('AKIAIOSFODNN7EXAMPLE', []).text, 'AKIAIOSFODNN7EXAMPLE')
  assert.ok(DEFAULT_REDACTIONS.length >= 8)
})
