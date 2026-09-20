/**
 * Two projects, two boots (see boot.ts): the main suite (identity, forks,
 * knowledge loop, oversized-turn, fan-out) and the arrival-artifact suite,
 * which pins a low arrival floor on the engine row. Each project owns its
 * server; var/e2e-boot.json carries the current URL to openApp().
 * PLAYWRIGHT_BROWSERS_PATH must point at var/ms-playwright (workspace-cached
 * browsers); run via `npx playwright test -c tests/e2e/playwright.config.ts`.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'var/e2e-results.json' }]],
  use: { headless: true, viewport: { width: 1360, height: 900 } },
  globalSetup: './globalSetup.ts',
  projects: [
    { name: 'suite', testIgnore: ['**/artifact-arrival.spec.ts', '**/oversized-turn.spec.ts'] },
    // heavy: oversized compaction scenarios boot at threshold 0.5 (trigger
    // 16K of 32K) so the crossing arrives in the FIRST chunks — capture on
    // the live model stays in minutes, and replay of the tape is identical.
    { name: 'heavy', testMatch: ['**/oversized-turn.spec.ts'] },
    { name: 'arrival', testMatch: ['**/artifact-arrival.spec.ts'] },
  ],
})
