/**
 * CONTEXT-SIZE HYGIENE — the 2026-09-25 'are we hardcoding the context?' audit, pinned.
 *
 * The pressure-compaction gate reads the window LIVE from the adapter model config
 * (`ctx.llm.resolveModelInfo(provider, model).context.contextWindow`; the base throws
 * TargetPressureConfigError when it's absent — behavior pinned in
 * tests/unit/engine-lifecycle.test.ts, which also proves the gate consults that source).
 * A user reading 'compaction fired while provider usage said 29,656 of a 64,000 window'
 * reasonably suspected a hardcoded 32K. It was not one: the engine decides on the HOST
 * token-meter's estimate (provider baseline + 4-chars-per-token for content added since
 * the last request), which for that session's tool-heavy surface read ~66,700 >= 0.9 x
 * 64,000. The unit difference is documented in verify.md § CACHE.
 *
 * This test keeps the suspicion unfounded FOREVER: no context-window literal may appear
 * in the shipped surface, and no preset row may pin a window — the number must always
 * come from configuration. (Whitelisted by design: `maxBytes: 65536` is the read tool's
 * byte cap, a file-size policy, not a context claim.)
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

const CONTEXT_LITERALS = /\b(32_?000|32_?768|64_?000|128_?000|131_?072|1_?000_?000)\b/
const WINDOW_KEYS = /contextWindow|maxContextTokens|context_window/i

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|yml|yaml|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = [...walk(path.join(ROOT, 'src'), []), ...walk(path.join(ROOT, 'presets'), [])]

test(`no context-window literal in ${files.length} shipped files`, () => {
  const offenders: string[] = []
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//') || line.trim().startsWith('#')) return
      // A window-sized NUMBER is suspect only where it claims a CONTEXT budget.
      // Char/byte policies (thresholdChars, maxBytes) and per-chapter token targets
      // are archive tuning, user-overridable in the preset, not a hardcoded model
      // context — they may carry the same digits honestly.
      if (!CONTEXT_LITERALS.test(line)) return
      if (/maxBytes|thresholdChars|Chars|Bytes|chapterToken|maxTokens|Budget|budget/.test(line)) return
      offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 90)}`)
    })
  }
  assert.deepEqual(offenders, [], `context-size literals must not ship — the window comes from adapter config:\n${offenders.join('\n')}`)
})

test('preset rows never pin a window key', () => {
  for (const f of walk(path.join(ROOT, 'presets'), [])) {
    const body = fs.readFileSync(f, 'utf8')
    const hit = body.split('\n').find((l) => WINDOW_KEYS.test(l) && !l.trim().startsWith('#'))
    assert.equal(hit, undefined, `${path.relative(ROOT, f)} pins a context window: ${hit?.trim()}`)
  }
})

test('the engine Config declares no window field (adapter-config-only invariant)', () => {
  const body = fs.readFileSync(path.join(ROOT, 'src', 'engine.ts'), 'utf8')
  assert.ok(!WINDOW_KEYS.test(body.split('\n').filter((l) => !/^\s*(\/\/|\*|#)/.test(l)).join('\n')),
    'src/engine.ts must not define or default a context-window config key')
})
