/**
 * Opens every starter template in the real editor (real fonts, in-memory adapter) and uses it the way a person would.
 *
 *   npm run templates:qa [-- --only <slug>] [--dir <templates dir>] [--shots <dir>] [--port 5411]
 *
 * Per template it checks that: the document opens with every object and no console error; every font it names is
 * loaded; each page object lies inside its page; every text box can be edited (double-click, type, undo) and nothing
 * covers it; every photo slot opens the picker when clicked and takes a picture (and undo brings the slot back); an edit
 * undoes and redoes exactly; the exports (PNG, JPG, SVG, PDF) produce files. It exits non-zero on any failure.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from '@playwright/test'
import { createCanvas } from 'canvas'
import { createServer } from 'vite'
import type { DocObject, DoryDocument } from '@/types/document'
import { prepareFonts } from './fonts.ts'
import { starterServer } from './server.ts'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '../..')
const repo = resolve(frontend, '..')

interface Args {
  only: string | null
  dir: string
  shots: string | null
  fontsDir: string
  port: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    only: null,
    dir: join(repo, 'backend', 'data', 'templates'),
    shots: null,
    fontsDir: join(frontend, 'node_modules', '.cache', 'doory-template-fonts'),
    port: 5411,
  }
  for (let i = 0; i < argv.length; i++) {
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${argv[i - 1]} needs a value`)
      return next
    }
    if (argv[i] === '--only') args.only = value()
    else if (argv[i] === '--dir') args.dir = resolve(value())
    else if (argv[i] === '--shots') args.shots = resolve(value())
    else if (argv[i] === '--fonts-dir') args.fontsDir = resolve(value())
    else if (argv[i] === '--port') args.port = Number(value())
    else throw new Error(`Unknown option ${argv[i]}`)
  }
  return args
}

const walk = (objects: readonly DocObject[]): DocObject[] => objects.flatMap((o) => [o, ...(Array.isArray(o.objects) ? walk(o.objects as DocObject[]) : [])])

/** A small gradient picture to put into photo slots. */
function samplePhoto(): Buffer {
  const canvas = createCanvas(640, 480)
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 640, 480)
  gradient.addColorStop(0, '#2563eb')
  gradient.addColorStop(1, '#f59e0b')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 640, 480)
  return canvas.toBuffer('image/png')
}

