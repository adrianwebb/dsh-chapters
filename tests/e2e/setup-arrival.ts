import { bootE2eServer, type BootHandle } from './boot.ts'

/** Arrival-artifact suite: floor 500 tokens so ordinary reads get stubbed at
 * arrival, and the production threshold (0.9) so a stubbed reading task
 * COMPLETES without ever needing compaction — isolating the arrival path. */
export default async function setup(): Promise<() => Promise<void>> {
  const handle: BootHandle = await bootE2eServer(41732, { thresholdRatio: '0.9', toolResultArtifactTokens: '500' })
  return async () => { await handle.stop() }
}
