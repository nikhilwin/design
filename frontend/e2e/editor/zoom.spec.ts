/**
 * [layout] Zoom pill, rulers and grid toggles of the current layout; wheel zoom, pan and guides are engine behaviour.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, click, getDoc, moreMenu, openEditor, overlayHasInk, pageObjects, toClient, toolbarOf, waitForObjectCount } from './helpers'

async function zoomPercent(page: import('@playwright/test').Page): Promise<number> {
  const label = await page.getByRole('button', { name: /^Zoom level: / }).textContent()
  return Number((label ?? '').replace('%', ''))
}

test.describe('[layout] zoom and pan', () => {
  test('buttons, menu presets and fit modes change the zoom within 10-800%', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    const fit = await zoomPercent(page)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    expect(await zoomPercent(page)).toBeGreaterThan(fit)
    await page.getByRole('button', { name: /^Zoom level: / }).click()
    await page.getByRole('menuitem', { name: '800%' }).click()
    expect(await zoomPercent(page)).toBe(800)
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom in' }).click()
    expect(await zoomPercent(page)).toBe(800)
    await page.getByRole('button', { name: /^Zoom level: / }).click()
    await page.getByRole('menuitem', { name: '25%', exact: true }).click()
    for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Zoom out' }).click()
    expect(await zoomPercent(page)).toBe(10)
    await page.getByRole('button', { name: /^Zoom level: / }).click()
    await page.getByRole('menuitemcheckbox', { name: /^Fit page/ }).click()
    expect(await zoomPercent(page)).toBe(fit)
    await page.keyboard.press('Shift+0')
    expect(await zoomPercent(page)).toBe(100)
  })

  test('ctrl+wheel zooms around the cursor and the artboard follows the pointer', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    const box = await page.locator('[data-artboard]').first().boundingBox()
    if (!box) throw new Error('no artboard')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const before = await zoomPercent(page)
    await page.mouse.move(cx, cy)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -300)
    await page.keyboard.up('Control')
    await expect.poll(() => zoomPercent(page)).toBeGreaterThan(before)
    // The point under the cursor stays under the cursor (within a few pixels).
    await expect
      .poll(async () => {
        const after = await page.locator('[data-artboard]').first().boundingBox()
        return after ? Math.abs((cx - after.x) / after.width - 0.5) : 1
      })
      .toBeLessThan(0.02)
  })

  test('content stays interactive when zoomed: a shape added at 200% can be selected by clicking it', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByRole('button', { name: /^Zoom level: / }).click()
    await page.getByRole('menuitem', { name: '200%' }).click()
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    const o = (await pageObjects(page))[0]
    await page.keyboard.press('Escape')
    await click(page, o.left as number, o.top as number)
    await expect(toolbarOf(page).getByTestId('ed-fill')).toBeVisible()
  })

  test('space-drag pans the workspace', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByRole('button', { name: /^Zoom level: / }).click()
    await page.getByRole('menuitem', { name: '300%' }).click()
    const scroller = page.locator('[data-workspace-bg]').first()
    const before = await scroller.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }))
    const start = await toClient(page, 540, 540)
    await page.keyboard.down('Space')
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x - 160, start.y - 120, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    const after = await scroller.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }))
    expect(after.x).toBeGreaterThan(before.x + 100)
    expect(after.y).toBeGreaterThan(before.y + 80)
    expect((await getDoc(page)).pages[0].objects).toHaveLength(0)
  })

  test('rulers and grid toggle from the More menu and the overlay draws the grid', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await expect(page.locator('canvas[data-ruler="horizontal"]')).toHaveCount(0)
    await moreMenu(page, 'Show rulers')
    await expect(page.locator('canvas[data-ruler="horizontal"]')).toBeVisible()
    await moreMenu(page, 'Show grid')
    await expect.poll(() => overlayHasInk(page)).toBe(true)
    await moreMenu(page, 'Show grid')
    await expect.poll(() => overlayHasInk(page)).toBe(false)
  })

  test('the zoom menu also toggles rulers and grid', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByRole('button', { name: /^Zoom level: / }).click()
    await page.getByRole('menuitemcheckbox', { name: /Rulers/ }).click()
    await expect(page.locator('canvas[data-ruler="horizontal"]')).toBeVisible()
  })

  test('dragging out of a ruler adds a guide and the More menu clears it', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await moreMenu(page, 'Show rulers')
    const ruler = await page.locator('canvas[data-ruler="horizontal"]').boundingBox()
    if (!ruler) throw new Error('no ruler')
    const target = await toClient(page, 300, 300)
    await page.mouse.move(ruler.x + 200, ruler.y + ruler.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x, target.y, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => ((await getDoc(page)).pages[0] as { guides?: unknown[] }).guides?.length ?? 0).toBe(1)
    await moreMenu(page, 'Clear 1 ruler guide')
    await expect.poll(async () => ((await getDoc(page)).pages[0] as { guides?: unknown[] }).guides?.length ?? 0).toBe(0)
  })
})