class Report {
  failures: string[] = []
  notes: string[] = []
  fail(message: string): void {
    this.failures.push(message)
    console.log(`  FAIL ${message}`)
  }
  note(message: string): void {
    this.notes.push(message)
    console.log(`  ok   ${message}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Makes the page the active one again if an undo took the editor back to another page. */
async function ensurePage(page: Page, index: number): Promise<void> {
  const moved = await page.evaluate(async (i) => {
    const { engine } = window.__qa!
    const id = engine.state.doc.pages[i].id
    if (engine.state.activePageId === id && engine.viewOf(id)) return false
    engine.pages.activate(id, true)
    for (let tries = 0; tries < 120; tries++) {
      if (engine.viewOf(id) && engine.state.loadingPages.length === 0 && engine.state.activePageId === id) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, 400))
    return true
  }, index)
  if (moved) await sleep(100)
}

/** Scrolls to a page at fit-to-page zoom and waits until its canvas is live (pages away from the viewport are only bitmaps). */
async function showPage(page: Page, index: number): Promise<void> {
  await page.evaluate(async (i) => {
    const { engine } = window.__qa!
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const id = engine.state.doc.pages[i].id
    engine.view.fit('fit-page')
    engine.pages.activate(id, true)
    for (let tries = 0; tries < 120; tries++) {
      if (engine.viewOf(id) && engine.state.loadingPages.length === 0 && engine.state.activePageId === id) break
      await wait(50)
    }
    await wait(500)
  }, index)
}

async function checkSlug(page: Page, slug: string, doc: DoryDocument, report: Report, args: Args): Promise<void> {
  const consoleErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('404')) consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(e.message))

  await page.goto(`http://127.0.0.1:${args.port}/scripts/templates/editor.html?slug=${slug}`)
  await page.waitForFunction(() => {
    const qa = window.__qa
    return !!qa && qa.engine.state.loadingPages.length === 0 && !!qa.engine.activeView()
  }, undefined, { timeout: 60_000 })
  await sleep(600)

  // 1. Every object arrived and none was replaced by the "unavailable" stand-in.
  for (let index = 0; index < doc.pages.length; index++) {
    const expected = doc.pages[index].objects.length
    await showPage(page, index)
    const live = await page.evaluate((i) => {
      const { engine } = window.__qa!
      const view = engine.viewOf(engine.state.doc.pages[i].id)
      const objects = view ? view.canvas.getObjects() : []
      return { count: objects.length, unavailable: objects.filter((o) => (o as unknown as { rawDoc?: unknown }).rawDoc !== undefined).length }
    }, index)
    if (live.count !== expected) report.fail(`page ${index + 1}: ${live.count} live objects, ${expected} in the document`)
    else if (live.unavailable > 0) report.fail(`page ${index + 1}: ${live.unavailable} object(s) could not be rebuilt`)
    else report.note(`page ${index + 1}: ${expected} objects open`)
  }

  // 2. Fonts are loaded.
  const fonts = [...new Set(doc.pages.flatMap((p) => walk(p.objects)).filter((o) => o.type === 'textbox').map((o) => `${o.fontStyle ?? 'normal'} ${o.fontWeight ?? 400} 16px ${String(o.fontFamily)}`))]
  const unloaded = await page.evaluate((specs) => specs.filter((spec) => !document.fonts.check(spec)), fonts)
  if (unloaded.length > 0) report.fail(`fonts not loaded: ${unloaded.join('; ')}`)
  else report.note(`${fonts.length} font face(s) loaded`)

  for (let index = 0; index < doc.pages.length; index++) {
    const pageDoc = doc.pages[index]
    await showPage(page, index)

    // 3. Every top-level object lies inside its page.
    const bounds = await page.evaluate((i) => {
      const { engine } = window.__qa!
      const out: { name: string; x: number; y: number; width: number; height: number; slack: number }[] = []
      for (const o of engine.state.doc.pages[i].objects) {
        // A framed photo is larger than its frame and clipped to it: what shows is the frame.
        const slot = o.slot as { cx: number; cy: number; width: number; height: number; angle: number } | undefined
        if (slot) {
          const rad = (slot.angle * Math.PI) / 180
          const width = Math.abs(slot.width * Math.cos(rad)) + Math.abs(slot.height * Math.sin(rad))
          const height = Math.abs(slot.width * Math.sin(rad)) + Math.abs(slot.height * Math.cos(rad))
          out.push({ name: String(o.name), x: slot.cx - width / 2, y: slot.cy - height / 2, width, height, slack: 0 })
          continue
        }
        engine.select([o.id], engine.state.doc.pages[i].id)
        const b = engine.state.selection.bounds
        if (!b) continue
        // `bounds` is the turned box's top-left with the unturned size: measure the box that really covers the object.
        const rad = (b.angle * Math.PI) / 180
        const width = Math.abs(b.width * Math.cos(rad)) + Math.abs(b.height * Math.sin(rad))
        const height = Math.abs(b.width * Math.sin(rad)) + Math.abs(b.height * Math.cos(rad))
        const stroke = typeof o.stroke === 'string' && typeof o.strokeWidth === 'number' ? o.strokeWidth / 2 : 0
        out.push({ name: String(o.name), x: b.x, y: b.y, width, height, slack: stroke })
      }
      engine.clearSelection()
      return out
    }, index)
    const w = doc.pages[index].width ?? doc.width
    const h = doc.pages[index].height ?? doc.height
    const outside = bounds.filter((b) => b.x < -0.6 - b.slack || b.y < -0.6 - b.slack || b.x + b.width > w + 0.6 + b.slack || b.y + b.height > h + 0.6 + b.slack)
    if (outside.length > 0) report.fail(`page ${index + 1}: outside the page: ${outside.map((b) => `${b.name} (${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})`).join(', ')}`)
    else report.note(`page ${index + 1}: ${bounds.length} objects inside ${w}x${h}`)

    await page.evaluate(() => window.__qa!.engine.view.fit('fit-page'))
    await sleep(500)
    // 4. Every text box can be edited where it is.
    const before = JSON.stringify(await page.evaluate(() => window.__qa!.engine.state.doc))
    const texts = pageDoc.objects.filter((o) => o.type === 'textbox')
    let edited = 0
    const centreOf = (id: string): Promise<{ x: number; y: number } | null> =>
      page.evaluate((target) => {
        const { engine } = window.__qa!
        const view = engine.activeView()
        if (!view) return null
        const obj = view.canvas.getObjects().find((o) => (o as unknown as { id?: string }).id === target)
        if (!obj) return null
        const centre = obj.getCenterPoint().transform(view.canvas.viewportTransform)
        const rect = view.canvas.getElement().getBoundingClientRect()
        return { x: rect.left + centre.x, y: rect.top + centre.y }
      }, id)
    // The top bar, the page-navigation pill, "Add page" and the zoom control cover the edges of the workspace: scroll objects clear of them.
    const reach = async (id: string): Promise<{ x: number; y: number } | null> => {
      const at = await centreOf(id)
      if (!at || (at.y <= 860 && at.y >= 150)) return at
      await page.mouse.move(800, 500)
      await page.mouse.wheel(0, at.y - 450)
      await sleep(250)
      return centreOf(id)
    }
    for (const text of texts) {
      await ensurePage(page, index)
      const at = await reach(text.id as string)
      if (!at) {
        report.fail(`"${String(text.name)}" is not on the canvas`)
        continue
      }
      if (at.x < 0 || at.y < 0 || at.x > 1600 || at.y > 1000) {
        report.fail(`"${String(text.name)}" is off screen at fit-to-page zoom (${Math.round(at.x)},${Math.round(at.y)})`)
        continue
      }
      let ok = false
      // A loaded machine can swallow the first double-click while the canvas is still repainting: try twice.
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        await page.mouse.dblclick(at.x, at.y)
        ok = await page
          .waitForFunction(() => window.__qa!.engine.state.selection.editing, undefined, { timeout: 2500 })
          .then(() => true)
          .catch(() => false)
        if (!ok) {
          await page.keyboard.press('Escape')
          await sleep(400)
        }
      }
      if (!ok) {
        const hit = await page.evaluate(() => window.__qa!.engine.state.selection.objects.map((o) => String(o.name)).join(','))
        const element = await page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y)
          return el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}` : 'nothing'
        }, [at.x, at.y])
        report.fail(`"${String(text.name)}" does not enter edit mode on double-click at (${Math.round(at.x)},${Math.round(at.y)}) over ${element} (selected: ${hit || 'nothing'})`)
        await page.keyboard.press('Escape')
        continue
      }
      await sleep(150)
      await page.keyboard.type('Q')
      await page.keyboard.press('Escape')
      const typed = await page.evaluate((id) => {
        const o = window.__qa!.engine.state.doc.pages.flatMap((p) => p.objects).find((x) => x.id === id)
        return o ? String(o.text) : null
      }, text.id as string)
      if (typed !== 'Q') report.fail(`"${String(text.name)}": typing replaced the text with "${String(typed)}", not "Q"`)
      else edited++
      await page.evaluate(async () => {
        const { engine } = window.__qa!
        for (let i = 0; i < 4 && engine.state.history.canUndo; i++) await engine.undo()
      })
      await page.evaluate(() => window.__qa!.engine.clearSelection())
      await sleep(250)
    }
    await ensurePage(page, index)
    const restored = JSON.stringify(await page.evaluate(() => window.__qa!.engine.state.doc))
    if (restored !== before) report.fail(`page ${index + 1}: undo after text edits did not restore the document`)
    else report.note(`page ${index + 1}: ${edited}/${texts.length} text boxes edited and restored by undo`)

    // 5. Photo slots open the picker and take a picture.
    const slots = pageDoc.objects.filter((o) => o.isPlaceholder === true)
    for (const slot of slots) {
      await ensurePage(page, index)
      await sleep(300)
      const at = await reach(slot.id as string)
      if (!at) {
        report.fail(`photo slot "${String(slot.name)}" is not on the canvas`)
        continue
      }
      const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null)
      await page.mouse.click(at.x, at.y)
      const picker = await chooser
      if (!picker) {
        report.fail(`photo slot "${String(slot.name)}" does not open the picker when clicked`)
        continue
      }
      await picker.setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: samplePhoto() })
      const filled = await page
        .waitForFunction((id) => {
          const objects = window.__qa!.engine.state.doc.pages.flatMap((p) => p.objects)
          return !objects.some((o) => o.id === id) && objects.some((o) => o.type === 'image' && o.slot !== undefined)
        }, slot.id as string, { timeout: 5000 })
        .then(() => true)
        .catch(() => false)
      if (!filled) {
        report.fail(`photo slot "${String(slot.name)}" did not take the picture`)
        continue
      }
      await sleep(300)
      await page.evaluate(async () => {
        const { engine } = window.__qa!
        for (let i = 0; i < 3 && engine.state.history.canUndo; i++) {
          if (engine.state.doc.pages.flatMap((p) => p.objects).some((o) => o.type === 'image' && o.slot !== undefined)) await engine.undo()
        }
      })
      const back = await page.evaluate((id) => window.__qa!.engine.state.doc.pages.flatMap((p) => p.objects).some((o) => o.id === id), slot.id as string)
      if (!back) report.fail(`photo slot "${String(slot.name)}" did not come back after undo`)
      else report.note(`photo slot "${String(slot.name)}" opens the picker, takes a picture and undoes`)
    }
    await page.evaluate(() => window.__qa!.engine.clearSelection())

    // 6. An edit undoes and redoes exactly.
    const target = pageDoc.objects.find((o) => o.type !== 'textbox' && o.locked !== true && o.isPlaceholder !== true)
    if (target) {
      await ensurePage(page, index)
      const result = await page.evaluate(async (id) => {
        const { engine } = window.__qa!
        const snapshot = (): string => JSON.stringify(engine.state.doc)
        const original = snapshot()
        engine.select([id])
        engine.style.setOpacity(0.5)
        const edited = snapshot()
        await engine.undo()
        const undone = snapshot()
        await engine.redo()
        const redone = snapshot()
        await engine.undo()
        return { changed: edited !== original, undoExact: undone === original, redoExact: redone === edited, finalExact: snapshot() === original }
      }, target.id as string)
      if (!result.changed || !result.undoExact || !result.redoExact || !result.finalExact) report.fail(`page ${index + 1}: undo/redo is not exact ${JSON.stringify(result)}`)
      else report.note(`page ${index + 1}: undo and redo are exact`)
    }
  }

  // 7. Exports.
  for (const format of ['png', 'jpg', 'svg', 'pdf']) {
    const files = await page
      .evaluate((id) => window.__qa!.exportAll(id), format)
      .catch((error: unknown) => String(error))
    if (typeof files === 'string') report.fail(`export ${format}: ${files}`)
    else if (files.length !== (format === 'pdf' ? 1 : doc.pages.length) || files.some((f) => f.bytes < 500)) report.fail(`export ${format}: ${JSON.stringify(files)}`)
    else report.note(`export ${format}: ${files.length} file(s), ${files.map((f) => `${(f.bytes / 1024).toFixed(0)} KB`).join(', ')}`)
  }

  if (args.shots) {
    await page.evaluate(() => window.__qa!.engine.view.fit('fit-page'))
    await sleep(400)
    await page.screenshot({ path: join(args.shots, `${slug}-editor.png`) })
  }
  if (consoleErrors.length > 0) report.fail(`console errors: ${[...new Set(consoleErrors)].join(' | ')}`)
  else report.note('no console errors')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(await readFile(join(args.dir, 'manifest.json'), 'utf8')) as { templates: { slug: string }[] }
  const slugs = manifest.templates.map((t) => t.slug).filter((slug) => !args.only || slug === args.only)
  const catalog = await prepareFonts(args.fontsDir, join(repo, 'backend', 'data', 'unicode_ranges.json'), console.log)
  if (args.shots) await mkdir(args.shots, { recursive: true })

  const server = await createServer({
    root: frontend,
    configFile: join(frontend, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port: args.port, strictPort: true, host: '127.0.0.1' },
    plugins: [starterServer({ fontsDir: args.fontsDir, catalog, templatesDir: args.dir })],
  })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' })
  let failed = 0
  try {
    for (const slug of slugs) {
      console.log(slug)
      const doc = JSON.parse(await readFile(join(args.dir, `${slug}.json`), 'utf8')) as DoryDocument
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
      const page = await context.newPage()
      const report = new Report()
      try {
        await checkSlug(page, slug, doc, report, args)
      } catch (error) {
        report.fail(`the check itself broke: ${error instanceof Error ? error.message : String(error)}`)
      }
      failed += report.failures.length
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
  console.log(failed === 0 ? `\nAll ${slugs.length} templates passed.` : `\n${failed} problem(s).`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
