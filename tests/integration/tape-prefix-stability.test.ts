/**
 * TAPE PREFIX-STABILITY LEDGER — the deterministic half of cache regression.
 *
 * The live-side physical property (hit rates RISE over a session) is owned by the opt-in e2e
 * probe (tests/e2e/cache-trajectory.spec.ts, `npm run test:e2e:cache` — recorded usage bytes
 * cannot measure it). What CAN be measured deterministically, from the committed model tapes,
 * is the product precondition any cache needs: **a message once sent is never mutated.** LLM
 * prefix caching is exactly "the bytes you already paid for stay valid"; a harness change that
 * rewrites an already-sent message mid-session (a re-rendered notice, a swapped-out injection,
 * a reordered block) silently poisons every downstream hit — and 2026-09-25's hosted
 * investigation proved those mutations exist as a CLASS (catalog injections are machine
 * state). This test walks every recorded session chain and fails, with the offending message
 * index, on any recorded request that continues an existing chain while NOT extending its
 * predecessor byte-for-byte.
 *
 * Chain model: group stored entries by their system-prompt signature (one group per agent
 * surface). An entry whose messages array has no shorter entry as a leading slice is a chain
 * HEAD (a fresh session's first request — legal). An entry WITH a successor but no ancestor is
 * a chain that MUTATED mid-flight — legal exactly at the two documented replacement points:
 * pressure compaction ('checkpoint condensing') and a continuation notice ('# Continuation').
 * Anywhere else, the byte-stability of sent history is invariant.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { substituteAll } from '../e2e/model-proxy.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const TAPE_DIR = path.join(ROOT, 'tests', 'fixtures', 'model-tape')

/** Normalize a stored prefix entry the way the matcher does: full substitution pipeline,
 * then drop the elements that mask to nothing (pure injections). */
function normMessages(prefix: unknown[]): string[] {
  return prefix.map((p) => substituteAll(typeof p === 'string' ? p : JSON.stringify(p) ?? '')).filter((x) => x !== '')
}

interface Entry { file: string; msgs: string[] }

function loadProject(dir: string): Entry[] {
  const out: Entry[] = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { prefix?: unknown[] }
    if (!Array.isArray(e.prefix) || e.prefix.length === 0) continue
    out.push({ file: f, msgs: normMessages(e.prefix) })
  }
  return out
}

const REPLACEMENT_MARKERS = ['checkpoint condensing', '# Continuation:']

test('tapes exist to audit (silent-empty would fake a pass)', () => {
  assert.ok(fs.existsSync(TAPE_DIR), `${TAPE_DIR} missing entirely`)
  const projects = fs.readdirSync(TAPE_DIR).filter((d) => fs.statSync(path.join(TAPE_DIR, d)).isDirectory())
  assert.ok(projects.length >= 5, `expected the six tape projects, saw: ${projects.join(',')}`)
})

for (const project of fs.readdirSync(TAPE_DIR).filter((d) => { try { return fs.statSync(path.join(TAPE_DIR, d)).isDirectory() } catch { return false } })) {
  test(`[${project}] every mid-chain request extends its predecessor byte-for-byte`, () => {
    const entries = loadProject(path.join(TAPE_DIR, project))
    const bySystem = new Map<string, Entry[]>()
    for (const e of entries) {
      const key = e.msgs[0] ?? ''
      const list = bySystem.get(key) ?? []
      list.push(e)
      bySystem.set(key, list)
    }
    for (const [sysKey, group] of bySystem) {
      const minLen = Math.min(...group.map((x) => x.msgs.length))
      for (const e of group) {
        if (e.msgs.length < 2) continue
        const ancestors = group.filter((f) => f !== e && f.msgs.length < e.msgs.length
          && e.msgs.slice(0, f.msgs.length).every((m, i) => m === f.msgs[i]))
        if (ancestors.length > 0) continue // genuinely extends a predecessor
        const hasSuccessor = group.some((f) => f !== e && f.msgs.length > e.msgs.length
          && f.msgs.slice(0, e.msgs.length).every((m, i) => m === e.msgs[i]))
        if (!hasSuccessor) continue // lone requests (titles, annotations): nothing continues them
        // no ancestor BUT someone continues this entry. Legal heads are the shortest arrays in
        // their group (a chain never starts long); a LONG orphan is history that was rewritten
        // under an existing chain — the cache poison this ledger exists to catch.
        const nearHead = e.msgs.length <= minLen + 1
        const replaced = e.msgs.some((m) => REPLACEMENT_MARKERS.some((k) => m.includes(k)))
        assert.ok(nearHead || replaced,
          `${project}/${e.file}: ${e.msgs.length}-message entry has successors but no byte-identical predecessor `
          + `(group minimum ${minLen}; system prompt ${JSON.stringify(sysKey.slice(0, 60))}) — something REWROTE `
          + 'an already-sent message mid-chain, invalidating every downstream cache line. If this is a new '
          + 'documented replacement point, add its marker above with a measured justification.')
      }
    }
  })
}
