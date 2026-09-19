import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Shared e2e boot harness. One server per playwright PROJECT (the main suite
 * and the arrival-artifact suite pin different engine rows — the arrival floor
 * must not change the compaction-crossing scenarios' regime), against one
 * throwaway home rebuilt every boot. The home is copied from .dshdev-local
 * minus all mutable state (sessions, the chapters domain, stored tokens) —
 * the ONLY file kept from storages/ is workspace.json, because workspace
 * ATTACHMENT is setup state: a pristine home shows 'No sessions yet' and
 * never mints a draft session (measured). The plugin is link-installed, so
 * every boot runs the CURRENT build in lib/.
 */
export const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const E2E_HOME = path.join(ROOT, 'var', 'e2e-home')

export interface Pins {
  thresholdRatio: string
  toolResultArtifactTokens?: string
}

export interface BootHandle {
  url: string
  port: number
  stop: () => Promise<void>
}

export async function bootE2eServer(port: number, pins: Pins): Promise<BootHandle> {
  // probe bundle must never shadow the product (idempotent; run on the SOURCE
  // home before the copy so the copy is clean too)
  const rm = spawnSync('bash', [path.join(ROOT, 'scripts/dsh-scratch.sh'), '--home', path.join(ROOT, '.dshdev-local'), 'plugin', '--profile', 'web', 'remove', 'dsh-chapters-probe'], { cwd: ROOT, env: process.env, timeout: 90_000 })
  if (rm.status !== 0) console.warn('e2e: probe removal failed (continuing):', rm.stderr?.toString().slice(0, 200))

  fs.rmSync(E2E_HOME, { recursive: true, force: true })
  fs.cpSync(path.join(ROOT, '.dshdev-local'), E2E_HOME, { recursive: true, filter: (src) => {
    const rel = path.relative(path.join(ROOT, '.dshdev-local'), src)
    return rel === ''
      || rel === 'storages' || rel === 'storages/workspace.json'
      || (!rel.startsWith('sessions') && !rel.startsWith('storages' + path.sep) && !rel.startsWith('dsh-chapters') && !rel.startsWith('.dsh-chapters'))
  } })

  // refresh the INSTALLED preset from the link source (write-once install
  // would otherwise freeze a stale persona), THEN pin the row config
  const installedPreset = path.join(E2E_HOME, '.agent-presets', 'chapters')
  fs.rmSync(installedPreset, { recursive: true, force: true })
  fs.cpSync(path.join(ROOT, 'presets', 'chapters'), installedPreset, { recursive: true })
  const row = path.join(installedPreset, 'agent.cordis.yml')
  let y = fs.readFileSync(row, 'utf8')
  y = y.replace(/thresholdRatio: [0-9.]+/, `thresholdRatio: ${pins.thresholdRatio}`)
  if (pins.toolResultArtifactTokens !== undefined && !y.includes('toolResultArtifactTokens:')) {
    y = y.replace(/( *)thresholdRatio: [0-9.]+/, `$1thresholdRatio: ${pins.thresholdRatio}\n$1toolResultArtifactTokens: ${pins.toolResultArtifactTokens}`)
  }
  fs.writeFileSync(row, y)

  // STRESS REGIME pin (user directive 2026-09-19): 32K window / 15K response
  const liveSettings = path.join(E2E_HOME, 'settings.yaml')
  if (fs.existsSync(liveSettings)) {
    const s = fs.readFileSync(liveSettings, 'utf8')
    fs.writeFileSync(liveSettings, s
      .replace(/contextWindow: \d+/g, 'contextWindow: 32000')
      .replace(/maxTokens: \d+/g, 'maxTokens: 15000'))
  }

  const child: ChildProcessWithoutNullStreams = spawn('dsh', ['web', '--port', String(port), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: E2E_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const deadline = Date.now() + 60_000
  while (!/http:\/\/127\.0\.0\.1:[0-9]+\/\?token=\S+/.test(log) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
  }
  const m = /http:\/\/127\.0\.0\.1:[0-9]+\/\?token=\S+/.exec(log)
  if (m === null) {
    child.kill('SIGKILL')
    throw new Error(`e2e boot failed within 60s (port ${port})\n${log.slice(-1500)}`)
  }
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), JSON.stringify({ url: m[0], port }))
  return {
    url: m[0],
    port,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000)
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
    },
  }
}
