import { defineConfig, devices } from '@playwright/test'

const WEB = Number(process.env.E2E_COMMENTS_PORT ?? 5390)
const API = Number(process.env.E2E_COMMENTS_API_PORT ?? 8120)
// The helpers shared with the co-editing specs (e2e/collab/helpers.ts) read their web port from this variable.
process.env.E2E_COLLAB_PORT = String(WEB)

/**
 * Comments against the real backend: Django (SQLite, started by the co-editing specs' `api-server.mjs`) and the Vite dev
 * server, with the owner of a design, somebody commenting through a link and a visitor in browser contexts of their own.
 * `npm run e2e:comments`.
 */
export default defineConfig({
  testDir: './e2e/comments',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  webServer: [
    {
      command: 'node e2e/collab/api-server.mjs',
      url: `http://127.0.0.1:${API}/api/v1/health/`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: { E2E_COLLAB_API_PORT: String(API), E2E_COLLAB_PORT: String(WEB) },
    },
    {
      command: `npx vite --port ${WEB} --strictPort`,
      url: `http://localhost:${WEB}/`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_API_PROXY: `http://127.0.0.1:${API}`, VITE_E2E: 'true' },
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
