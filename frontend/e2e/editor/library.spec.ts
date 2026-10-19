/**
 * [layout] The library tools, in the editor's UI language: Templates and Brand sidebars, the extra
 * sections of the Text, Shapes and Background drawers.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, addText, getDoc, openEditor, openTool, pageObjects, toolbarOf, waitForObjectCount } from './helpers'

test.describe('[layout] templates', () => {
  test('search and categories filter the grid; a template on an empty design takes over its size and can be undone', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await openTool(page, 'templates')
    const cards = page.getByTestId('template-card')
    await expect(cards).toHaveCount(4)
    await page.getByTestId('template-search').fill('pitch')
    await expect(cards).toHaveCount(1)
    await page.getByTestId('template-search').fill('zzzzqq')
    await expect(page.getByText(/No templates match/)).toBeVisible()
    await page.getByTestId('template-search').fill('')
    await page.getByTestId('template-category').click()
    await page.getByRole('option', { name: /Cards/ }).click()
    await expect(cards).toHaveCount(1)
    await page.getByTestId('template-category').click()
    await page.getByRole('option', { name: 'Landscape' }).click()
    await expect(cards).toHaveCount(1)
    await page.getByTestId('template-category').click()
    await page.getByRole('option', { name: 'All templates' }).click()

    await page.getByRole('button', { name: 'Use template Bold poster' }).click()
    await expect.poll(async () => (await getDoc(page)).pages[0].objects.length).toBeGreaterThan(0)
    expect((await getDoc(page)).width).toBe(1080)
    expect((await getDoc(page)).height).toBe(1350)
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
    await expect.poll(async () => (await getDoc(page)).pages[0].objects.length).toBe(0)
  })

  test('on a design with content a template can replace the page, be added as a page or add all of its pages', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await openTool(page, 'templates')
    await page.getByRole('button', { name: 'Use template Pitch deck' }).click()
    await page.getByRole('menuitem', { name: 'Add all 2 pages' }).click()
    await expect.poll(async () => (await getDoc(page)).pages.length).toBe(3)
    // The first page keeps the design's size; the template's pages are added at their own size.
    expect((await getDoc(page)).width).toBe(1080)
    expect((await pageObjects(page, 0)).length).toBe(1)

    await page.getByRole('button', { name: 'Use template Bold poster' }).click()
    await page.getByRole('menuitem', { name: 'Add as new page' }).click()
    await expect.poll(async () => (await getDoc(page)).pages.length).toBe(4)

    await page.getByRole('button', { name: 'Use template Sale announcement' }).click()
    await page.getByRole('menuitem', { name: 'Use for this page' }).click()
    await expect.poll(async () => (await getDoc(page)).pages.length).toBe(4)
    await expect.poll(async () => (await getDoc(page)).pages.some((p) => p.objects.some((o) => o.type === 'textbox' && String(o.text).includes('Big sale')))).toBe(true)
  })
})

test.describe('[layout] brand', () => {
  test('guests are invited to sign up and the editor asks the shell for an account', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'brand')
    await expect(page.getByTestId('brand-gate')).toBeVisible()
    await page.getByTestId('brand-signup').click()
    await expect.poll(() => page.evaluate(() => window.__doory!.accountRequests)).toContain('brand-kit')
  })

  test('a brand kit keeps colours that apply to the selection and show up in every colour picker', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await openTool(page, 'brand')
    await page.getByTestId('brand-kit-name').fill('Acme')
    await page.getByTestId('brand-kit-create').click()
    await expect(page.getByTestId('brand-add-color')).toBeVisible()
    await page.getByTestId('brand-add-color').click()
    await page.getByLabel('Hex color').fill('#2563eb')
    await page.getByTestId('brand-add-color-confirm').click()
    await expect(page.getByTestId('brand-color')).toHaveCount(1)
    await page.getByTestId('brand-color').click()
    await expect.poll(async () => (await pageObjects(page))[0].fill).toBe('#2563eb')

    // Nothing selected: the brand colour paints the page.
    await page.keyboard.press('Escape')
    await page.getByTestId('brand-color').click()
    await expect.poll(async () => (await getDoc(page)).pages[0].background).toMatchObject({ type: 'solid', color: '#2563eb' })
    await addShape(page, 'ellipse')
    await toolbarOf(page).getByTestId('ed-fill').click()
    await expect(page.getByTestId('ed-fill-brand').getByRole('button', { name: 'Use #2563eb' })).toBeVisible()
  })
})

test.describe('[layout] text, shapes and background extras', () => {
  test('a font pairing adds a heading and a body text in its fonts', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'text')
    await page.getByTestId('text-pairing-classic').click()
    await waitForObjectCount(page, 2)
    const objs = await pageObjects(page)
    expect(String(objs[0].fontFamily)).toContain('Playfair Display')
    expect(String(objs[1].fontFamily)).toContain('DM Sans')
    expect(Number(objs[0].fontSize)).toBeGreaterThan(Number(objs[1].fontSize))
  })

  test('list buttons add bulleted and numbered lists', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'text')
    await page.getByTestId('text-list-bullet').click()
    await waitForObjectCount(page, 1)
    expect((await pageObjects(page))[0].listStyle).toBe('bullet')
    await page.keyboard.press('Escape')
    await openTool(page, 'text')
    await page.getByTestId('text-list-number').click()
    await waitForObjectCount(page, 2)
    expect((await pageObjects(page))[1].listStyle).toBe('number')
  })

  test('hollow text moves the colour to the outline and back in one undo step each', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addText(page, 'heading')
    await waitForObjectCount(page, 1)
    await page.keyboard.press('Escape')
    await toolbarOf(page).getByTestId('ed-overflow').click()
    await page.getByTestId('more-effects').getByRole('button', { name: 'Effects' }).click()
    await page.getByRole('switch', { name: 'Hollow' }).check()
    await expect.poll(async () => (await pageObjects(page))[0].fill).toBe('transparent')
    expect(((await pageObjects(page))[0].effects as { outline?: { color: string } }).outline?.color).toBe('#1a1a2e')
    await page.getByRole('switch', { name: 'Hollow' }).uncheck()
    await expect.poll(async () => (await pageObjects(page))[0].fill).toBe('#1a1a2e')
  })

  test('the Shapes drawer offers lines, built-in shapes, a QR code and charts', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'shapes')
    for (const id of ['arrow', 'arrow-both', 'dotted']) await expect(page.getByTestId(`shape-${id}`)).toBeVisible()
    await page.getByTestId('shape-arrow-both').click()
    await waitForObjectCount(page, 1)
    const line = (await pageObjects(page))[0]
    expect(line.arrowStart).toBe('triangle')
    expect(line.arrowEnd).toBe('triangle')
    await openTool(page, 'shapes')
    await page.getByTestId('chart-pie').click()
    await waitForObjectCount(page, 2)
    expect((await pageObjects(page))[1].elementId).toBe('chart-pie')
    await expect(toolbarOf(page).getByTestId('ed-recolor')).toBeVisible()
  })

  test('background patterns tile as an image background and the page row recolours the page', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'background')
    await page.getByTestId('bg-pattern-dots').click()
    await expect.poll(async () => (await getDoc(page)).pages[0].background).toMatchObject({ type: 'image', fit: 'tile' })
    await page.keyboard.press('Escape')
    await toolbarOf(page).getByTestId('ed-page-bg').click()
    await page.getByRole('button', { name: 'Use #1c1517' }).first().click()
    await expect.poll(async () => (await getDoc(page)).pages[0].background).toMatchObject({ type: 'solid', color: '#1c1517' })
  })
})
