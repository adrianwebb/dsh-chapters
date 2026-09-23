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

test('AGENTS-blind: injected instruction blocks mask across versions; conversation text survives', async () => {
  const { normalize } = await import('./model-proxy.ts')
  const v1 = { role: 'user', content: 'Current runtime context.\n\n<system-reminder>Updated instructions from: AGENTS.md\n\n# dsh-chapters — agent core\n\nWorking spec with 216 unit/integration claims.\n</system-reminder>\n\nWhat does sync.ts do?' }
  const v2 = { role: 'user', content: 'Current runtime context.\n\n<system-reminder>Updated instructions from: AGENTS.md\n\n# dsh-chapters — agent core\n\nCOMPLETELY REWRITTEN FILE with 231 claims and a rules section.\n</system-reminder>\n\nWhat does sync.ts do?' }
  assert.equal(normalize(v1), normalize(v2), 'different AGENTS bytes must converge')
  const quoted = { role: 'assistant', content: 'The AGENTS.md file says to verify claims.' }
  const q = normalize(quoted)
  assert.ok(q.includes('AGENTS.md file says'), 'a conversation MENTION of the file is not masked')
})

test('AGENTS-blind fires on the CAPITAL-I header form the host actually injects', async () => {
  const { normalize } = await import('./model-proxy.ts')
  const a = normalize({ role: 'user', content: '<system-reminder>\nInstructions from: AGENTS.md\n# old file text AAA\n</system-reminder>\nReal question?' })
  const b = normalize({ role: 'user', content: '<system-reminder>\nInstructions from: AGENTS.md\n# COMPLETELY DIFFERENT BBB\n</system-reminder>\nReal question?' })
  assert.equal(a, b, 'the exact real-world form must converge')
})

test('skill-catalog blanket catches the NEW harness wording (structural anchor, not a sentence)', async () => {
  const { normalize } = await import('./model-proxy.ts')
  const oldForm = normalize({ role: 'user', content: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n…old body…\n</system-reminder>\nReal question?' })
  const newForm = normalize({ role: 'user', content: '<system-reminder>\nThe available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:\n<available_skills>\n- `hf-cli`: Hugging Face Hub CLI…\n</available_skills>\n</system-reminder>\nReal question?' })
  assert.ok(oldForm.includes('<SKILL-CATALOG>') && !oldForm.includes('A skill is'), 'legacy form collapses')
  assert.ok(newForm.includes('<SKILL-CATALOG>') && !newForm.includes('hf-cli'), 'new form collapses via <available_skills> anchor')
})

test('RUNTIME-BLIND: harness environment snapshots mask identically across runs', async () => {
  const { normalize } = await import('./model-proxy.ts')
  const a = normalize({ role: 'user', content: '<system-reminder>Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write.\nWorking directory: /home/adrian/Projects/dsh-chapters</system-reminder>Actual user question.' })
  const b = normalize({ role: 'user', content: '<system-reminder>Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: read-only.\nSomething entirely different here</system-reminder>Actual user question.' })
  assert.equal(a, b, 'differing environment blocks must converge')
  assert.ok(a.includes('Actual user question'), 'the conversation itself survives')
})

test('presence-volatile: pure-injection messages drop from matching; real text never drops', async () => {
  const { normalizeSingle } = await import('./model-proxy.ts')
  const catalogMsg = { role: 'user', content: '<system-reminder>\nThe available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:\n\n<available_skills>\n- `hf-cli`: whatever\n</available_skills>\nUse only names in this replacement catalog.\n</system-reminder>' }
  assert.equal(normalizeSingle(catalogMsg), '', 'pure catalog injection drops')
  const agentsMsg = { role: 'user', content: '<system-reminder>Updated instructions from: AGENTS.md\n# whole rewritten file\n</system-reminder>' }
  assert.equal(normalizeSingle(agentsMsg), '', 'pure AGENTS re-inject drops')
  const real = { role: 'user', content: 'Please run the tests.' }
  assert.ok(normalizeSingle(real).length > 10, 'real message survives')
  const mixed = { role: 'user', content: '<system-reminder>Current runtime context. blah blah</system-reminder>Now answer my question.' }
  assert.ok(normalizeSingle(mixed).includes('Now answer my question'), 'injection+text keeps the text')
})

test('HOSTPORT-BLIND: the run port in the GUI URL and e2e-home path never breaks matching', async () => {
  // measured root cause 2026-09-22: a shifted E2E_PORT mismatched the system
  // head at char ~5.9K ('http://127.0.0.1:41731' vs ':41801') and collapsed
  // the strict-replay era until this rule landed. Legacy stored prefixes
  // re-substitute at load — the fix repairs old tapes without re-recording.
  const { normalizeSingle } = await import('./model-proxy.ts')
  const head = (port) => ({ role: 'system', content: `You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:${port}. Workspace /home/u/p/var/e2e-home-${port} is writable.` })
  assert.equal(normalizeSingle(head(41731)), normalizeSingle(head(41801)), 'port shift collapses')
  const realQuestion = { role: 'user', content: 'Which port does the service listen on? Answer: port 41731 is in the config.' }
  assert.ok(normalizeSingle(realQuestion).length > 20, 'human text survives (masking matching, not history)')
})

test('derived counts collapse: est-token figures and host-injected char counts', async () => {
  const { normalizeSingle } = await import('./model-proxy.ts')
  const a = normalizeSingle({ role: 'user', content: '# Chapter 1 (1104 est tokens) cites x — ⟦omitted:host-injected agent-instructions, 29518 chars — project state⟧' })
  const b = normalizeSingle({ role: 'user', content: '# Chapter 1 (1126 est tokens) cites x — ⟦omitted:host-injected agent-instructions, 29746 chars — project state⟧' })
  assert.equal(a, b, 'two runs of the same chapter shape match despite drifting derived counts')
  assert.ok(a.includes('Chapter 1'), 'the identifying text survives the collapse')
})
