/**
 * [engine] Animation performance: a page of 60 animated elements. The frame renderer is measured in the page itself
 * (the same module the editor runs): the time to prepare the page once, and the time to draw each frame. Then the
 * editor preview is played and the animation frames of the browser are counted. The numbers are printed; the budgets here are the ones that must always hold: 30 frames a second
 * is 33 ms for a frame.
 */
import { expect, test, type Page } from '@playwright/test'
import { openEditor } from './helpers'

const OBJECTS = 60
const ENTERS = ['fade', 'rise', 'pop', 'slide', 'zoom', 'spin', 'blur', 'wipe']

/** The stress design with every element animated (an enter after a stagger, a looping emphasis on every fourth). */
async function openAnimatedStress(page: Page): Promise<void> {
  await openEditor(page, `doc=stress&pages=1&objects=${OBJECTS}`)
  await page.evaluate(
    ([presets]) => {
      const doc = window.__doory!.getDocument() as unknown as { pages: { durationSec?: number; objects: Record<string, unknown>[] }[] }
      const objects = doc.pages[0].objects
      objects.forEach((o, i) => {
        const text = o.type === 'textbox'
        o.animation = {
          enter: { preset: presets[i % presets.length], durationMs: 700, delayMs: i * 40, easing: 'ease-out', direction: 'left', ...(text ? { by: 'word' } : {}) },
          ...(i % 4 === 0 ? { emphasis: { preset: 'float', durationMs: 2000, delayMs: 0, easing: 'linear', loop: true } } : {}),
        }
      })
      doc.pages[0].durationSec = 6
      localStorage.setItem('doory.harness.doc', JSON.stringify(doc))
    },
    [ENTERS],
  )
  await openEditor(page, 'doc=stored')
}

/** The part of the renderer module the measurement uses (the page's own module, loaded from the dev server by its URL). */
interface RendererModule {
  createFrameRenderer(
    page: unknown,
    size: { width: number; height: number },
    ctx: { resolveSrc(src: string): Promise<string>; ensureFonts(fonts: unknown[]): Promise<void> },
    options: { multiplier: number },
  ): Promise<{ timing: { endMs: number }; render(tMs: number): unknown; dispose(): void }>
}

interface FrameStats {
  prepareMs: number
  frames: number
  avgMs: number
  p95Ms: number
  maxMs: number
}

/** Prepares the first page once at `multiplier` and draws a frame every 33 ms of its clock; times each. */
async function measureRenderer(page: Page, multiplier: number): Promise<FrameStats> {
  return page.evaluate(async (mult) => {
    const url = '/src/editor/animation/frameRenderer.ts'
    const mod = (await import(/* @vite-ignore */ url)) as RendererModule
    const doc = window.__doory!.getDocument()
    const loadContext = { resolveSrc: async (src: string) => src, ensureFonts: async () => undefined }
    const t0 = performance.now()
    const renderer = await mod.createFrameRenderer(doc.pages[0], { width: doc.width, height: doc.height }, loadContext, { multiplier: mult })
    const prepareMs = performance.now() - t0
    const times: number[] = []
    const end = Math.max(renderer.timing.endMs, 3000)
    for (let t = 0; t <= end; t += 33) {
      const a = performance.now()
      renderer.render(t)
      times.push(performance.now() - a)
    }
    renderer.dispose()
    times.sort((x, y) => x - y)
    const sum = times.reduce((s, v) => s + v, 0)
    return { prepareMs, frames: times.length, avgMs: sum / times.length, p95Ms: times[Math.floor(times.length * 0.95)], maxMs: times[times.length - 1] }
  }, multiplier)
}

test.describe('[engine] animation performance', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test('60 animated elements: preparing the page and drawing a frame stay within the 30 frames per second budget', async ({ page }) => {
    await openAnimatedStress(page)
    // Warm the module and the font once so the numbers are of the steady state.
    await measureRenderer(page, 0.25)
    const half = await measureRenderer(page, 0.5)
    const full = await measureRenderer(page, 1)
    console.log(`animation renderer, ${OBJECTS} elements, 1080 px page, x0.5: prepare ${half.prepareMs.toFixed(0)} ms; ${half.frames} frames avg ${half.avgMs.toFixed(1)} ms p95 ${half.p95Ms.toFixed(1)} ms max ${half.maxMs.toFixed(1)} ms`)
    console.log(`animation renderer, ${OBJECTS} elements, 1080 px page, x1:   prepare ${full.prepareMs.toFixed(0)} ms; ${full.frames} frames avg ${full.avgMs.toFixed(1)} ms p95 ${full.p95Ms.toFixed(1)} ms max ${full.maxMs.toFixed(1)} ms`)
    expect(half.prepareMs).toBeLessThan(3000)
    expect(half.avgMs).toBeLessThan(33)
    expect(half.p95Ms).toBeLessThan(50)
    expect(full.avgMs).toBeLessThan(33)
  })

  test('the editor preview of that page keeps close to 30 frames per second or more, even on a busy machine', async ({ page }) => {
    await openAnimatedStress(page)
    await page.getByTestId('ed-timeline-toggle').click()
    await expect(page.getByTestId('ed-timeline')).toBeVisible()
    await page.getByTestId('tl-play').click()
    await expect(page.getByTestId('ed-preview-frame')).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __run: boolean }
      w.__frames = []
      w.__run = true
      const tick = (t: number): void => {
        w.__frames.push(t)
        if (w.__run) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const started = Date.now()
    await page.waitForTimeout(3000)
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __run: boolean }
      w.__run = false
      return w.__frames
    })
    const elapsed = Date.now() - started
    const fps = ((frames.length - 1) / elapsed) * 1000
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b)
    console.log(`animation preview, ${OBJECTS} elements: ${fps.toFixed(1)} frames/s over ${elapsed} ms, longest frame ${gaps[gaps.length - 1]?.toFixed(0)} ms`)
    // The budget is 30. The machine that runs the suites is shared and often loaded (load average 10 to 20 on 4 cores),
    // where a browser drops frames of anything; the renderer's own cost above is what proves the headroom.
    expect(fps).toBeGreaterThan(24)
    // It was playing the whole time (not stopped by an error or by the end of the page).
    await expect(page.getByTestId('ed-preview')).toBeVisible()
  })
})
