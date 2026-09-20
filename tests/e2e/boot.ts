import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { startModelProxy, type ProxyHandle } from './model-proxy.ts'

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
/** port-keyed home: two boots running at once (even accidentally) can never
 * wipe or corrupt each other's state — a same-home collision was measured
 * destroying an in-flight capture (2026-09-19). */
export const e2eHome = (port: number): string => path.join(ROOT, 'var', `e2e-home-${port}`)

export interface Pins {
  thresholdRatio: string
  enrichment?: boolean
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

  const E2E_HOME = e2eHome(port)
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
  if (pins.enrichment && !/enrichmentEnabled: true/.test(y)) {
    y = y.replace(/enrichmentEnabled: false/, 'enrichmentEnabled: true')
  }
  // Enrichment stays OFF for the existing projects until tapes carry the
  // enrichment exchanges (an unrecorded auxiliary call is a loud replay miss
  // BY DESIGN — so the dedicated enrich project will opt in deliberately).
  if (!/enrichmentEnabled:/.test(y)) {
    y = y.replace(/( *)thresholdRatio: [0-9.]+/, `$1thresholdRatio: ${pins.thresholdRatio}\n$1enrichmentEnabled: false`)
  }
  if (pins.toolResultArtifactTokens !== undefined && !y.includes('toolResultArtifactTokens:')) {
    y = y.replace(/( *)thresholdRatio: [0-9.]+/, `$1thresholdRatio: ${pins.thresholdRatio}\n$1toolResultArtifactTokens: ${pins.toolResultArtifactTokens}`)
  }
  fs.writeFileSync(row, y)

  // STRESS REGIME pin (user directive 2026-09-19): 32K window / 15K response.
  // E2E_MODEL=record|replay inserts the tape proxy (same directive's second
  // half: the GPU model distills tapes; acceptance replays them in seconds).
  const modelMode = process.env.E2E_MODEL ?? 'live'
  let proxy: ProxyHandle | null = null
  if (modelMode === 'record' || modelMode === 'replay') {
    proxy = await startModelProxy({
      mode: modelMode,
      // per-project tapes: a failed capture's entries must never resurrect as
      // another pin's replay continuation (prefix collisions across pins are
      // otherwise invisible and land the session in someone else's transcript)
      tapeDir: path.join(ROOT, 'var', 'model-tape', process.env.E2E_TAPE ?? 'default'),
      upstream: process.env.E2E_UPSTREAM ?? 'http://localhost:8080',
    })
  }
  const liveSettings = path.join(E2E_HOME, 'settings.yaml')
  if (fs.existsSync(liveSettings)) {
    const s = fs.readFileSync(liveSettings, 'utf8')
    let y = s
      .replace(/contextWindow: \d+/g, 'contextWindow: 32000')
      .replace(/maxTokens: \d+/g, 'maxTokens: 15000')
    if (proxy !== null) y = y.replace(/baseURL: \S+\/v1/, `baseURL: ${proxy.url}`)
    fs.writeFileSync(liveSettings, y)
  }

  const child: ChildProcessWithoutNullStreams = spawn('dsh', ['web', '--port', String(port), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: E2E_HOME, DSH_CHAPTERS_ENGINE_ERRORS: path.join(ROOT, 'var', 'e2e-engine-errors.log') },
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
      if (proxy !== null) await proxy.close().catch(() => undefined)
      if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000)
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
    },
  }
}
