/**
 * Generates the starter templates: `backend/data/templates/<slug>.json`, `thumbs/<slug>.webp` and `manifest.json`.
 *
 *   npm run templates:build [-- --only <slug>] [--shots <dir>] [--fonts-dir <dir>] [--out <dir>] [--check]
 *
 * It starts Vite (the real editor sources), opens `harness.html` in Chromium, composes every design with the engine,
 * writes the documents and renders page 1 of each to a 720 px WebP with the engine's exporter. `--shots` also writes
 * every page as a PNG (at 1x, larger for small documents) for review. `--check` writes nothing and fails when the files on disk differ from a rebuild.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type ViteDevServer } from 'vite'
import { chromium } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareFonts } from './fonts.ts'
import { starterServer } from './server.ts'
import type { GeneratedTemplate, StarterApi } from './harness.ts'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '../..')
const repo = resolve(frontend, '..')
const THUMB_LONG_SIDE = 720
const THUMB_MAX_BYTES = 80 * 1024

interface Args {
  only: string | null
  shots: string | null
  fontsDir: string
  out: string
  check: boolean
  port: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    only: null,
    shots: null,
    fontsDir: join(frontend, 'node_modules', '.cache', 'doory-template-fonts'),
    out: join(repo, 'backend', 'data', 'templates'),
    check: false,
    port: 5410,
  }
  for (let i = 0; i < argv.length; i++) {
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${argv[i - 1]} needs a value`)
      return next
    }
    switch (argv[i]) {
      case '--only':
        args.only = value()
        break
      case '--shots':
        args.shots = resolve(value())
        break
      case '--fonts-dir':
        args.fontsDir = resolve(value())
        break
      case '--out':
        args.out = resolve(value())
        break
      case '--port':
        args.port = Number(value())
        break
      case '--check':
        args.check = true
        break
      default:
        throw new Error(`Unknown option ${argv[i]}`)
    }
  }
  return args
}

/** Rounds every number to 3 decimals so the JSON does not carry floating point noise. */
function tidy(value: unknown): unknown {
  if (typeof value === 'number') return Number.isInteger(value) ? value : Math.round(value * 1000) / 1000
  if (Array.isArray(value)) return value.map(tidy)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidy(v)]))
  return value
}

const bytesOf = (dataUrl: string): Buffer => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')

async function thumbnail(api: (doc: GeneratedTemplate['document'], quality: number) => Promise<string>, doc: GeneratedTemplate['document']): Promise<Buffer> {
  let quality = 0.92
  for (;;) {
    const bytes = bytesOf(await api(doc, quality))
    if (bytes.length <= THUMB_MAX_BYTES || quality <= 0.3) return bytes
    quality -= 0.06
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log('Fonts: checking the Fontsource files')
  const catalog = await prepareFonts(args.fontsDir, join(repo, 'backend', 'data', 'unicode_ranges.json'), console.log)

  const server: ViteDevServer = await createServer({
    root: frontend,
    configFile: join(frontend, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port: args.port, strictPort: true, host: '127.0.0.1' },
    plugins: [starterServer({ fontsDir: args.fontsDir, catalog, templatesDir: args.out })],
  })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') console.log(`[browser ${message.type()}] ${message.text()}`)
    })
    page.on('pageerror', (error) => console.log(`[browser error] ${error.message}`))
    await page.goto(`http://127.0.0.1:${args.port}/scripts/templates/harness.html`)
    await page.waitForFunction(() => document.title === 'ready' || document.title.startsWith('failed'), undefined, { timeout: 120_000 })
    const title = await page.title()
    if (title !== 'ready') throw new Error(`The generator page ${title}`)

    let templates = await page.evaluate(() => (window as unknown as { __starter: StarterApi }).__starter.generate())
    if (args.only) templates = templates.filter((t) => t.slug === args.only)
    if (templates.length === 0) throw new Error('No template to build')

    await mkdir(join(args.out, 'thumbs'), { recursive: true })
    if (args.shots) await mkdir(args.shots, { recursive: true })
    const render = (doc: GeneratedTemplate['document'], pageIndex: number, options: Parameters<StarterApi['render']>[2]): Promise<string> =>
      page.evaluate(([d, i, o]) => (window as unknown as { __starter: StarterApi }).__starter.render(d, i, o), [doc, pageIndex, options] as const)

    const written: string[] = []
    const manifest: Record<string, unknown>[] = []
    for (const template of templates) {
      const doc = tidy(template.document) as GeneratedTemplate['document']
      const json = `${JSON.stringify(doc)}\n`
      const thumb = await thumbnail((d, quality) => render(d, 0, { longSide: THUMB_LONG_SIDE, type: 'image/webp', quality }), doc)
      const jsonPath = join(args.out, `${template.slug}.json`)
      const thumbPath = join(args.out, 'thumbs', `${template.slug}.webp`)
      if (args.check) {
        const same = existsSync(jsonPath) && (await readFile(jsonPath, 'utf8')) === json
        console.log(`${same ? 'ok     ' : 'DIFFERS'} ${template.slug}.json`)
        if (!same) process.exitCode = 1
      } else {
        await writeFile(jsonPath, json)
        await writeFile(thumbPath, thumb)
        written.push(template.slug)
        console.log(`wrote ${template.slug}: ${(json.length / 1024).toFixed(0)} KB json, ${(thumb.length / 1024).toFixed(0)} KB thumbnail, ${doc.pages.length} page(s)`)
      }
      if (args.shots) {
        for (let i = 0; i < doc.pages.length; i++) {
          // Small documents (a business card is 336 px wide) are photographed larger so they can be judged by eye.
          const multiplier = Math.max(1, Math.ceil(1000 / Math.max(doc.width, doc.height)))
          await writeFile(join(args.shots, `${template.slug}-p${i + 1}.png`), bytesOf(await render(doc, i, { multiplier, type: 'image/png' })))
        }
      }
      manifest.push({
        slug: template.slug,
        title: template.title,
        category: template.category,
        tags: template.tags,
        description: template.description,
        preset: template.preset,
        is_featured: template.featured,
        fonts: template.fonts,
      })
    }
    if (!args.only && !args.check) {
      await writeFile(join(args.out, 'manifest.json'), `${JSON.stringify({ version: 1, templates: manifest }, null, 2)}\n`)
      console.log(`wrote manifest.json (${manifest.length} templates)`)
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
