import { defineConfig, devices } from '@playwright/test'

/**
 * Background-removal e2e: serves the production build (`dist/`) with the production security headers and runs
 * the real model in Chromium. Needs `npm run build` and an installed model (`manage.py sync_models`, or
 * BG_MEDIA_ROOT pointing at a MEDIA_ROOT that has one). Run with `npm run e2e:bg`.
 */
export default defineConfig({
  testDir: './e2e/bg-removal',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
