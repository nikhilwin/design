/**
 * End-to-end proof of in-browser background removal on the PRODUCTION build under the PRODUCTION security
 * headers (`script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-eval`, `worker-src 'self' blob:`,
 * `connect-src 'self'`): a guest design with a synthetic photo, the real U²-Net model served same-origin from
 * a MEDIA_ROOT, the real editor UI. Alpha statistics of the stored cut-out are checked, as is the failure
 * behaviour (missing model, a policy that forbids WebAssembly).
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { installMockApi } from '../support/mockApi'
import { startCspServer, type CspServer, type CspServerOptions } from './cspServer'
import { appConfig, DIST, MEDIA_ROOT, modelConfig, readCutout, scenePng, seedImageDesign, type AlphaStats, type Scene } from './support'

const model = modelConfig()
const servers: CspServer[] = []

test.skip(!existsSync(path.join(DIST, 'index.html')), `Build the app first ("npm run build"): this spec serves ${DIST} with the production headers.`)

async function serve(options: Partial<CspServerOptions> = {}): Promise<CspServer> {
  const server = await startCspServer({ dist: DIST, mediaRoot: MEDIA_ROOT, ...options })
  servers.push(server)
  return server
}

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** Console errors and CSP violations seen on the page and in every worker it starts. */
function watchViolations(page: Page): string[] {
  const problems: string[] = []
  const note = (type: string, text: string): void => {
    if (/content security policy|refused to|unsafe-eval/i.test(text) || type === 'pageerror') problems.push(`${type}: ${text}`)
  }
  page.on('console', (message) => note(message.type(), message.text()))
  page.on('pageerror', (error) => note('pageerror', error.message))
  page.on('worker', (worker) => worker.on('console', (message) => note(message.type(), message.text())))
  return problems
}

async function openDesign(page: Page, server: CspServer, scene: Scene, width: number, height: number, installed = true): Promise<void> {
  await installMockApi(page, { config: appConfig(installed ? model.model : null) })
  await page.goto(`${server.origin}/`)
  const id = await seedImageDesign(page, scenePng(scene, width, height), width, height)
  await page.goto(`${server.origin}/local/${id}`)
  await expect(page.locator('[data-editor-root]')).toBeVisible()
}

async function startRemoval(page: Page): Promise<void> {
  const root = page.locator('[data-editor-root]')
  await root.click({ position: { x: 700, y: 450 } })
  await page.keyboard.press('Control+A')
  await page.getByRole('button', { name: 'Remove background' }).click()
}

