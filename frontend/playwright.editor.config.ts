import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_EDITOR_PORT ?? 5199)

/** Editor e2e: serves the dev harness (/editor-harness.html) and runs the specs in e2e/editor. */
export default defineConfig({
  testDir: './e2e/editor',
  // Runs against the real backend: `npm run e2e:print` (playwright.print.config.ts).
  testIgnore: 'print-stack.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/editor-harness.html`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
