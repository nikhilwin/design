import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PERF_PORT ?? 5391)

/**
 * Editor performance profile and budgets (`npm run e2e:perf`): the production build of the harness
 * (`vite.perf.config.ts`) served by `vite preview`, one worker, so nothing else competes for the CPU. The numbers depend on
 * the machine: the budgets are generous (about three times what a quiet machine measures) and catch regressions, not noise.
 */
export default defineConfig({
  testDir: './e2e/perf',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] },
  },
  webServer: {
    command: `npx vite preview --outDir dist-perf --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/editor-harness.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
