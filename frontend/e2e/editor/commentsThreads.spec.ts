/**
 * [layout] Threads: the card next to a pin, the list in the sidebar, and how they stay in step (reply, resolve, delete,
 * filters, counts, "show on the page"), what happens when the server says no and when somebody else changes things.
 */
import { expect, test } from '@playwright/test'
import { getDoc, openEditor } from './helpers'
import { calls, openComments, pinWith, pins, stored, tipOf } from './commentsHelpers'

const badge = (page: import('@playwright/test').Page) => page.getByTestId('comments-badge')

test.describe('[layout] threads', () => {
  test('reply, resolve, reopen and delete from the card, with the list and the badge following', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    await expect(pins(page)).toHaveCount(3)
    await expect(badge(page)).toHaveText('4')

    const pin = pinWith(page, 'The photo looks soft')
    await pin.click()
    const card = page.getByTestId('pin-card')
    await expect(card).toContainText('The photo looks soft at this size.')
    await expect(card.getByTestId('pin-reply-text')).toBeFocused()

    await card.getByTestId('pin-reply-text').fill('Swapping it for a sharper one')
    await card.getByTestId('pin-reply-send').click()
    await expect(card).toContainText('Swapping it for a sharper one')
    await expect(card.getByTestId('pin-reply-text')).toHaveValue('')
    // The same reply is in the list.
    await expect(page.locator('[data-testid="comment-thread"]').filter({ hasText: 'The photo looks soft' })).toContainText('Swapping it for a sharper one')

    await card.getByTestId('pin-resolve').click()
    await expect(pin).toHaveAttribute('data-resolved', 'true')
    await expect(badge(page)).toHaveText('3')
    await expect(page.getByText('Resolved (2)')).toBeVisible()
    await card.getByTestId('pin-resolve').click()
    await expect(pin).not.toHaveAttribute('data-resolved', 'true')
    await expect(badge(page)).toHaveText('4')

    await card.getByRole('button', { name: 'Delete thread' }).click()
    await card.getByTestId('pin-delete-confirm').click()
    await expect(page.getByTestId('pin-card')).toHaveCount(0)
    await expect(pins(page)).toHaveCount(2)
    await expect(page.getByText('The photo looks soft')).toHaveCount(0)
    expect((await stored(page)).some((c) => c.body.startsWith('The photo'))).toBe(false)
  })

  test('a reply can be deleted on its own', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    await pinWith(page, 'Try a bolder headline').click()
    const card = page.getByTestId('pin-card')
    await expect(card).toContainText('Good call, I will make it heavier.')
    await card.getByRole('button', { name: 'Delete reply' }).click()
    await card.getByRole('button', { name: 'Delete reply' }).click()
    await expect(card).not.toContainText('Good call')
    await expect(card).toContainText('Try a bolder headline here.')
  })

  test('the filters and their counts change what the list and the pins show', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const filters = page.getByRole('radiogroup', { name: 'Show comments' })
    await expect(filters.getByText('All 5')).toBeVisible()
    await expect(filters.getByText('Unresolved 4')).toBeVisible()
    await expect(filters.getByText('Mine 1')).toBeVisible()

    await filters.getByRole('radio', { name: /^Unresolved/ }).check({ force: true })
    await expect(page.getByTestId('comment-thread')).toHaveCount(4)
    // The resolved thread is on page 2, which is not on screen: scroll to it to see that its pin is gone.
    await page.locator('[data-artboard]').nth(1).scrollIntoViewIfNeeded()
    await expect(pins(page).filter({ has: page.locator('svg') })).toHaveCount(0)

    await filters.getByRole('radio', { name: /^Mine/ }).check({ force: true })
    await expect(page.getByTestId('comment-thread')).toHaveCount(1)
    await expect(page.getByTestId('comment-thread')).toContainText('Logo placement approved.')

    await filters.getByRole('radio', { name: /^All/ }).check({ force: true })
    await expect(page.getByTestId('comment-thread')).toHaveCount(5)
  })

  test('a thread whose page is gone is listed as "Page removed" and is not drawn', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const gone = page.getByTestId('comment-thread').filter({ hasText: 'on a page that no longer exists' })
    await expect(gone.getByTestId('comment-page-removed')).toHaveText('Page removed')
    await expect(gone.getByTestId('comment-show')).toHaveCount(0)
    await expect(pins(page)).toHaveCount(3)
    await expect(page.getByRole('button', { name: /no longer exists/ })).toHaveCount(0)
  })

  test('clicking a thread in the list scrolls to its pin, opens its card and pulses the pin', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    // Zoomed in, page 2 and its pin are far below the screen: they are not even drawn.
    await page.getByRole('button', { name: /^Zoom level: / }).click()
    await page.getByRole('menuitem', { name: '200%' }).click()
    const pin = pinWith(page, 'Logo placement approved')
    await expect(pin).toHaveCount(0)
    await page.getByTestId('comment-thread').filter({ hasText: 'Logo placement approved' }).getByTestId('comment-show').click()
    await expect(pin).toBeInViewport({ ratio: 0.95 })
    await expect(page.getByTestId('pin-card')).toContainText('Logo placement approved.')
    await expect(pin).toHaveAttribute('data-active', 'true')
    await expect(page.locator('[data-testid="comment-thread"][data-active]')).toContainText('Logo placement approved.')
    await expect(pin).toHaveAttribute('data-pulse', 'true')
    await expect(pin).not.toHaveAttribute('data-pulse', 'true', { timeout: 4000 })
  })

  test('opening a pin highlights its card in the list, and a pin hover shows a preview', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const pin = pinWith(page, 'The photo looks soft')
    await pin.hover()
    await expect(page.getByTestId('comment-pin-preview')).toContainText('Sam Lee')
    await expect(page.getByTestId('comment-pin-preview')).toContainText('The photo looks soft')
    await pin.click()
    await expect(page.getByTestId('comment-pin-preview')).toHaveCount(0)
    await expect(page.locator('[data-testid="comment-thread"][data-active]')).toContainText('The photo looks soft')
  })

  test('walking the pins with the keyboard: Tab, the arrow keys, Enter and Esc', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const first = pinWith(page, 'Try a bolder headline')
    const second = pinWith(page, 'The photo looks soft')
    await first.focus()
    await expect(first).toHaveAttribute('tabindex', '0')
    await expect(second).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('ArrowRight')
    await expect(second).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(first).toBeFocused()
    await page.keyboard.press('End')
    await expect(pinWith(page, 'Logo placement approved')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(first).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('pin-card')).toContainText('Try a bolder headline here.')
    await page.keyboard.press('Escape')
    await expect(first).toBeFocused()
  })

  test('Alt + arrows nudge a pin and save the new place once, a moment after the last key', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const pin = pinWith(page, 'The photo looks soft')
    const before = (await stored(page)).find((c) => c.body.startsWith('The photo'))
    await pin.focus()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Alt+ArrowRight')
    await page.keyboard.press('Alt+Shift+ArrowDown')
    await expect.poll(async () => (await calls(page)).filter((c) => c.startsWith('move:')).length).toBe(1)
    const after = (await stored(page)).find((c) => c.body.startsWith('The photo'))
    expect(after?.x).toBe((before?.x ?? 0) + 3)
    expect(after?.y).toBe((before?.y ?? 0) + 10)
    expect(after?.page_id).toBe(before?.page_id)
  })

  test('a pin is dragged to a new place; Esc during the drag puts it back', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const pin = pinWith(page, 'The photo looks soft')
    const before = await tipOf(pin)
    const saved = (await stored(page)).find((c) => c.body.startsWith('The photo'))

    // Cancelled: nothing is sent and the pin is where it was.
    await page.mouse.move(before.x + 12, before.y - 12)
    await page.mouse.down()
    await page.mouse.move(before.x + 100, before.y + 60, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await calls(page)).not.toContain(`move:${saved?.id}`)
    expect(Math.abs((await tipOf(pin)).x - before.x)).toBeLessThan(1)
    await expect(page.getByTestId('pin-card')).toHaveCount(0)

    // Dropped: the pin lands where the tip was released, in page pixels.
    const doc = await getDoc(page)
    const art = await page.locator('[data-artboard]').first().boundingBox()
    if (!art) throw new Error('no artboard')
    const zoom = art.width / doc.width
    await page.mouse.move(before.x + 12, before.y - 12)
    await page.mouse.down()
    await page.mouse.move(before.x + 12 + 80, before.y - 12 + 50, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await calls(page)).includes(`move:${saved?.id}`)).toBe(true)
    const after = (await stored(page)).find((c) => c.body.startsWith('The photo'))
    expect(Math.abs((after?.x ?? 0) - ((saved?.x ?? 0) + 80 / zoom))).toBeLessThan(2.5)
    expect(Math.abs((after?.y ?? 0) - ((saved?.y ?? 0) + 50 / zoom))).toBeLessThan(2.5)
    const now = await tipOf(pin)
    expect(Math.abs(now.x - (before.x + 80))).toBeLessThan(2)
    // The drag did not open the card.
    await expect(page.getByTestId('pin-card')).toHaveCount(0)
  })

  test('a pin dropped outside every page stays where it was', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const pin = pinWith(page, 'The photo looks soft')
    const before = await tipOf(pin)
    await page.mouse.move(before.x + 12, before.y - 12)
    await page.mouse.down()
    await page.mouse.move(40, 300, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Math.abs((await tipOf(pin)).x - before.x)).toBeLessThan(1)
    expect((await calls(page)).filter((c) => c.startsWith('move:'))).toEqual([])
  })
})

