/**
 * [layout] The strip's number fields clamp to their range and show it (font size 8-200, line height 0.5-3, letter
 * spacing -200..800, stroke width 0-20, corner radius 0-100) and the canvas size popover to the document format's.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, addText, getDoc, openEditor, pageObjects, toolbarOf, waitForObjectCount } from './helpers'

test.describe('[layout] number field limits', () => {
  test('text: font size, line height and letter spacing are clamped and say what they accept', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addText(page, 'body')
    await waitForObjectCount(page, 1)
    await page.keyboard.press('Escape')

    const size = toolbarOf(page).getByRole('spinbutton', { name: 'Font size' })
    await expect(size).toHaveAttribute('title', 'Between 8 and 200')
    await size.fill('999')
    await size.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].fontSize).toBe(200)
    await size.fill('2')
    await size.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].fontSize).toBe(8)

    await toolbarOf(page).getByTestId('ed-line-height').click()
    const lineHeight = page.getByTestId('ed-line-height-input')
    await expect(lineHeight).toHaveAttribute('title', 'Between 0.5 and 3')
    await lineHeight.fill('9')
    await lineHeight.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].lineHeight).toBe(3)
    await lineHeight.fill('0.1')
    await lineHeight.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].lineHeight).toBe(0.5)
    await page.keyboard.press('Escape')

    await toolbarOf(page).getByTestId('ed-letter-spacing').click()
    const spacing = page.getByTestId('ed-letter-spacing-input')
    await expect(spacing).toHaveAttribute('title', 'Between -200 and 800')
    await spacing.fill('5000')
    await spacing.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].charSpacing).toBe(800)
    await spacing.fill('-5000')
    await spacing.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].charSpacing).toBe(-200)
  })

  test('shapes: stroke width stops at 20 and a corner radius at 100', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await toolbarOf(page).getByTestId('ed-shape-more').click()

    const stroke = page.getByTestId('ed-stroke-width')
    await expect(stroke).toHaveAttribute('title', 'Between 0 and 20')
    await stroke.fill('64')
    await stroke.press('Enter')
    await expect.poll(async () => (await pageObjects(page))[0].strokeWidth).toBe(20)

    const radius = page.getByTestId('ed-corner-radius')
    await expect(radius).toHaveAttribute('title', /^Between 0 and (\d+)$/)
    await radius.fill('5000')
    await radius.press('Enter')
    const rx = Number((await pageObjects(page))[0].rx)
    expect(rx).toBeGreaterThan(0)
    expect(rx).toBeLessThanOrEqual(100)
  })

  test('canvas size: values outside 1-20 000 px are pulled back and the limit is shown', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.getByTestId('ed-canvas-size').click()
    const width = page.getByTestId('ed-canvas-width')
    await expect(width).toHaveAttribute('title', 'Between 1 and 20000 px')
    await width.fill('45000')
    await width.press('Tab')
    await expect(width).toHaveValue('20000')
    await page.getByTestId('ed-canvas-apply').click()
    await expect.poll(async () => (await getDoc(page)).width).toBe(20000)
  })
})
