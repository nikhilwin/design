/**
 * [layout] Page chrome (headers, pill, strip), the Background drawer and the canvas-size popover.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, getDoc, openEditor, openTool } from './helpers'

test.describe('[layout] pages', () => {
  test('add, duplicate, move and delete pages from the page chrome', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await expect(page.locator('[data-artboard]')).toHaveCount(1)
    // A single page has no header chrome; the pill adds the second one.
    const headers = page.locator('section[data-page-id] header')
    await expect(headers.first()).toBeHidden()
    await page.getByTestId('ed-pages-add').click()
    await expect(page.locator('[data-artboard]')).toHaveCount(2)
    await page.getByRole('button', { name: 'Add page here' }).first().click()
    await expect(page.locator('[data-artboard]')).toHaveCount(3)
    await headers.first().getByRole('button', { name: 'Duplicate page' }).click()
    await expect(page.locator('[data-artboard]')).toHaveCount(4)
    await headers.first().getByRole('button', { name: 'Delete page' }).click()
    await expect(page.locator('[data-artboard]')).toHaveCount(3)
    const ids = (await getDoc(page)).pages.map((p) => p.id)
    await headers.first().getByRole('button', { name: 'Move page down' }).click()
    await expect.poll(async () => (await getDoc(page)).pages.map((p) => p.id)).toEqual([ids[1], ids[0], ids[2]])
    await headers.first().getByRole('button', { name: 'Delete page' }).click()
    await expect(page.locator('[data-artboard]')).toHaveCount(2)
    await expect(headers.first().getByRole('button', { name: 'Delete page' })).toBeEnabled()
    // The row under the top bar offers the same page actions for the active page.
    await page.getByTestId('ed-page-delete').click()
    await expect(page.locator('[data-artboard]')).toHaveCount(1)
  })

  test('page names are editable inline', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByTestId('ed-pages-add').click()
    await expect(page.locator('[data-artboard]')).toHaveCount(2)
    await page.getByRole('button', { name: /^1 Page 1/ }).click()
    const input = page.getByRole('textbox', { name: 'Page name' })
    await input.fill('Intro')
    await input.press('Enter')
    await expect.poll(async () => (await getDoc(page)).pages[0].name).toBe('Intro')
  })

  test('the page strip supports drag reordering and navigation', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Add page', exact: true }).last().click()
    await expect(page.locator('[data-artboard]')).toHaveCount(3)
    const ids = (await getDoc(page)).pages.map((p) => p.id)
    await page.getByTestId('ed-pages-toggle').click()
    const strip = page.getByRole('navigation', { name: 'Page strip' })
    await expect(strip).toBeVisible()
    const thumbs = strip.locator('[draggable="true"]')
    await expect(thumbs).toHaveCount(3)
    const last = await thumbs.nth(2).boundingBox()
    if (!last) throw new Error('no thumbnail')
    await thumbs.nth(0).dragTo(thumbs.nth(2), { targetPosition: { x: last.width - 3, y: last.height / 2 } })
    await expect.poll(async () => (await getDoc(page)).pages.map((p) => p.id)).toEqual([ids[1], ids[2], ids[0]])
    await strip.getByRole('button', { name: /Page 3/ }).click()
    await expect(page.getByTestId('ed-pages-text')).toHaveText('Page 3 of 3')
    await page.getByTestId('ed-pages-toggle').click()
    await expect(strip).toHaveCount(0)
  })

  test('page background colour, gradient and apply to all pages', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByRole('button', { name: 'Add page', exact: true }).last().click()
    await openTool(page, 'background')
    await page.getByRole('button', { name: 'Set background #e11d48' }).click()
    await expect.poll(async () => (await getDoc(page)).pages[1].background).toMatchObject({ type: 'solid', color: '#e11d48' })
    await page.getByRole('button', { name: 'Sunset gradient' }).click()
    await expect.poll(async () => (await getDoc(page)).pages[1].background.type).toBe('gradient')
    await page.getByRole('button', { name: 'Apply to all pages' }).click()
    await expect.poll(async () => (await getDoc(page)).pages[0].background.type).toBe('gradient')
  })

  test('resize design with magic resize repositions content', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'rect')
    await page.getByTestId('ed-canvas-size').click()
    await page.getByTestId('ed-preset-presentation').click()
    await expect.poll(async () => (await getDoc(page)).width).toBe(1920)
    expect((await getDoc(page)).height).toBe(1080)
    const o = (await getDoc(page)).pages[0].objects[0]
    // Objects are centre-origin: the rectangle stays in the middle of the new, wider page.
    expect(o.left as number).toBeCloseTo(960, 0)
    expect(o.top as number).toBeCloseTo(540, 0)
  })
})