test.describe('[layout] when the server says no, and when somebody else is working', () => {
  test('a comment that is refused disappears again, the text stays in the box and the reason is shown', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo')
    await openComments(page)
    await page.evaluate(() => window.__doory!.comments.failNext('create', Object.assign(new Error('x'), { status: 429 })))
    await page.getByTestId('comment-new-text').fill('A general note')
    await page.getByTestId('comment-new-send').click()
    await expect(page.getByTestId('comment-new-error')).toBeVisible()
    await expect(page.getByTestId('comment-new-text')).toHaveValue('A general note')
    await expect(page.getByTestId('comment-thread')).toHaveCount(0)
    // Trying again works.
    await page.getByTestId('comment-new-send').click()
    await expect(page.getByTestId('comment-thread')).toHaveCount(1)
    await expect(page.getByTestId('comment-new-text')).toHaveValue('')
  })

  test('resolving that fails flips back, with a message', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const pin = pinWith(page, 'The photo looks soft')
    await page.evaluate(() => window.__doory!.comments.failNext('resolve'))
    await pin.click()
    await page.getByTestId('pin-resolve').click()
    await expect(page.getByRole('status').filter({ hasText: /Something went wrong|offline|try/i }).or(page.getByText('Something went wrong. Try again.'))).toBeVisible()
    await expect(pin).not.toHaveAttribute('data-resolved', 'true')
    await expect(badge(page)).toHaveText('4')
  })

  test('a move that fails puts the pin back', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    const pin = pinWith(page, 'The photo looks soft')
    const before = await tipOf(pin)
    await page.evaluate(() => window.__doory!.comments.failNext('move'))
    await page.mouse.move(before.x + 12, before.y - 12)
    await page.mouse.down()
    await page.mouse.move(before.x + 92, before.y + 40, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await calls(page)).some((c) => c.startsWith('move:'))).toBe(true)
    await expect.poll(async () => Math.abs((await tipOf(pin)).x - before.x)).toBeLessThan(1)
    await expect(page.getByText('Could not move the comment.')).toBeVisible()
  })

  test('a new comment is on the page at once while the server still has it, dimmed', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&commentLatency=1500')
    await openComments(page)
    const at = await page.locator('[data-artboard]').first().boundingBox()
    if (!at) throw new Error('no artboard')
    await page.mouse.click(at.x + 200, at.y + 200)
    await page.getByTestId('pin-compose-text').fill('Quick note')
    await page.getByTestId('pin-compose-send').click()
    const pin = pinWith(page, 'Quick note')
    await expect(pin).toHaveAttribute('data-pending', 'true')
    await expect(pin).not.toHaveAttribute('data-pending', 'true', { timeout: 5000 })
  })

  test('comments other people made show up on their own, and a thread they delete goes away', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    await expect(pins(page)).toHaveCount(3)
    const id = await page.evaluate(() => {
      const made = window.__doory!.comments.remote.add({ body: 'Added while you were looking', page_id: window.__doory!.getDocument().pages[0].id, x: 900, y: 900 })
      return made.id
    })
    // Coming back to the tab refreshes at once (the timer would take 15 s), at most once a second.
    await expect
      .poll(async () => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        return pins(page).count()
      })
      .toBe(4)
    await expect(pinWith(page, 'Added while you were looking')).toBeVisible()
    await page.evaluate((remove) => window.__doory!.comments.remote.remove(remove), id)
    // The network coming back also refreshes (at most once a second).
    await expect
      .poll(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        return pins(page).count()
      })
      .toBe(3)
  })

  test('the list is refreshed every 15 seconds while the sidebar is open', async ({ page }) => {
    test.setTimeout(60_000)
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    await expect(pins(page)).toHaveCount(3)
    const listed = (await calls(page)).filter((c) => c === 'list').length
    await page.evaluate(() => window.__doory!.comments.remote.add({ body: 'Arrived by polling', page_id: window.__doory!.getDocument().pages[0].id, x: 700, y: 900 }))
    await expect(pinWith(page, 'Arrived by polling')).toBeVisible({ timeout: 25_000 })
    expect((await calls(page)).filter((c) => c === 'list').length).toBeGreaterThan(listed)
    // Closing the sidebar stops the polling.
    await page.getByTestId('ed-end-comments').click()
    const settled = (await calls(page)).filter((c) => c === 'list').length
    await page.waitForTimeout(17_000)
    expect((await calls(page)).filter((c) => c === 'list').length).toBe(settled)
  })
})
