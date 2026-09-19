import { bootE2eServer, type BootHandle } from './boot.ts'

/** Main suite: production-shaped arrival floor (row default 8000 — big
 * chunks stay inline so the compaction-crossing specs cross), dev threshold
 * 0.75 of the 32K stress window. */
export default async function setup(): Promise<() => Promise<void>> {
  const handle: BootHandle = await bootE2eServer(41731, { thresholdRatio: '0.75' })
  return async () => { await handle.stop() }
}
