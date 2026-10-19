/**
 * Test double for the font endpoints (`/api/v1/fonts/mine/`) and the font files under `/media/fonts/user/`, for the
 * font specs. It keeps what was uploaded (the real bytes of the fixture fonts), answers with the server's error
 * codes on demand and records what the editor sent, so a spec can upload, reload and export through the real client.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'

export const FIXTURES = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url))
export const fixture = (name: string): string => join(FIXTURES, name)

interface FixtureFacts {
  family: string
  weight: number
  style: 'normal' | 'italic'
}

/** What the server would detect in each generated test font. */
export const FIXTURE_FACTS: Record<string, FixtureFacts> = {
  'DooryBlocks-Regular.ttf': { family: 'Doory Blocks', weight: 400, style: 'normal' },
  'DooryBlocks-Bold.ttf': { family: 'Doory Blocks', weight: 700, style: 'normal' },
  'DooryBlocks-Italic.ttf': { family: 'Doory Blocks', weight: 400, style: 'italic' },
  'DooryDiamonds-Regular.woff2': { family: 'Doory Diamonds', weight: 400, style: 'normal' },
}

interface StoredVariant {
  weight: number
  style: 'normal' | 'italic'
  path: string
  bytes: Buffer
  type: string
}
interface StoredFamily {
  id: string
  family: string
  variants: StoredVariant[]
}

export interface Failure {
  status: number
  code: string
  message?: string
  fields?: Record<string, string[]>
  /** Seconds to wait, as in the `error.retry_after` of a 429. */
  retryAfter?: number
}

export interface Upload {
  files: string[]
  family: string | null
}

interface Part {
  name: string
  filename?: string
  data: Buffer
}

function parseMultipart(body: Buffer, contentType: string): Part[] {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  if (!boundary) return []
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: Part[] = []
  let start = body.indexOf(delimiter)
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length)
    if (next === -1) break
    const chunk = body.subarray(start + delimiter.length + 2, next - 2)
    const split = chunk.indexOf('\r\n\r\n')
    const head = chunk.subarray(0, split).toString('utf8')
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1] ?? '',
      filename: /filename="([^"]*)"/.exec(head)?.[1],
      data: chunk.subarray(split + 4),
    })
    start = next
  }
  return parts
}

export class FakeFontServer {
  readonly families: StoredFamily[] = []
  readonly uploads: Upload[] = []
  readonly deleted: string[] = []
  /** Answered, in order, to the next uploads instead of storing them. */
  readonly failures: Failure[] = []
  /** Answered to the next `listFailures` list requests. */
  listFailure: Failure | null = null
  listFailures = 1
  private counter = 0

  /** Names the server refuses without a `family` override (the built-in catalog). */
  reserved = ['inter', 'playfair display', 'caveat']

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/fonts/mine/**', (route) => this.handle(route))
    await page.route('**/media/fonts/user/**', (route) => this.file(route))
  }

  /** The family as the API lists it. */
  describe(family: StoredFamily): Record<string, unknown> {
    return {
      id: family.id,
      family: family.family,
      category: 'sans-serif',
      scripts: ['latin'],
      is_variable: false,
      is_user_font: true,
      variants: family.variants
        .map((v) => ({ weight: v.weight, style: v.style, url: v.path, subsets: [] }))
        .sort((a, b) => a.weight - b.weight || (a.style === 'normal' ? -1 : 1)),
      unicode_ranges: {},
      popularity: 9999,
    }
  }

  /** Seeds a family that was uploaded earlier (before the page opened). */
  async seed(...names: string[]): Promise<void> {
    for (const name of names) await this.store(name, null)
  }

