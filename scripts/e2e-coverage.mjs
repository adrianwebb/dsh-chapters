/**
 * scripts/e2e-coverage.mjs — statement/branch/function coverage for the
 * BROWSER layer, remapped onto TypeScript sources.
 *
 * How it works end to end:
 *   1. A replay run with E2E_COVERAGE=1 makes every boot (tests/e2e/boot.ts)
 *      write NODE_V8_COVERAGE profiles under var/e2e-cov/<port> — the boots
 *      execute the BUILT lib/*.js, which carry real source maps (tsconfig
 *      sourceMap: true) back to src/*.ts.
 *   2. This script flattens all port-profiles into one directory and hands
 *      them to c8, which applies the source maps (v8-to-istanbul) and emits
 *      istanbul-grade tables: % Stmts, % Branch, % Funcs, % Lines per src
 *      module. That replaces the earlier line-range projection — a branch
 *      that never fires now counts as a missed BRANCH, not a covered line.
 *   3. every plugin module is imported at boot, so "only loaded files" is an
 *      honest denominator — a module that never loaded would itself be the
 *      finding. (c8 filters include/exclude BEFORE remapping; --include=src/**
 *      against lib/*.js profiles zeroes the report — verified, documented.)
 *
 * Honest limits: TS type-erasure can blur one or two remapped branch
 * positions (a known c8/v8-to-istanbul trait), and union semantics mean
 * "covered by SOME boot", not "covered by every scenario". Both are stated
 * in the docs/verify.md COV row; neither is a reason to go back to guessing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COV_ROOT = path.join(ROOT, 'var', 'e2e-cov')
const MERGED = path.join(COV_ROOT, 'merged')
const C8_BIN = path.join(ROOT, 'node_modules', '.bin', 'c8')

if (!fs.existsSync(COV_ROOT)) {
  console.error('var/e2e-cov/ not found — run the replay with coverage first:\n  npm run coverage:e2e')
  process.exit(1)
}
if (!fs.existsSync(C8_BIN)) {
  console.error('c8 missing (npm i -D c8) — the accurate ledger needs it; the line-range guesser is gone by design')
  process.exit(1)
}

// flatten every boot's profiles into one directory for c8
fs.rmSync(MERGED, { recursive: true, force: true })
fs.mkdirSync(MERGED, { recursive: true })
let files = 0
const SKIP = new Set(['merged', 'report']) // our own output dirs, not boots
for (const dir of fs.readdirSync(COV_ROOT)) {
  const full = path.join(COV_ROOT, dir)
  if (!fs.statSync(full).isDirectory() || SKIP.has(dir)) continue
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.json')) continue
    // profile names embed pid+timestamp, but collisions across boots are
    // possible — disambiguate by port directory
    fs.copyFileSync(path.join(full, f), path.join(MERGED, `${dir}-${f}`))
    files += 1
  }
}
if (files === 0) {
  console.error('No V8 profiles under var/e2e-cov/*/ — did the boots exit cleanly with E2E_COVERAGE=1?')
  process.exit(1)
}

console.log(`e2e coverage — ${files} profiles from ${fs.readdirSync(COV_ROOT).filter((d) => !SKIP.has(d) && fs.statSync(path.join(COV_ROOT, d)).isDirectory()).length} boots, remapped via source maps (c8/istanbul)\n`)
// NOTE on flag choice: c8 applies --include/--exclude BEFORE source-map
// remapping (profiles reference lib/*.js), and --all + --include would then
// filter the very scripts we want — with --include=src/** the whole report
// collapsed to 0%. Every plugin module is loaded at boot anyway, so
// loaded-files-only is honest; c8's default excludes already drop
// node_modules. Belt: explicitly exclude everything that isn't our compiled
// source.
const r = spawnSync(C8_BIN, [
  'report',
  `--temp-directory=${MERGED}`,
  '--exclude=examples/**',
  '--exclude=tests/**',
  '--exclude=scripts/**',
  '--exclude=spikes/**',
  '--exclude=**/*.config.ts',
  '--reporter=text',
  '--reporter=json-summary',
  `--report-dir=${path.join(COV_ROOT, 'report')}`,
], { cwd: ROOT, stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)

try {
  const sum = JSON.parse(fs.readFileSync(path.join(COV_ROOT, 'report', 'coverage-summary.json'), 'utf8'))
  const t = sum.total
  console.log(`\nTOTAL: statements ${t.statements.pct}% · branches ${t.branches.pct}% · functions ${t.functions.pct}% · lines ${t.lines.pct}%`)
  console.log('machine-readable rollup: var/e2e-cov/report/coverage-summary.json')
} catch { /* text table already printed */ }
