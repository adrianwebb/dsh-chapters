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
    { name: 'suite', testIgnore: ['**/artifact-arrival.spec.ts', '**/oversized-turn.spec.ts', '**/enrich.spec.ts', '**/rules.spec.ts', '**/subagent-fanout.spec.ts'] },
    // heavy: oversized compaction scenarios boot at threshold 0.5 (trigger
    // 16K of 32K) so the crossing arrives in the FIRST chunks — capture on
    // the live model stays in minutes, and replay of the tape is identical.
    { name: 'heavy', testMatch: ['**/oversized-turn.spec.ts'] },
    { name: 'arrival', testMatch: ['**/artifact-arrival.spec.ts'] },
    // fanout: the two-subagent research journey gets its OWN boot and tape
    // (2026-09-23, lesson of the suite-context chains): its child sessions
    // make the deepest request arrays on this hardware, and sharing the suite
    // boot made its tape record the shape of whoever ran first. Same 0.75
    // stress pin as the suite; E2E_TAPE=fanout in the scripts chain.
    { name: 'fanout', testMatch: ['**/subagent-fanout.spec.ts'] },
    // enrich: the P2 enrichment ladder end-to-end; boots with
    // enrichmentEnabled TRUE (its tape carries the ladder's model call).
    { name: 'enrich', testMatch: ['**/enrich.spec.ts'] },
    // rules: the P3 lifecycle in the browser over a local-path pool.
    { name: 'rules', testMatch: ['**/rules.spec.ts'] },
  ],
})
