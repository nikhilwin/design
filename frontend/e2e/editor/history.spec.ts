/**
 * [engine] Undo/redo semantics. Uses the top-bar buttons and the Shapes drawer to create edits; replace those entry points when the chrome changes.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, openEditor, pageObjects, toolbarOf, waitForObjectCount } from './helpers'

test.describe('[engine] undo / redo', () => {
  test('buttons and shortcuts step through edits, including across page operations', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'rect')
    await addShape(page, 'ellipse')
    await waitForObjectCount(page, 2)
    await page.getByRole('button', { name: /^Undo/ }).click()
    await waitForObjectCount(page, 1)
    await page.keyboard.press('Control+Shift+z')
    await waitForObjectCount(page, 2)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await waitForObjectCount(page, 0)
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()
    await page.keyboard.press('Control+y')
    await waitForObjectCount(page, 1)

    // Structural changes are part of the same history.
    await page.getByRole('button', { name: 'Add page', exact: true }).first().click()
    await expect(page.locator('[data-artboard]')).toHaveCount(2)
    await page.keyboard.press('Control+z')
    await expect(page.locator('[data-artboard]')).toHaveCount(1)
    await page.keyboard.press('Control+Shift+z')
    await expect(page.locator('[data-artboard]')).toHaveCount(2)
  })

  test('continuous edits coalesce: scrubbing a slider is one undo step', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'rect')
    await toolbarOf(page).getByTestId('ed-shape-more').click()
    const slider = page.getByRole('slider', { name: 'Transparency' })
    for (const v of ['0.9', '0.7', '0.5', '0.3']) await slider.fill(v)
    await expect.poll(async () => (await pageObjects(page))[0].opacity).toBeCloseTo(0.3, 2)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await pageObjects(page))[0].opacity).toBe(1)
  })

  test('history keeps 100+ steps', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    for (let i = 0; i < 110; i++) await page.keyboard.press('r')
    await waitForObjectCount(page, 110)
    for (let i = 0; i < 105; i++) await page.keyboard.press('Control+z')
    await waitForObjectCount(page, 5)
    await expect(page.getByRole('button', { name: /^Redo/ })).toBeEnabled()
    await page.keyboard.press('Control+Shift+z')
    await waitForObjectCount(page, 6)
  })
})
