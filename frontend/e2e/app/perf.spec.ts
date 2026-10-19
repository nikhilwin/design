/**
 * First load of every shell route on the production build (`npm run e2e:app:prod`): what is downloaded (gzip size of scripts and
 * styles, fonts, images), the largest contentful paint, and that nothing of the editor is fetched by pages that do not open it.
 * It prints a table of the first load by route.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Browser } from '@playwright/test'
import { expect, test, Api, createAccount, openContext, type Account } from './support/stack'
import { seedDesigns } from './support/seed'

test.skip(process.env.E2E_APP_PROD !== 'true', 'measures the production build: run `npm run e2e:app:prod`')

interface Sample {
  route: string
  requests: number
  scriptKb: number
  styleKb: number
  fontKb: number
  imageKb: number
  lcpMs: number | null
  heavy: string[]
}

const HEAVY_URL = /\/(fabric|jspdf|html2canvas|purify|ort-wasm|worker)[-.]/i
const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10

declare global {
  interface Window {
    __lcp?: number
  }
}

async function measure(browser: Browser, account: Account | null, route: string, ready: (page: import('@playwright/test').Page) => Promise<void>): Promise<Sample> {
  const { page, context } = await openContext(browser, account)
  await context.addInitScript(() => {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__lcp = entry.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  })
  const sizes = { script: 0, style: 0, font: 0, image: 0 }
  const heavy: string[] = []
  let requests = 0
  const pending: Promise<void>[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin !== new URL(page.url() === 'about:blank' ? response.url() : page.url()).origin || url.pathname.startsWith('/api/')) return
    requests += 1
    pending.push(
      (async () => {
        const body = await response.body().catch(() => Buffer.alloc(0))
        const type = response.headers()['content-type'] ?? ''
        if (type.includes('javascript')) {
          sizes.script += gzipSync(body).length
          if (HEAVY_URL.test(url.pathname) || body.includes('data-editor-root')) heavy.push(url.pathname)
        } else if (type.includes('css')) sizes.style += gzipSync(body).length
        else if (type.includes('font') || /\.woff2?$/.test(url.pathname)) sizes.font += body.length
        else if (type.includes('image')) sizes.image += body.length
        if (/\.wasm$/.test(url.pathname)) heavy.push(url.pathname)
      })(),
    )
  })
  await page.goto(route)
  await ready(page)
  await page.waitForLoadState('networkidle')
  await Promise.all(pending)
  const lcp = await page.evaluate(() => window.__lcp ?? null)
  await context.close()
  return { route, requests, scriptKb: kb(sizes.script), styleKb: kb(sizes.style), fontKb: kb(sizes.font), imageKb: kb(sizes.image), lcpMs: lcp === null ? null : Math.round(lcp), heavy }
}

test('no shell route downloads the editor, Fabric, jsPDF or the background-removal runtime, and each stays small', async ({ browser }) => {
  test.setTimeout(240_000)
  const owner = await createAccount('Perf Pat')
  const api = await Api.create(owner.state)
  await seedDesigns(api, 12, { prefix: 'Perf', thumbnails: true })
  const templates = await (await Api.create()).call<{ results: { slug: string }[] }>('get', '/templates/')
  const slug = templates.results[0]!.slug
  const heading = (page: import('@playwright/test').Page) => page.getByRole('heading').first().waitFor()

  const samples: Sample[] = []
  for (const [account, route] of [
    [null, '/'],
    [null, '/templates'],
    [null, `/templates/${slug}`],
    [null, '/login'],
    [null, '/signup'],
    [owner, '/dashboard'],
    [owner, '/dashboard/designs'],
    [owner, '/dashboard/brand'],
    [owner, '/dashboard/uploads'],
    [owner, '/settings'],
  ] as const) {
    samples.push(await measure(browser, account, route, heading))
  }

  const table = [
    '| Route | Requests | Scripts (gzip) | Styles (gzip) | Fonts | Images | LCP |',
    '|-------|---------:|---------------:|--------------:|------:|-------:|----:|',
    ...samples.map((sample) => `| \`${sample.route.replace(slug, ':slug')}\` | ${sample.requests} | ${sample.scriptKb} kB | ${sample.styleKb} kB | ${sample.fontKb} kB | ${sample.imageKb} kB | ${sample.lcpMs === null ? 'n/a' : `${sample.lcpMs} ms`} |`),
  ].join('\n')
  console.log(`\n${table}\n`)
  const out = process.env.SCREENSHOT_DIR
  if (out) {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'perf-table.md'), `${table}\n`)
  }

  for (const sample of samples) {
    expect(sample.heavy, `${sample.route} downloaded editor-only code`).toEqual([])
    expect(sample.scriptKb, `${sample.route} scripts`).toBeLessThan(220)
    expect(sample.styleKb, `${sample.route} styles`).toBeLessThan(40)
    if (sample.lcpMs !== null) expect(sample.lcpMs, `${sample.route} LCP`).toBeLessThan(4000)
  }
})
