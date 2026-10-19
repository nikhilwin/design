/**
 * [engine] Engine performance budgets; independent of any chrome.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { openEditor, toClient } from './helpers'

test.describe('[engine] performance smoke', () => {
  test('a 30-page document opens in under 4 seconds and only mounts the visible pages', async ({ page }) => {
    const started = Date.now()
    await openEditor(page, 'doc=stress&pages=30&objects=60')
    await expect(page.locator('[data-artboard]')).toHaveCount(30)
    // The first page has painted its objects (Fabric has rendered, not just mounted).
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('[data-artboard] .lower-canvas').length), { timeout: 4000 })
      .toBeGreaterThan(0)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(4000)
    // Virtualisation: far fewer live canvases than pages.
    const live = await page.evaluate(() => document.querySelectorAll('[data-artboard] .lower-canvas').length)
    expect(live).toBeLessThanOrEqual(4)
  })

  test('dragging an object on a page with 200 objects keeps above 30 frames per second', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openEditor(page, 'doc=stress&pages=1&objects=200')
    const doc = await page.evaluate(() => window.__doory!.getDocument())
    const target = doc.pages[0].objects.find((o) => o.type === 'rect')
    if (!target) throw new Error('stress document has no rectangle')
    const cx = (target.left as number) + (target.width as number) / 2
    const cy = (target.top as number) + (target.height as number) / 2
    const start = await toClient(page, cx, cy)

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
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    const t0 = Date.now()
    for (let i = 1; i <= 90; i++) {
      await page.mouse.move(start.x + Math.sin(i / 8) * 120, start.y + i * 2)
      await page.waitForTimeout(8)
    }
    const dragMs = Date.now() - t0
    await page.mouse.up()
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __run: boolean }
      w.__run = false
      return w.__frames
    })
    const fps = ((frames.length - 1) / dragMs) * 1000
    console.log(`drag fps over ${dragMs}ms: ${fps.toFixed(1)}`)
    expect(fps).toBeGreaterThan(30)
    // The drag really moved the object.
    const after = (await page.evaluate(() => window.__doory!.getDocument())).pages[0].objects.find((o) => o.id === target.id)
    expect(after?.top).not.toBe(target.top)
  })
})