  /** Playwright does not hand over the bytes of a file in a request body, so the font is read from its fixture by name. */
  private async store(file: string, override: string | null): Promise<StoredFamily | Failure> {
    const facts = FIXTURE_FACTS[file]
    const data = await readFile(fixture(file))
    const family = override?.trim() || facts.family
    if (!override && this.reserved.includes(family.toLowerCase())) return { status: 409, code: 'font_name_taken', message: `A built-in font named "${family}" already exists.` }
    let existing = this.families.find((f) => f.family.toLowerCase() === family.toLowerCase())
    if (existing?.variants.some((v) => v.weight === facts.weight && v.style === facts.style)) return { status: 409, code: 'variant_exists', message: 'exists' }
    if (!existing) {
      this.counter += 1
      existing = { id: `font-${this.counter}`, family, variants: [] }
      this.families.push(existing)
    }
    this.counter += 1
    const extension = file.slice(file.lastIndexOf('.') + 1)
    existing.variants.push({ weight: facts.weight, style: facts.style, path: `/media/fonts/user/1/${this.counter}.${extension}`, bytes: data, type: extension === 'woff2' ? 'font/woff2' : 'font/ttf' })
    return existing
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const respond = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const fail = (f: Failure) =>
      route.fulfill({
        status: f.status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: f.code, message: f.message ?? f.code, ...(f.fields ? { fields: f.fields } : {}), ...(f.retryAfter ? { retry_after: f.retryAfter } : {}) } }),
      })

    if (request.method() === 'GET') {
      if (this.listFailure && this.listFailures > 0) {
        this.listFailures -= 1
        return fail(this.listFailure)
      }
      const results = [...this.families].sort((a, b) => a.family.localeCompare(b.family)).map((f) => this.describe(f))
      return respond(200, { count: results.length, next: null, previous: null, results })
    }
    if (request.method() === 'DELETE') {
      const id = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
      const index = this.families.findIndex((f) => f.id === id)
      if (index === -1) return respond(404, { error: { code: 'not_found', message: 'Not found.' } })
      this.deleted.push(this.families[index].family)
      this.families.splice(index, 1)
      return route.fulfill({ status: 204 })
    }
    const parts = parseMultipart(request.postDataBuffer() ?? Buffer.alloc(0), request.headers()['content-type'] ?? '')
    const files = parts.filter((p) => p.name === 'files' && p.filename)
    const family = parts.find((p) => p.name === 'family')?.data.toString('utf8') ?? null
    this.uploads.push({ files: files.map((f) => f.filename ?? ''), family })
    const failure = this.failures.shift()
    if (failure) return fail(failure)
    let stored: StoredFamily | Failure | null = null
    for (const file of files) {
      stored = await this.store(file.filename ?? '', family)
      if ('status' in stored) return fail(stored)
    }
    return respond(201, stored ? this.describe(stored) : {})
  }

  private async file(route: Route): Promise<void> {
    const path = new URL(route.request().url()).pathname
    const variant = this.families.flatMap((f) => f.variants).find((v) => v.path === path)
    if (!variant) return route.fulfill({ status: 404, body: 'gone' })
    return route.fulfill({ status: 200, contentType: variant.type, body: variant.bytes })
  }
}

/**
 * How much of the first page is dark ink (0..1), read from its painted canvas. Solid test-font glyphs cover far more
 * than ordinary letters, so a rise in ink tells that the text is really drawn in the uploaded font.
 */
export async function pageInk(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-artboard] .doory-canvas canvas')
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return 0
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128 && data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 140) dark += 1
    return dark / (canvas.width * canvas.height)
  })
}

/** Opens `/design/design-1` of the fake API (a signed-in owner) and waits for the first page to be drawn. */
export async function openDesign(page: Page, path = '/design/design-1'): Promise<void> {
  await page.goto(path)
  await page.waitForSelector('[data-editor-root]')
  await page.waitForSelector('[data-artboard] .doory-canvas', { timeout: 20_000 })
}

/** Opens the font list of the selected text and its "Upload a font" dialog. */
export async function openUploadDialog(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.getByTestId('ed-font').click()
  await page.getByTestId('font-upload-row').click()
  const dialog = page.getByRole('dialog', { name: 'Upload fonts' })
  await dialog.waitFor()
  return dialog
}

/** `pageInk` once the page stopped changing (the workspace re-fits when a side panel opens). */
export async function settledInk(page: Page): Promise<number> {
  let last = -1
  for (let attempt = 0; attempt < 30; attempt++) {
    const now = await pageInk(page)
    if (now > 0 && now === last) return now
    last = now
    await page.waitForTimeout(150)
  }
  return last
}

/**
 * The longest horizontal run of dark pixels in a PNG: the solid glyphs of the test fonts make runs several times longer
 * than the stems of ordinary letters, so this tells that an export was drawn in the uploaded font.
 */
export async function longestDarkRun(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return 0
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    let best = 0
    for (let y = 0; y < bitmap.height; y++) {
      let run = 0
      for (let x = 0; x < bitmap.width; x++) {
        const i = (y * bitmap.width + x) * 4
        run = data[i + 3] > 200 && data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 110 ? run + 1 : 0
        if (run > best) best = run
      }
    }
    return best
  }, png.toString('base64'))
}
