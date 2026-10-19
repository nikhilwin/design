import { defineConfig, devices } from '@playwright/test'
import { appStack } from './e2e/app/support/ports'

const stack = appStack()
/** `npm run e2e:app:prod` serves the production build (`dist-app`) instead of the dev server: the same specs, minified code. */
const production = process.env.E2E_APP_PROD === 'true'

/**
 * The whole product against the real backend: Django on a fresh SQLite database with the starter content (see
 * `e2e/app/api-server.mjs`), a local mail sink and the Vite dev server, on free ports. `npm run e2e:app`; see
 * `e2e/README.md` ("Real stack"). Screenshots go to `SCREENSHOT_DIR` when it is set.
 *
 * The dev server is the default (it also compiles in the `window.__doory_e2e` test hooks); with `E2E_APP_PROD=true` the
 * web server is `vite preview` of a production build, which is what `perf.spec.ts` and `security.spec.ts` measure.
 */
export default defineConfig({
  testDir: './e2e/app',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${stack.web}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  webServer: [
    {
      command: 'node e2e/app/api-server.mjs',
      url: `http://127.0.0.1:${stack.api}/api/v1/health/`,
      timeout: 240_000,
      reuseExistingServer: false,
    },
    {
      command: production ? `npx vite preview --outDir dist-app --port ${stack.web} --strictPort` : `npx vite --port ${stack.web} --strictPort`,
      url: `http://localhost:${stack.web}/`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_API_PROXY: `http://127.0.0.1:${stack.api}`, VITE_E2E: production ? 'false' : 'true' },
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
