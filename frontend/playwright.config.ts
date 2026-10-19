import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // The specs at the top level run against a mocked API; every folder has a config of its own (`npm run e2e:<folder>`).
  testIgnore: ['app/**', 'bg-removal/**', 'collab/**', 'comments/**', 'editor/**', 'perf/**'],
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Standalone runs start Vite themselves (with the e2e test hook enabled); set E2E_BASE_URL to reuse a server.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000, env: { VITE_E2E: 'true' } },
})
