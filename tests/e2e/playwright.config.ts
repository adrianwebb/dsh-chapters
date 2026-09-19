import { defineConfig } from '@playwright/test'

/**
 * e2e config for the dsh-chapters dev profile. Browsers live under var/
 * (the sandbox cannot write ~/.cache); the boot script exports
 * PLAYWRIGHT_BROWSERS_PATH. globalSetup boots a REAL dsh web server on a
 * fixed port with DSH_HOME pointed at the throwaway var/e2e-home and captures its
 * token URL — the suite tests the actual artifact users get.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '../../var/e2e-results.json' }]],
  globalSetup: './globalSetup.ts',
  use: {
    baseURL: process.env.DSH_E2E_BASE ?? 'http://127.0.0.1:41731',
    trace: 'retain-on-failure',
  },
})
