import { defineConfig, devices } from '@playwright/test'

const WEB = Number(process.env.E2E_COLLAB_PORT ?? 5380)
const API = Number(process.env.E2E_COLLAB_API_PORT ?? 8110)
/**
 * The specs run against a production bundle built with the test hook (`npm run e2e:collab` builds it into dist-collab), so
 * page loads and timings are those of a deployment. `E2E_COLLAB_DEV=1` uses the Vite dev server instead.
 */
const BUNDLE = process.env.E2E_COLLAB_DEV !== '1'

/**
 * Co-editing e2e against the real backend: Django (ASGI, SQLite, in-memory channel layer) and the Vite dev server,
 * with two or three signed-in browser contexts per spec. `npm run e2e:collab`.
 */
export default defineConfig({
  testDir: './e2e/collab',
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
      command: BUNDLE ? `npx vite preview --outDir dist-collab --port ${WEB} --strictPort` : `npx vite --port ${WEB} --strictPort`,
      url: `http://localhost:${WEB}/`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_API_PROXY: `http://127.0.0.1:${API}`, VITE_E2E: 'true' },
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