/** Runs a removal to the end and returns how long the dialog was open (ms). */
async function removeBackground(page: Page): Promise<number> {
  const started = Date.now()
  await startRemoval(page)
  const dialog = page.getByRole('dialog', { name: 'Remove background' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toBeHidden({ timeout: 120_000 })
  const elapsed = Date.now() - started
  await expect(page.getByText('Background removed').first()).toBeVisible()
  return elapsed
}

function expectCleanCutout(stats: AlphaStats | null, width: number, height: number): asserts stats is AlphaStats {
  expect(stats, 'a cut-out was stored').not.toBeNull()
  expect([stats!.width, stats!.height]).toEqual([width, height])
  expect(stats!.transparent, 'the backdrop is gone').toBeGreaterThan(0.4)
  expect(stats!.opaque, 'the subject is kept').toBeGreaterThan(0.12)
  expect(stats!.coverage).toBeGreaterThan(0.12)
  expect(stats!.coverage).toBeLessThan(0.55)
  expect(stats!.partial, 'edges are crisp, not a haze').toBeLessThan(0.06)
  expect(stats!.centre).toBeGreaterThanOrEqual(250)
  for (const corner of stats!.corners) expect(corner).toBeLessThanOrEqual(5)
  expect(stats!.largestRegion, 'one connected subject').toBeGreaterThan(0.95)
}

test('the production policy allows what the engine needs and nothing more', async () => {
  const server = await serve()
  const directive = (name: string): string[] => (server.policy.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name) ?? []).slice(1)
  expect(directive('script-src')).toContain("'wasm-unsafe-eval'")
  expect(directive('script-src')).not.toContain("'unsafe-eval'")
  expect(directive('script-src')).not.toContain("'unsafe-inline'")
  expect(directive('worker-src')).toEqual(expect.arrayContaining(["'self'", 'blob:']))
  expect(directive('connect-src')).toContain("'self'")
  expect(directive('default-src')).toEqual(["'self'"])
})

test.describe('background removal under the production CSP', () => {
  test.skip(!model.installed, `Install the model first: (cd backend && python manage.py sync_models) — expected ${model.file}`)

  for (const scene of ['product', 'portrait', 'animal'] as const) {
    test(`removes the background of a synthetic ${scene} photo`, async ({ page }) => {
      const server = await serve()
      const problems = watchViolations(page)
      await openDesign(page, server, scene, 640, 480)
      const elapsed = await removeBackground(page)
      expectCleanCutout(await readCutout(page), 640, 480)
      expect(problems).toEqual([])
      test.info().annotations.push({ type: 'timing', description: `${scene} 640x480: ${elapsed} ms including the first model download` })
    })
  }

  test('downloads the model once, then serves it from Cache Storage', async ({ page }) => {
    const server = await serve()
    await openDesign(page, server, 'product', 640, 480)
    await removeBackground(page)
    const downloads = () => server.requests.filter((p) => p.endsWith('.onnx')).length
    expect(downloads()).toBe(1)
    const cached = await page.evaluate(async () => (await (await caches.open('doory-models-v1')).keys()).map((r) => new URL(r.url).pathname))
    expect(cached).toEqual([model.model.url])

    await page.reload()
    await expect(page.locator('[data-editor-root]')).toBeVisible()
    await removeBackground(page)
    expect(downloads(), 'the second visit uses the cached, hash-verified copy').toBe(1)
  })

  test('shows progress while it works and can be cancelled without touching the design', async ({ page }) => {
    const server = await serve()
    await openDesign(page, server, 'product', 640, 480)
    await startRemoval(page)
    const dialog = page.getByRole('dialog', { name: 'Remove background' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('progressbar')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(4000) // the worker may still be finishing; its answer must be ignored
    expect(await readCutout(page)).toBeNull()
    await expect(page.getByText('Background removed')).toHaveCount(0)
  })

  test('uses WebAssembly threads when the page is cross-origin isolated, with the same result', async ({ page }) => {
    const server = await serve({ isolate: true })
    const problems = watchViolations(page)
    await openDesign(page, server, 'product', 640, 480)
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
    await removeBackground(page)
    expectCleanCutout(await readCutout(page), 640, 480)
    expect(problems).toEqual([])
    // The cut-out worker plus the runtime's helper threads.
    expect(page.workers().length).toBeGreaterThan(1)
  })

  test('single-threaded when the page is not isolated', async ({ page }) => {
    const server = await serve()
    await openDesign(page, server, 'product', 640, 480)
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false)
    await removeBackground(page)
    expect(page.workers()).toHaveLength(1)
  })
})

test.describe('failure behaviour', () => {
  test('fails closed with a clear message when the model file is missing', async ({ page }) => {
    const empty = mkdtempSync(path.join(tmpdir(), 'doory-empty-media-'))
    const server = await serve({ mediaRoot: empty })
    await openDesign(page, server, 'product', 320, 240)
    await startRemoval(page)
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Background removal is not available right now')
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(server.requests.filter((p) => p.endsWith('.onnx'))).toHaveLength(1)
    expect(await readCutout(page)).toBeNull()
    await page.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(page.getByRole('dialog', { name: 'Remove background' })).toBeHidden()
  })

  test('refuses a model file that is not the announced one', async ({ page }) => {
    // The server answers the model URL with the app shell (what a misconfigured SPA fallback does).
    const server = await serve()
    await openDesign(page, server, 'product', 320, 240)
    await page.route('**/media/models/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Doory</title>' }))
    await startRemoval(page)
    await expect(page.getByRole('alert')).toContainText('not available')
    expect(await readCutout(page)).toBeNull()
  })

  test.describe('without wasm-unsafe-eval', () => {
    test.skip(!model.installed, 'needs the installed model')
    test('says the site security settings block it, instead of failing silently', async ({ page }) => {
      const server = await serve({ policy: (policy) => policy.replace(" 'wasm-unsafe-eval'", '') })
      expect(server.policy).not.toContain('wasm-unsafe-eval')
      await openDesign(page, server, 'product', 320, 240)
      await startRemoval(page)
      await expect(page.getByRole('alert')).toContainText('security settings block')
      expect(await readCutout(page)).toBeNull()
    })
  })
})

test.describe('size and speed', () => {
  test.skip(!model.installed, 'needs the installed model')
  const sizes: Array<[string, number, number]> = [
    ['1 MP', 1152, 864],
    ['4 MP', 2304, 1728],
    ['12 MP', 4000, 3000],
  ]
  // The default deployment is single-threaded; isolated pages use up to four threads (and can report memory).
  for (const isolate of [false, true]) {
    for (const [label, width, height] of sizes) {
      test(`cuts out a ${label} photo (${width}x${height}) at full resolution, ${isolate ? 'with threads' : 'single-threaded'}`, async ({ page }) => {
        const server = await serve({ isolate })
        const problems = watchViolations(page)
        await openDesign(page, server, 'animal', width, height)
        const first = await removeBackground(page) // includes loading the model into the worker
        expectCleanCutout(await readCutout(page), width, height)
        expect(problems).toEqual([])
        const warm = await removeBackground(page) // the worker and model are warm now: this is the work itself
        // The browser's own account of memory (all workers included); it needs isolation and is slow, so only
        // the largest photo asks.
        const memory =
          !isolate || width < 4000
            ? null
            : await page.evaluate(async () => {
                const probe = performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }
                return probe.measureUserAgentSpecificMemory ? Math.round((await probe.measureUserAgentSpecificMemory()).bytes / 1e6) : null
              })
        const line = `${label} ${isolate ? 'threads' : 'single'}: ${first} ms first removal (model load included), ${warm} ms warm${memory ? `, ${memory} MB in use afterwards` : ''}`
        console.log(`[measure] ${line}`)
        test.info().annotations.push({ type: 'measure', description: line })
        expect(first).toBeLessThan(90_000)
        expect(warm).toBeLessThan(60_000)
      })
    }
  }
})
