/**
 * [engine] Read-only modes: no edits, no saves. Assertions on hidden controls are layout specific.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { getDoc, openEditor, toClient } from './helpers'

test.describe('[engine] read-only modes', () => {
  test('shared view hides every editing control and never saves', async ({ page }) => {
    await openEditor(page, 'doc=demo&mode=shared-view')
    await expect(page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible()
    for (const id of ['text', 'elements', 'image', 'shapes', 'templates', 'background', 'brand']) await expect(page.getByTestId(`ed-add-entry-${id}`)).toHaveCount(0)
    await expect(page.getByTestId('ed-add-entry-layers')).toBeVisible()
    await expect(page.getByTestId('ed-end-comments')).toHaveCount(0)
    await expect(page.getByTestId('ed-share')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add page', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0)
    // Zooming and downloading remain available.
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download', exact: true }).first()).toBeVisible()
  })

  test('clicking, dragging, typing and deleting cannot change a read-only design', async ({ page }) => {
    await openEditor(page, 'doc=demo&mode=shared-view')
    const before = JSON.stringify(await getDoc(page))
    const centre = await toClient(page, 540, 300)
    await page.mouse.click(centre.x, centre.y)
    await page.mouse.dblclick(centre.x, centre.y)
    await page.keyboard.type('hello')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.down()
    await page.mouse.move(centre.x + 80, centre.y + 80, { steps: 6 })
    await page.mouse.up()
    expect(JSON.stringify(await getDoc(page))).toBe(before)
    expect(await page.evaluate(() => window.__doory!.isDirty())).toBe(false)
    await page.waitForTimeout(2200)
    expect(await page.evaluate(() => window.__doory!.saves.length)).toBe(0)
  })

  test('shared comment mode is also read-only for design content', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=shared-comment')
    await expect(page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible()
    await expect(page.getByTestId('ed-add-entry-elements')).toHaveCount(0)
    // Commenting is what a comment link is for.
    await expect(page.getByTestId('ed-end-comments')).toBeVisible()
    await page.getByTestId('ed-end-comments').click()
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    await page.getByTestId('comment-new-text').fill('Nice cover')
    await page.getByTestId('comment-new-send').click()
    await expect(page.getByTestId('comment-thread')).toContainText('Nice cover')
    expect((await getDoc(page)).pages[0].objects).toHaveLength(0)
  })
})
