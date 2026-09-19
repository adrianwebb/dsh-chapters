import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Boot the dev-profile web server once for the suite: fixed port, DSH_HOME
 * isolated to .dshdev-local, token URL captured from stdout into
 * var/e2e-boot.json for specs to consume. Fails loudly if the server does not
 * answer within 60s (and includes its log tail — no silent mysteries).
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PORT = 41731
const OUT = path.join(ROOT, 'var', 'e2e-boot.json')
const LOG = path.join(ROOT, 'var', 'e2e-server.log')

let child: ChildProcess | null = null

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  // The probe bundle (scripted one-shots) process-exits the server mid-test;
  // the e2e home must carry plugin-only. Removal is idempotent.
  const rm = spawnSync('bash', [path.join(ROOT, 'scripts/dsh-scratch.sh'), '--home', path.join(ROOT, '.dshdev-local'), 'plugin', '--profile', 'web', 'remove', 'dsh-chapters-probe'], { cwd: ROOT, env: process.env, timeout: 90_000 })
  if (rm.status !== 0) console.warn('e2e: probe removal failed (continuing):', rm.stderr?.toString().slice(0, 200))
  // Isolated per-boot home (Phase 0 of the artifacting plan): .dshdev-local is
  // SHARED with the human/agent sessions that develop this plugin — the
  // 'New session' draft id lives in home state, so specs and a live agent on
  // the same home were typing into and asserting against ONE session
  // (measured: run 13 read an agent transcript, not its own turn). Copy the
  // small durable config (settings, profiles, preset, credentials) into a
  // throwaway home; sessions/, storages/ and dsh-chapters/ (tokens) start
  // empty every boot — old ledgers cannot lie because there are none.
  const SRC_HOME = path.join(ROOT, '.dshdev-local')
  const E2E_HOME = path.join(ROOT, 'var', 'e2e-home')
  fs.rmSync(E2E_HOME, { recursive: true, force: true })
  fs.cpSync(SRC_HOME, E2E_HOME, { recursive: true, filter: (src) => {
    const rel = path.relative(SRC_HOME, src)
    // keep storages/workspace.json (workspace ATTACHMENT = setup state;
      // fresh homes show 'No sessions yet' and never mint a draft session —
      // measured); exclude the chapters domain (the ledger that must stay
      // empty) and everything under sessions/.
      return rel === ''
        || rel === 'storages' || rel === 'storages/workspace.json'
        || (!rel.startsWith('sessions') && !rel.startsWith('storages' + path.sep) && !rel.startsWith('dsh-chapters') && !rel.startsWith('.dsh-chapters'))
  } })

  // STRESS REGIME (user directive 2026-09-19): the dev model runs 32K window
  // / 15K response — if chapters is graceful HERE it is graceful anywhere.
  // The live settings are re-pinned every boot so hand edits can't silently
  // relax the tests; the installed preset's threshold is pinned to 0.75
  // (trigger 24K of 32K): quiet specs (≤20K surfaces) never compact, while
  // the oversized + fan-out specs cross repeatedly by construction. The
  // shipped preset (presets/chapters/) keeps production 0.9 — all of this
  // only touches the throwaway e2e home.
  const liveSettings = path.join(E2E_HOME, 'settings.yaml')
  if (fs.existsSync(liveSettings)) {
    const y = fs.readFileSync(liveSettings, 'utf8')
    fs.writeFileSync(liveSettings, y
      .replace(/contextWindow: \d+/g, 'contextWindow: 32000')
      .replace(/maxTokens: \d+/g, 'maxTokens: 15000'))
  }
  const presetRow = path.join(E2E_HOME, '.agent-presets', 'chapters', 'agent.cordis.yml')
  if (fs.existsSync(presetRow)) {
    const y = fs.readFileSync(presetRow, 'utf8')
    fs.writeFileSync(presetRow, y.replace(/thresholdRatio: [0-9.]+/, 'thresholdRatio: 0.75'))
  }

  child = spawn('dsh', ['web', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: E2E_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logStream = fs.createWriteStream(LOG)
  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)
  child.on('exit', (code, sig) => {
    fs.appendFileSync(LOG, `\n[e2e-setup] server child exited code=${code} signal=${sig ?? 'none'} at ${new Date().toISOString()}\n`)
  })

  const deadline = Date.now() + 60_000
  let url: string | null = null
  while (Date.now() < deadline && url === null) {
    await new Promise((r) => setTimeout(r, 700))
    const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
    url = /http:\/\/127\.0\.0\.1:[0-9]+\/\?token=\S+/.exec(text)?.[0] ?? null
    if (child.exitCode !== null) break
  }
  if (url === null) {
    const tail = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').slice(-1200) : '(no log)'
    throw new Error(`e2e boot failed within 60s\n${tail}`)
  }
  fs.writeFileSync(OUT, JSON.stringify({ url: url.trim(), base: `http://127.0.0.1:${PORT}` }))
  process.on('exit', () => { child?.kill('SIGTERM') })
}

export function globalTeardown(): void {
  child?.kill('SIGTERM')
}
