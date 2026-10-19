/**
 * [engine] Engine behaviour (save timing, queueing, conflicts, errors) observed through window.__doory. Only the setup that adds a shape and the title field touch the current chrome.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { expect, test } from '@playwright/test'
import { addShape, openEditor, waitForObjectCount } from './helpers'

const savedCount = (page: import('@playwright/test').Page): Promise<number> => page.evaluate(() => window.__doory!.saves.length)

test.describe('[engine] autosave and persistence', () => {
  test('edits are saved once, debounced, with the document, the title and a thumbnail', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    expect(await savedCount(page)).toBe(0)
    for (const id of ['rect', 'ellipse', 'star'] as const) await addShape(page, id)
    await waitForObjectCount(page, 3)
    expect(await page.evaluate(() => window.__doory!.isDirty())).toBe(true)
    await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible()
    // Not saved yet (debounce), then exactly one save carrying all three edits.
    expect(await savedCount(page)).toBe(0)
    await expect.poll(() => savedCount(page), { timeout: 8000 }).toBe(1)
    const save = await page.evaluate(() => {
      const s = window.__doory!.saves[0]
      return { objects: s.document.pages[0].objects.length, title: s.title, thumb: s.thumbnail?.size ?? 0 }
    })
    expect(save.objects).toBe(3)
    expect(save.title).toBe('Untitled design')
    expect(save.thumb).toBeGreaterThan(0)
    await expect(page.getByRole('status').filter({ hasText: /Saved/ })).toBeVisible()
    expect(await page.evaluate(() => window.__doory!.isDirty())).toBe(false)
  })

  test('saveNow flushes immediately and a rename is saved with the new title', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    const input = page.getByRole('textbox', { name: 'Design title' })
    await input.fill('Spring launch')
    await input.press('Enter')
    await page.evaluate(() => window.__doory!.saveNow())
    const titles = await page.evaluate(() => window.__doory!.saves.map((s) => s.title))
    expect(titles.at(-1)).toBe('Spring launch')
    expect(await page.evaluate(() => window.__doory!.titles.at(-1))).toBe('Spring launch')
  })

  test('hiding the page flushes unsaved changes without waiting for the debounce', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await addShape(page, 'rect')
    await waitForObjectCount(page, 1)
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await expect.poll(() => savedCount(page), { timeout: 3000 }).toBe(1)
  })

  test('edits made while a save is in flight are saved afterwards, never concurrently', async ({ page }) => {
    await openEditor(page, 'doc=blank&saveDelay=900')
    await addShape(page, 'rect')
    await page.evaluate(() => window.__doory!.saveNow().catch(() => undefined))
    await addShape(page, 'ellipse')
    await expect.poll(() => savedCount(page), { timeout: 10_000 }).toBe(2)
    const sizes = await page.evaluate(() => window.__doory!.saves.map((s) => s.document.pages[0].objects.length))
    expect(sizes.at(-1)).toBe(2)
  })

  test('a failed save shows a retry affordance and the retry succeeds', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await page.evaluate(() => window.__doory!.failNextSave('error'))
    await addShape(page, 'rect')
    const alert = page.getByRole('alert').filter({ hasText: 'Not saved' })
    await expect(alert).toBeVisible({ timeout: 8000 })
    await alert.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => savedCount(page), { timeout: 5000 }).toBe(1)
    await expect(alert).toHaveCount(0)
  })

  test('a revision conflict raises a banner and reports the user choice to the shell', async ({ page }) => {
    await openEditor(page, 'doc=blank&mode=account')
    await page.evaluate(() => window.__doory!.failNextSave('conflict'))
    await addShape(page, 'rect')
    const banner = page.getByRole('alert').filter({ hasText: 'This design changed somewhere else' })
    await expect(banner).toBeVisible({ timeout: 8000 })
    await expect(page.getByRole('status').filter({ hasText: 'Conflict' })).toBeVisible()
    await banner.getByRole('button', { name: 'Keep editing (save as copy)' }).click()
    expect(await page.evaluate(() => window.__doory!.conflictChoices)).toEqual(['save-as-copy'])
    await banner.getByRole('button', { name: 'Dismiss' }).click()
    await expect(banner).toHaveCount(0)
  })
})
