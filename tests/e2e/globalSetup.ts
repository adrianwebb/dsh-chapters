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
  // The oversized-turn spec needs pressure compaction to fire MID-TURN at a
  // cost a local box can bear: lower the installed dev preset's threshold from
  // the production 0.9 to 0.55 (35.2K on the 64K model). Other specs never
  // build >20K surfaces, so their behavior is unchanged; the shipped preset
  // (presets/chapters/) keeps 0.9 — this only touches .dshdev-local.
  const presetRow = path.join(ROOT, '.dshdev-local', '.agent-presets', 'chapters', 'agent.cordis.yml')
  if (fs.existsSync(presetRow)) {
    const y = fs.readFileSync(presetRow, 'utf8')
    fs.writeFileSync(presetRow, y.replace(/thresholdRatio: [0-9.]+/, 'thresholdRatio: 0.55'))
  }

  child = spawn('dsh', ['web', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: path.join(ROOT, '.dshdev-local') },
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
