/**
 * Editor performance profile (`npm run e2e:perf`). Two designs: 30 pages of 200 objects, and one
 * page of 1500 objects. Every test prints its measurement (`[perf] …`) and asserts a budget about three times what was measured
 * on a busy 4-core machine, so a regression of that size fails and ordinary noise does not. The production build of the harness
 * runs, with the engine reachable through the test hook, so the numbers are those of a deployment.
 */
import { expect, test, type Page } from '@playwright/test'
import { addText, openTool, toClient } from '../editor/helpers'
import { metrics, openStress, record, startRecording, stopRecording, summarize, waitForQuiet, type PerfWindow } from './support'

const MANY_PAGES = { pages: 30, objects: 200 }
const MANY_OBJECTS = { pages: 1, objects: 1500 }

/** Budgets: ms unless said, set from measurements with a factor of about 3. */
const BUDGET = {
  openManyPagesMs: 8000,
  openManyObjectsMs: 14000,
  /** Work still running in the background this long after the first page is up (30 pages x 200 objects). */
  backgroundAfterOpenMs: 6000,
  scrollLongTaskMs: 6000,
  dragFps: 6,
  /** One repaint of a page of 1500 objects with its commit (software rasterising: about 0.4 ms an object on a busy machine). */
  paint1500Ms: 3000,
  typing200Ms: 120,
  typing1500Ms: 300,
}

type Operation = 'nudge' | 'stringify' | 'save' | 'undo' | 'redo' | 'zoom'

/** Runs one operation `times` times in the page and returns the milliseconds of each run. */
async function timeEach(page: Page, operation: Operation, times: number): Promise<number[]> {
  return page.evaluate(
    async ([op, count]) => {
      const engine = (window as unknown as PerfWindow).__doory_collab!.engine
      const frames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const out: number[] = []
      for (let i = 0; i < count; i++) {
        const t0 = performance.now()
        if (op === 'nudge') {
          engine.arrange.nudge(1, 0)
          await frames()
        } else if (op === 'stringify') JSON.stringify(engine.getDocument())
        else if (op === 'save') await engine.persistence.saveNow()
        else if (op === 'undo') {
          await engine.undo()
          await frames()
        } else if (op === 'redo') {
          await engine.redo()
          await frames()
        } else {
          engine.view.setZoom([0.25, 0.5, 1, 2, 4, 2, 1, 0.5][i % 8])
          await frames()
        }
        out.push(performance.now() - t0)
      }
      return out
    },
    [operation, times] as const,
  )
}

const selectObject = (page: Page, index: number): Promise<void> =>
  page.evaluate((i) => {
    const engine = (window as unknown as PerfWindow).__doory_collab!.engine
    engine.select([engine.state.doc.pages[0].objects[i].id])
  }, index)

test.describe('open', () => {
  for (const [name, shape, budget] of [
    ['30 pages x 200 objects', MANY_PAGES, BUDGET.openManyPagesMs],
    ['1 page x 1500 objects', MANY_OBJECTS, BUDGET.openManyObjectsMs],
  ] as const) {
    test(`${name}: time to the first painted page, and what runs after it`, async ({ page }) => {
      await page.addInitScript(() => {
        const w = window as unknown as { __blobs: number; __afterOpen: number[] }
        w.__blobs = 0
        const create = URL.createObjectURL.bind(URL)
        URL.createObjectURL = (blob: Blob | MediaSource) => {
          w.__blobs++
          return create(blob)
        }
      })
      await openStress(page, shape.pages, shape.objects)
      const t = await page.evaluate(() => {
        const perf = (window as unknown as PerfWindow).__perf
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
        const paint = performance.getEntriesByName('first-contentful-paint')[0]
        return { canvasAt: perf.canvasAt, readyAt: perf.readyAt, domReady: nav.domContentLoadedEventEnd, fcp: paint?.startTime }
      })
      await startRecording(page)
      await waitForQuiet(page, 2000)
      const after = await stopRecording(page)
      const extra = await page.evaluate(() => ({ live: document.querySelectorAll('[data-artboard] .lower-canvas').length, snapshots: (window as unknown as { __blobs: number }).__blobs }))
      record(`open ${name}`, {
        domReadyMs: Math.round(t.domReady),
        firstContentfulPaintMs: Math.round(t.fcp ?? 0),
        firstCanvasMs: Math.round(t.canvasAt ?? 0),
        firstPagePaintedMs: Math.round(t.readyAt ?? 0),
        backgroundWork: { longTasks: after.longTasks, longTaskMs: after.longTaskMs },
        liveCanvases: extra.live,
        pageBitmapsMade: extra.snapshots,
      })
      expect(t.readyAt ?? Infinity).toBeLessThan(budget)
      expect(extra.live).toBeLessThanOrEqual(5)
      expect(after.longTaskMs).toBeLessThan(BUDGET.backgroundAfterOpenMs)
      // Only the pages near the viewport get a bitmap, not all 30.
      expect(extra.snapshots).toBeLessThan(12)
    })
  }
})

