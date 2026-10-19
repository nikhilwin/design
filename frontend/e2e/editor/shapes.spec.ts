/**
 * [layout] Shapes drawer, Sticker sidebar and the shape toolbar.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, click, getDoc, openEditor, openTool, pageObjects, pngBuffer, toolbarOf, waitForObjectCount } from './helpers'

test.describe('[layout] shapes and elements', () => {
  test('adds every basic shape from the Shapes drawer with no server catalog', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    for (const id of ['rect', 'rounded', 'ellipse', 'triangle', 'polygon', 'star', 'line', 'arrow', 'path-heart', 'path-speech'] as const) await addShape(page, id)
    await waitForObjectCount(page, 10)
    const types = (await pageObjects(page)).map((o) => o.type)
    expect(types).toEqual(['rect', 'rect', 'ellipse', 'triangle', 'polygon', 'polygon', 'doryline', 'doryline', 'path', 'path'])
    const arrow = (await pageObjects(page))[7]
    expect(arrow.arrowEnd).toBe('triangle')
  })

  test('fill colour via the colour picker hex field, and stroke', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await toolbarOf(page).getByTestId('ed-fill').click()
    await page.getByTestId('ed-fill-custom').click()
    const hex = page.getByLabel('Hex color')
    await hex.fill('#1d4ed8')
    await expect.poll(async () => String((await pageObjects(page))[0].fill)).toMatch(/^#1d4ed8(40)?$/)
    await page.keyboard.press('Escape')
    await toolbarOf(page).getByTestId('ed-shape-more').click()
    await page.getByTestId('ed-stroke-width').fill('8')
    await expect.poll(async () => (await pageObjects(page))[0].strokeWidth).toBe(8)
  })

  test('gradient fill editor adds a gradient with stops', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'ellipse')
    await toolbarOf(page).getByTestId('ed-fill').click()
    await page.getByTestId('ed-fill-custom').click()
    await page.getByRole('radio', { name: 'Linear' }).check()
    await expect.poll(async () => ((await pageObjects(page))[0].fill as { type?: string } | string)).toMatchObject({ type: 'linear' })
    const fill = (await pageObjects(page))[0].fill as { colorStops: unknown[] }
    expect(fill.colorStops.length).toBeGreaterThanOrEqual(2)
  })

  test('rectangle corner radius and star points are adjustable', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'rect')
    await toolbarOf(page).getByTestId('ed-shape-more').click()
    await page.getByTestId('ed-corner-radius').fill('40')
    await expect.poll(async () => (await pageObjects(page))[0].rx).toBe(40)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await addShape(page, 'star')
    await toolbarOf(page).getByTestId('ed-shape-more').click()
    await page.getByTestId('more-star').getByRole('button', { name: 'Shape' }).click()
    await page.getByTestId('ed-star-points').fill('8')
    await expect.poll(async () => (await pageObjects(page)).at(-1)?.starPoints).toBe(8)
  })

  test('catalog elements load from the adapter, insert as groups and can be recoloured', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'elements')
    const sun = page.getByRole('button', { name: 'Add Sun', exact: true })
    await expect(sun).toBeVisible()
    await sun.click()
    await waitForObjectCount(page, 1)
    const o = (await pageObjects(page))[0]
    expect(o.elementId).toBe('el-0')
    await toolbarOf(page).getByRole('button', { name: /^Recolor #/ }).first().click()
    await page.getByLabel('Hex color').fill('#2563eb')
    await expect.poll(async () => JSON.stringify((await pageObjects(page))[0].colorMap)).toContain('#2563eb')
  })

  test('element search filters the catalog and shows an empty state', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'elements')
    await page.getByPlaceholder('Search stickers').fill('coffee')
    await expect(page.getByRole('button', { name: 'Add Coffee', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Sun', exact: true })).toHaveCount(0)
    await page.getByPlaceholder('Search stickers').fill('zzzzqq')
    await expect(page.getByText(/No stickers match/)).toBeVisible()
  })

  test('diamond, divider and frame come from the engine with their default sizes and styles', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    for (const id of ['diamond', 'divider', 'frame'] as const) await addShape(page, id)
    await waitForObjectCount(page, 3)
    const [diamond, divider, frame] = await pageObjects(page)
    expect(diamond.type).toBe('polygon')
    expect((diamond.points as unknown[]).length).toBe(4)
    expect(divider.type).toBe('doryline')
    expect(Array.isArray(divider.strokeDashArray) ? (divider.strokeDashArray as number[]).length : 0).toBe(2)
    expect(frame.type).toBe('rect')
    expect(frame.fill).toBe('transparent')
    expect(Number(frame.height)).toBeGreaterThan(Number(frame.width))
  })

  test('a picture in a placeholder offers Reset to placeholder instead of crop and frame', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'placeholder')
    await waitForObjectCount(page, 1)
    const doc = await getDoc(page)
    const chooser = page.waitForEvent('filechooser')
    await click(page, doc.width / 2, doc.height / 2)
    await (await chooser).setFiles({ name: 'fill.png', mimeType: 'image/png', buffer: pngBuffer(240, 160) })
    await expect.poll(async () => (await pageObjects(page))[0]?.type).toBe('image')
    const bar = toolbarOf(page)
    await expect(bar.getByTestId('ed-crop')).toHaveCount(0)
    await expect(bar.getByTestId('ed-frame')).toHaveCount(0)
    await bar.getByRole('button', { name: 'Reset to placeholder' }).click()
    await expect.poll(async () => (await pageObjects(page))[0]?.isPlaceholder).toBe(true)
    await expect(bar.getByTestId('ed-crop')).toHaveCount(0)
  })

  test('QR code and image placeholder objects', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'qr')
    await waitForObjectCount(page, 1)
    const qr = (await pageObjects(page))[0]
    expect((qr.qr as { text: string }).text).toContain('doory')
    expect(qr.src).toBeUndefined()
    await addShape(page, 'placeholder')
    await waitForObjectCount(page, 2)
    expect((await pageObjects(page))[1].isPlaceholder).toBe(true)
  })
})
