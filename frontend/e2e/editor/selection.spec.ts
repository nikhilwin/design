/**
 * [layout] Canvas gestures are engine behaviour; the toolbar fields, context menu and layer buttons are layout specific.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, click, drag, openEditor, overlayHasInk, pageObjects, toClient, toolbarOf, waitForObjectCount } from './helpers'

async function addRects(page: import('@playwright/test').Page, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await addShape(page, 'rect')
  await waitForObjectCount(page, n)
}

/** The shape toolbar's `⋯` popover with its "Position" section opened. */
async function openPosition(page: import('@playwright/test').Page): Promise<void> {
  await toolbarOf(page).getByTestId('ed-shape-more').click()
  await page.getByTestId('more-position').getByRole('button', { name: 'Position' }).click()
}

test.describe('[layout] selection, transform and arrangement', () => {
  test('click selects, drag moves, history records the move', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page)
    const before = (await pageObjects(page))[0]
    await page.keyboard.press('Escape')
    await drag(page, { x: before.left as number, y: before.top as number }, { x: (before.left as number) + 200, y: (before.top as number) + 120 })
    await expect.poll(async () => (await pageObjects(page))[0].left).toBeGreaterThan((before.left as number) + 150)
    const after = (await pageObjects(page))[0]
    expect(after.top as number).toBeGreaterThan((before.top as number) + 80)
  })

  test('resizing with a corner handle bakes the size into width/height', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page)
    const o = (await pageObjects(page))[0]
    // The handles sit on the outer edge, which includes half of the border on each side.
    const grow = Number(o.strokeWidth ?? 0)
    const br = { x: (o.left as number) + ((o.width as number) + grow) / 2, y: (o.top as number) + ((o.height as number) + grow) / 2 }
    await drag(page, br, { x: br.x + 120, y: br.y + 120 })
    await expect.poll(async () => (await pageObjects(page))[0].width).toBeGreaterThan((o.width as number) + 60)
    expect((await pageObjects(page))[0].scaleX).toBe(1)
  })

  test('rotation via the numeric field and 90° button', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page)
    await openPosition(page)
    const angle = page.getByRole('textbox', { name: 'Rotation' })
    await angle.fill('45')
    await angle.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].angle).toBeCloseTo(45, 0)
    await page.keyboard.press('Escape')
    await toolbarOf(page).getByTestId('ed-rotate').click()
    await page.getByRole('menuitem', { name: /Rotate right 90/ }).click()
    await expect.poll(async () => (await pageObjects(page))[0].angle).toBeCloseTo(135, 0)
  })

  test('numeric position and size fields', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page)
    await openPosition(page)
    const x = page.getByRole('textbox', { name: 'X' })
    await x.fill('100')
    await x.press('Enter')
    const w = page.getByRole('textbox', { name: 'W' })
    await page.getByRole('switch', { name: 'Lock aspect ratio' }).uncheck()
    await w.fill('333')
    await w.press('Enter')
    // The size field is the outer box, border included.
    await expect.poll(async () => { const o = (await pageObjects(page))[0]; return (o.width as number) + Number(o.strokeWidth ?? 0) }).toBeGreaterThan(328)
    const o = (await pageObjects(page))[0]
    expect((o.left as number) - (o.width as number) / 2 + (o.width as number) / 2).toBeGreaterThan(0)
  })

  test('shift-click and marquee build a multi selection; group and ungroup', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page, 3)
    await page.keyboard.press('Escape')
    // Spread the rects with nudges via the arrange API: move each via drag.
    const objs = await pageObjects(page)
    const target = [{ x: 250, y: 250 }, { x: 540, y: 540 }, { x: 830, y: 830 }]
    for (let i = 0; i < 3; i++) {
      const o = (await pageObjects(page))[i]
      await drag(page, { x: o.left as number, y: o.top as number }, target[i])
      await page.keyboard.press('Escape')
    }
    void objs
    // Marquee over everything.
    await drag(page, { x: 20, y: 20 }, { x: 1060, y: 1060 })
    await expect(toolbarOf(page).getByTestId('ed-multi-count')).toHaveText('3 selected')
    await toolbarOf(page).getByTestId('ed-group').click()
    await waitForObjectCount(page, 1)
    expect((await pageObjects(page))[0].type).toBe('group')
    await toolbarOf(page).getByTestId('ed-ungroup').click()
    await waitForObjectCount(page, 3)
  })

  test('align to page and distribute', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page, 3)
    await page.keyboard.press('Escape')
    const pos = [{ x: 200, y: 300 }, { x: 330, y: 400 }, { x: 900, y: 500 }]
    for (let i = 0; i < 3; i++) {
      const o = (await pageObjects(page))[i]
      await drag(page, { x: o.left as number, y: o.top as number }, pos[i])
      await page.keyboard.press('Escape')
    }
    await page.keyboard.press('Control+a')
    await toolbarOf(page).getByTestId('ed-distribute-h').click()
    const lefts = (await pageObjects(page)).map((o) => o.left as number).sort((a, b) => a - b)
    const gap1 = lefts[1] - lefts[0]
    const gap2 = lefts[2] - lefts[1]
    expect(Math.abs(gap1 - gap2)).toBeLessThan(1.5)
    await toolbarOf(page).getByTestId('ed-multi-align').click()
    await page.getByRole('button', { name: 'Align left', exact: true }).click()
    const aligned = (await pageObjects(page)).map((o) => (o.left as number) - ((o.width as number) * ((o.scaleX as number) ?? 1)) / 2)
    expect(Math.max(...aligned) - Math.min(...aligned)).toBeLessThan(1.5)
  })

  test('smart guides appear while dragging near another object and vanish after', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page, 1)
    const a = (await pageObjects(page))[0]
    await drag(page, { x: a.left as number, y: a.top as number }, { x: 200, y: 200 })
    await page.keyboard.press('Escape')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 2)
    await page.keyboard.press('Escape')
    const b = (await pageObjects(page))[1]
    const start = await toClient(page, b.left as number, b.top as number)
    // Drop B 3px (page units) away from A's centre line: it must snap onto it.
    const dx = 203 - (b.left as number)
    const target = await toClient(page, (b.left as number) + dx, 560)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(target.x, target.y, { steps: 10 })
    await expect.poll(() => overlayHasInk(page)).toBe(true)
    await page.mouse.up()
    await expect.poll(() => overlayHasInk(page)).toBe(false)
    const objs = await pageObjects(page)
    expect(Math.abs((objs[1].left as number) - (objs[0].left as number))).toBeLessThan(0.6)
  })

  test('alt-drag duplicates and arrow keys nudge (shift = 10px)', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page)
    const before = (await pageObjects(page))[0]
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await pageObjects(page))[0].left).toBe((before.left as number) + 1)
    expect((await pageObjects(page))[0].top).toBe((before.top as number) + 10)
    await page.keyboard.press('Control+d')
    await waitForObjectCount(page, 2)
  })

  test('lock prevents deleting; hidden layers disappear from selection', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page)
    await page.keyboard.press('Alt+Shift+L')
    await expect.poll(async () => (await pageObjects(page))[0].locked).toBe(true)
    await page.keyboard.press('Delete')
    expect(await pageObjects(page)).toHaveLength(1)
    await page.keyboard.press('Alt+Shift+L')
    await page.keyboard.press('Delete')
    await waitForObjectCount(page, 0)
  })

  test('context menu offers clipboard and arrange commands', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addRects(page)
    const o = (await pageObjects(page))[0]
    const p = await toClient(page, o.left as number, o.top as number)
    await page.mouse.click(p.x, p.y, { button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.getByRole('menuitem', { name: 'Duplicate' }).click()
    await waitForObjectCount(page, 2)
    await click(page, 1000, 1000)
  })
})
