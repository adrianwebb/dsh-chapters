import { bootE2eServer, type Pins } from './boot.ts'

/**
 * One server per CONFIG LOAD (proven lifecycle: project setupFiles die with
 * worker restarts — measured 2026-09-19). The two suites run as two
 * invocations with env pins: E2E_PORT / E2E_THRESHOLD / E2E_FLOOR.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const port = Number(process.env.E2E_PORT ?? '41731')
  const pins: Pins = { thresholdRatio: process.env.E2E_THRESHOLD ?? '0.75' }
  const floor = process.env.E2E_FLOOR
  if (floor !== undefined) pins.toolResultArtifactTokens = floor
  const handle = await bootE2eServer(port, pins)
  return async () => { await handle.stop() }
}