test('scrolling through 30 pages mounts few canvases and does not pile up work', async ({ page }) => {
  await openStress(page, MANY_PAGES.pages, MANY_PAGES.objects)
  await waitForQuiet(page)
  await startRecording(page)
  // A fling: the browser scrolls on its own thread whatever the page is doing, like a flick on a touch pad (36000 px in under a second).
  const box = (await page.locator('[data-workspace-bg]').first().boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), yDistance: -36000, speed: 40000, gestureSourceType: 'mouse' })
  const peak = await page.evaluate(() => document.querySelectorAll('[data-artboard] .lower-canvas').length)
  const during = await stopRecording(page)
  // After the fling the pages in view are mounted: the editor settles without having drawn the ones that flew past.
  await startRecording(page)
  await waitForQuiet(page, 1500)
  const settle = await stopRecording(page)
  record('scroll 30 pages', { fling: during, settle: { longTasks: settle.longTasks, longTaskMs: settle.longTaskMs }, peakLiveCanvases: peak })
  expect(peak).toBeLessThanOrEqual(6)
  expect(during.longTaskMs + settle.longTaskMs).toBeLessThan(BUDGET.scrollLongTaskMs)
})

test('the page strip draws the thumbnails that can be seen, not all of them', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __blobs: number }
    w.__blobs = 0
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      w.__blobs++
      return create(blob)
    }
  })
  await openStress(page, MANY_PAGES.pages, MANY_PAGES.objects)
  await waitForQuiet(page)
  const before = await page.evaluate(() => (window as unknown as { __blobs: number }).__blobs)
  const t0 = Date.now()
  await page.getByTestId('ed-pages-toggle').click()
  await waitForQuiet(page, 1500)
  const ms = Date.now() - t0
  const shown = await page.evaluate(() => ({ images: document.querySelectorAll('nav ol img').length, bitmaps: (window as unknown as { __blobs: number }).__blobs }))
  record('page strip of 30 pages', { msToQuiet: ms, thumbnailsDrawn: shown.images, bitmapsMade: shown.bitmaps - before })
  expect(shown.images).toBeLessThan(30)
  expect(shown.images).toBeGreaterThan(5)
})

test.describe('1 page x 200 objects: selecting and moving 100 of them', () => {
  test.beforeEach(async ({ page }) => {
    await openStress(page, 1, 200)
    await waitForQuiet(page)
  })

  async function pick100(page: Page): Promise<{ cx: number; cy: number }> {
    return page.evaluate(() => {
      const engine = (window as unknown as PerfWindow).__doory_collab!.engine
      const objects = engine.state.doc.pages[0].objects
      engine.select(objects.slice(0, 100).map((o) => o.id))
      const rect = objects.slice(0, 100).find((o) => o.type === 'rect')!
      return { cx: (rect.left ?? 0) + (rect.width ?? 0) / 2, cy: (rect.top ?? 0) + (rect.height ?? 0) / 2 }
    })
  }

  test('dragging them keeps the frame rate up', async ({ page }) => {
    const { cx, cy } = await pick100(page)
    const start = await toClient(page, cx, cy)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await startRecording(page)
    for (let i = 1; i <= 60; i++) {
      await page.mouse.move(start.x + Math.sin(i / 8) * 120, start.y + i * 2)
      await page.waitForTimeout(8)
    }
    const stats = await stopRecording(page)
    await page.mouse.up()
    record('drag 100 selected objects (200 on the page)', stats)
    expect(stats.fps).toBeGreaterThan(BUDGET.dragFps)
  })

  test('resizing them from a corner handle', async ({ page }) => {
    await pick100(page)
    const handle = await page.evaluate(() => {
      const view = (window as unknown as PerfWindow).__doory_collab!.engine.activeView()!
      const corner = view.canvas.getActiveObject()!.oCoords.br
      const box = view.canvas.upperCanvasEl.getBoundingClientRect()
      return { x: box.left + corner.x, y: box.top + corner.y }
    })
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    await startRecording(page)
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(handle.x - i * 3, handle.y - i * 2)
      await page.waitForTimeout(8)
    }
    const stats = await stopRecording(page)
    await page.mouse.up()
    record('resize 100 selected objects (200 on the page)', stats)
    expect(stats.fps).toBeGreaterThan(BUDGET.dragFps)
  })
})

test.describe('typing', () => {
  for (const [name, objects, budget] of [
    ['200 objects on the page', 200, BUDGET.typing200Ms],
    ['1500 objects on the page', 1500, BUDGET.typing1500Ms],
  ] as const) {
    test(`key to next frame with ${name}`, async ({ page }) => {
      await openStress(page, 1, objects)
      await waitForQuiet(page)
      await addText(page, 'body')
      await page.waitForTimeout(800)
      await page.evaluate(() => {
        const w = window as unknown as { __latency: number[] }
        w.__latency = []
        document.addEventListener(
          'keydown',
          () => {
            const t = performance.now()
            requestAnimationFrame(() => requestAnimationFrame(() => w.__latency.push(performance.now() - t)))
          },
          true,
        )
      })
      for (const ch of 'The quick brown fox jumps over the lazy dog') {
        await page.keyboard.press(ch === ' ' ? 'Space' : ch)
        await page.waitForTimeout(60)
      }
      await page.waitForTimeout(500)
      const latency = await page.evaluate(() => (window as unknown as { __latency: number[] }).__latency)
      const stats = summarize(latency)
      record(`typing latency, ${name}`, stats)
      expect(stats.n).toBeGreaterThan(30)
      expect(stats.medianMs).toBeLessThan(budget)
    })
  }
})

