/**
 * [layout] Clicks the current Text panel and contextual toolbar.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addText, openEditor, openTool, pageObjects, toolbarOf, waitForObjectCount } from './helpers'

test.describe('[layout] text', () => {
  test('add a heading, type into it and change its style', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addText(page, 'heading')
    await waitForObjectCount(page, 1)
    // The new text is in edit mode with its content selected: typing replaces it.
    await page.keyboard.type('Hello Doory')
    await expect.poll(async () => (await pageObjects(page))[0].text).toBe('Hello Doory')
    await page.keyboard.press('Escape')
    // Toolbar morphed to text controls.
    await expect(toolbarOf(page).getByRole('button', { name: 'Bold' })).toBeVisible()
    await toolbarOf(page).getByRole('button', { name: 'Italic' }).click()
    await expect.poll(async () => (await pageObjects(page))[0].fontStyle).toBe('italic')
    await toolbarOf(page).getByRole('button', { name: 'Underline' }).click()
    await expect.poll(async () => (await pageObjects(page))[0].underline).toBe(true)
  })

  test('font size field, case toggle and alignment cycle', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addText(page, 'body')
    await waitForObjectCount(page, 1)
    await page.keyboard.press('Escape')
    const size = toolbarOf(page).getByRole('spinbutton', { name: 'Font size' })
    await size.fill('72')
    await size.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].fontSize).toBe(72)
    await toolbarOf(page).getByRole('button', { name: 'Letter case' }).click()
    await page.getByRole('menuitemradio', { name: 'UPPERCASE' }).click()
    await expect.poll(async () => (await pageObjects(page))[0].text).toMatch(/^[A-Z ]+$/)
    await toolbarOf(page).getByTestId('ed-text-align').click()
    await page.getByTestId('ed-align-right').click()
    await expect.poll(async () => (await pageObjects(page))[0].textAlign).toBe('right')
  })

  test('click-to-type with the text tool creates a text box at the click point', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.keyboard.press('t')
    const box = await page.locator('[data-artboard]').first().boundingBox()
    if (!box) throw new Error('no artboard')
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3)
    await page.keyboard.type('Typed here')
    await expect.poll(async () => (await pageObjects(page))[0]?.text).toBe('Typed here')
    await page.keyboard.press('Escape')
    const o = (await pageObjects(page))[0]
    expect(o.type).toBe('textbox')
    expect(o.left as number).toBeGreaterThan(100)
  })

  test('font picker lists fonts, filters by search and applies the choice', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addText(page, 'heading')
    await page.keyboard.press('Escape')
    await toolbarOf(page).getByTestId('ed-font').click()
    const search = page.getByPlaceholder('Search fonts')
    await search.fill('liberation')
    const option = page.getByRole('option', { name: 'Liberation Serif' })
    await expect(option).toBeVisible()
    await option.click()
    await expect.poll(async () => String((await pageObjects(page))[0].fontFamily)).toContain('Liberation Serif')
  })

  test('curved text and effects are stored on the object', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openTool(page, 'text')
    await page.getByTestId('text-arc-up').click()
    await expect.poll(async () => (await pageObjects(page))[0]?.curveAmount).toBeLessThan(0)
    expect((await pageObjects(page))[0].type).toBe('itext')
    await toolbarOf(page).getByTestId('ed-overflow').click()
    await page.getByTestId('more-effects').getByRole('button', { name: 'Effects' }).click()
    await page.getByRole('switch', { name: 'Shadow' }).check()
    await expect.poll(async () => ((await pageObjects(page))[0].effects as { shadow?: unknown } | undefined)?.shadow).toBeTruthy()
  })
})