test.describe('1 page x 1500 objects', () => {
  test.beforeEach(async ({ page }) => {
    await openStress(page, MANY_OBJECTS.pages, MANY_OBJECTS.objects)
    await waitForQuiet(page)
  })

  test('a change ends with a commit: serialising 1500 objects, painting, saving, stringifying', async ({ page }) => {
    await selectObject(page, 3)
    const nudge = await timeEach(page, 'nudge', 8)
    const stringify = await timeEach(page, 'stringify', 8)
    const save = await timeEach(page, 'save', 5)
    record('1500 objects: nudge one object (commit + paint)', summarize(nudge))
    record('1500 objects: JSON.stringify of the document', summarize(stringify))
    record('1500 objects: save now (adapter call included)', summarize(save))
    // Painting 1500 objects dominates the first (software rasterising, a busy machine); the autosave itself is far below the 50 ms target.
    expect(summarize(nudge).medianMs).toBeLessThan(BUDGET.paint1500Ms)
    expect(summarize(stringify).medianMs).toBeLessThan(150)
    expect(summarize(save).medianMs).toBeLessThan(150)
  })

  test('undo and redo of a move', async ({ page }) => {
    await selectObject(page, 5)
    await page.evaluate(() => {
      const engine = (window as unknown as PerfWindow).__doory_collab!.engine
      for (let i = 0; i < 10; i++) {
        engine.arrange.nudge(5, 0)
        engine.sealHistory()
      }
    })
    const undo = await timeEach(page, 'undo', 10)
    const redo = await timeEach(page, 'redo', 10)
    record('1500 objects: undo', summarize(undo))
    record('1500 objects: redo', summarize(redo))
    expect(summarize(undo).medianMs).toBeLessThan(BUDGET.paint1500Ms)
    expect(summarize(redo).medianMs).toBeLessThan(BUDGET.paint1500Ms)
  })

  test('zoom from fit to 400 % and back', async ({ page }) => {
    const steps = await timeEach(page, 'zoom', 8)
    record('1500 objects: zoom step', summarize(steps))
    expect(summarize(steps).medianMs).toBeLessThan(BUDGET.paint1500Ms)
  })
})

test('a long session of edits leaves no growth behind (heap, nodes, listeners, blob URLs)', async ({ page }) => {
  test.setTimeout(300_000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await page.addInitScript(() => {
    const w = window as unknown as { __live: Set<string> }
    w.__live = new Set()
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = create(blob)
      w.__live.add(url)
      return url
    }
    URL.revokeObjectURL = (url: string) => {
      w.__live.delete(url)
      revoke(url)
    }
  })
  await openStress(page, 3, 120)
  await waitForQuiet(page)
  await page.getByTestId('ed-pages-toggle').click()
  const cycle = (count: number): Promise<void> =>
    page.evaluate(async (n) => {
      const engine = (window as unknown as PerfWindow).__doory_collab!.engine
      const frames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      for (let i = 0; i < n; i++) {
        await engine.insert.shape('rect')
        engine.arrange.nudge(7, 3)
        engine.sealHistory()
        await engine.undo()
        await engine.redo()
        engine.arrange.delete()
        engine.sealHistory()
        const added = engine.pages.add(1)
        await frames()
        if (added) engine.pages.remove(added)
        engine.openDialog('shortcuts')
        await frames()
        engine.closeDialog()
        engine.patchUi({ panelId: i % 2 ? 'layers' : null })
        await frames()
      }
      engine.patchUi({ panelId: null })
    }, count)
  const live = (): Promise<number> => page.evaluate(() => (window as unknown as { __live: Set<string> }).__live.size)

  await cycle(15)
  await waitForQuiet(page, 1500)
  const warm = await metrics(cdp)
  const warmUrls = await live()
  await cycle(60)
  await waitForQuiet(page, 1500)
  const after = await metrics(cdp)
  const afterUrls = await live()
  const growth = { heapMb: Math.round((after.heapMb - warm.heapMb) * 10) / 10, nodes: after.nodes - warm.nodes, listeners: after.listeners - warm.listeners, blobUrls: afterUrls - warmUrls }
  record('60 edit cycles after 15 warm-up cycles', { warm, after, growth })
  expect(growth.nodes).toBeLessThan(600)
  expect(growth.listeners).toBeLessThan(600)
  expect(growth.blobUrls).toBeLessThan(40)
  expect(growth.heapMb).toBeLessThan(30)
})

test('opening a tool does not wait for anything on a design that is already open', async ({ page }) => {
  await openStress(page, 1, 200)
  await waitForQuiet(page)
  const t0 = Date.now()
  await openTool(page, 'layers')
  await expect(page.getByTestId('sidebar-layers')).toBeVisible()
  record('open the Layers sidebar on 200 objects', { ms: Date.now() - t0 })
})
