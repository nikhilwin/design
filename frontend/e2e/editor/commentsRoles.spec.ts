/**
 * [layout] Who may do what with comments. The harness gives the same threads to different people (`viewer=`): the owner
 * of the design, somebody commenting through a link, and a visitor who is not signed in; guests (a design that is not in
 * an account yet) and view-only links have no comments at all. The server enforces the same rules (backend tests);
 * here the editor must not offer what would be refused.
 */
import { expect, test } from '@playwright/test'
import { openEditor } from './helpers'
import { calls, openComments, pinWith, pins, stored, surfaces, toClient } from './commentsHelpers'

const threadOf = (page: import('@playwright/test').Page, text: string) => page.getByTestId('comment-thread').filter({ hasText: text })

test.describe('[layout] the owner', () => {
  test('resolves, deletes and moves every comment', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    for (const text of ['Try a bolder headline', 'The photo looks soft', 'Logo placement approved']) {
      await expect(pinWith(page, text)).toHaveAttribute('data-movable', 'true')
      const card = threadOf(page, text)
      await expect(card.getByTestId('comment-resolve')).toBeVisible()
      await expect(card.getByRole('button', { name: 'Delete thread' })).toBeVisible()
    }
    // Replies of other people can be deleted too.
    await expect(threadOf(page, 'Try a bolder headline').getByRole('button', { name: 'Delete reply' })).toBeVisible()
  })
})

test.describe('[layout] somebody commenting through a link', () => {
  const url = 'mode=shared-comment&viewer=commenter&doc=demo&comments=demo'

  test('sees the pins, but cannot resolve, and may delete and move only their own comments', async ({ page }) => {
    await openEditor(page, url)
    await openComments(page)
    await expect(pins(page)).toHaveCount(3)
    await expect(page.getByTestId('comment-resolve')).toHaveCount(0)

    // Sam Lee wrote "Try a bolder headline" and "The photo looks soft"; Alex Rivera (the owner) wrote "Logo placement approved".
    for (const own of ['Try a bolder headline', 'The photo looks soft']) {
      await expect(pinWith(page, own)).toHaveAttribute('data-movable', 'true')
      await expect(threadOf(page, own).getByRole('button', { name: 'Delete thread' })).toBeVisible()
    }
    await expect(pinWith(page, 'Logo placement approved')).not.toHaveAttribute('data-movable', 'true')
    await expect(threadOf(page, 'Logo placement approved').getByRole('button', { name: 'Delete thread' })).toHaveCount(0)
    // In the thread they started, the owner's reply is not theirs to delete.
    const mine = threadOf(page, 'Try a bolder headline')
    await expect(mine.getByRole('button', { name: 'Delete reply' })).toHaveCount(0)
  })

  test('can leave a comment, which is theirs, and delete it again', async ({ page }) => {
    await openEditor(page, url)
    await openComments(page)
    const at = await toClient(page, 700, 700)
    await page.mouse.click(at.x, at.y)
    await page.getByTestId('pin-compose-text').fill('From a reviewer')
    await page.getByTestId('pin-compose-send').click()
    const pin = pinWith(page, 'From a reviewer')
    await expect(pin).toBeVisible()
    await expect(pin).toHaveAttribute('data-movable', 'true')
    expect((await stored(page)).find((c) => c.body === 'From a reviewer')).toBeTruthy()
    await pin.click()
    const card = page.getByTestId('pin-card')
    await expect(card.getByTestId('pin-resolve')).toHaveCount(0)
    await card.getByRole('button', { name: 'Delete thread' }).click()
    await card.getByTestId('pin-delete-confirm').click()
    await expect(pin).toHaveCount(0)
  })

  test('cannot drag a pin that is not theirs', async ({ page }) => {
    await openEditor(page, url)
    await openComments(page)
    const pin = pinWith(page, 'Logo placement approved')
    await page.locator('[data-artboard]').nth(1).scrollIntoViewIfNeeded()
    const box = await pin.boundingBox()
    if (!box) throw new Error('no pin')
    await page.mouse.move(box.x + 12, box.y + 12)
    await page.mouse.down()
    await page.mouse.move(box.x + 100, box.y + 100, { steps: 6 })
    await page.mouse.up()
    expect((await calls(page)).filter((c) => c.startsWith('move:'))).toEqual([])
  })

  test('the document stays read-only: comment mode does not select or change objects', async ({ page }) => {
    await openEditor(page, url)
    await openComments(page)
    const before = await page.evaluate(() => JSON.stringify(window.__doory!.getDocument()))
    const at = await toClient(page, 540, 440)
    await page.mouse.click(at.x, at.y)
    await page.mouse.dblclick(at.x, at.y)
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => JSON.stringify(window.__doory!.getDocument()))).toBe(before)
  })
})

test.describe('[layout] a visitor who is not signed in', () => {
  const url = 'mode=shared-comment&viewer=anonymous&doc=demo&comments=demo'

  test('reads the comments, but has nothing to resolve, delete or move', async ({ page }) => {
    await openEditor(page, url)
    await openComments(page)
    await expect(pins(page)).toHaveCount(3)
    await expect(page.getByTestId('comment-resolve')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Delete thread' })).toHaveCount(0)
    await expect(pinWith(page, 'The photo looks soft')).not.toHaveAttribute('data-movable', 'true')
    await expect(page.getByRole('radio', { name: /^Mine/ })).toHaveCount(0)
  })

  test('is asked to sign up when they click a spot, and goes on from there once they have', async ({ page }) => {
    await openEditor(page, url)
    await openComments(page)
    const at = await toClient(page, 500, 800)
    await page.mouse.click(at.x, at.y)
    await expect.poll(() => page.evaluate(() => window.__doory!.accountRequests)).toContain('comment')
    // The (in-memory) sign-up succeeds: the comment box opens at the spot that was clicked.
    await expect(page.getByTestId('pin-draft-card')).toBeVisible()
    await page.getByTestId('pin-compose-text').fill('Signed up and commenting')
    await page.getByTestId('pin-compose-send').click()
    await expect(pinWith(page, 'Signed up and commenting')).toBeVisible()
    await expect(pinWith(page, 'Signed up and commenting')).toHaveAttribute('data-movable', 'true')
  })

  test('a reply also goes through the sign-up first', async ({ page }) => {
    await openEditor(page, url)
    await openComments(page)
    await pinWith(page, 'The photo looks soft').click()
    await page.getByTestId('pin-reply-text').fill('Agreed')
    await page.getByTestId('pin-reply-send').click()
    await expect.poll(() => page.evaluate(() => window.__doory!.accountRequests)).toContain('comment')
    await expect(page.getByTestId('pin-card')).toContainText('Agreed')
  })
})

test.describe('[layout] guests and view-only links', () => {
  test('a guest design offers the sign-up gate and no pins or comment mode', async ({ page }) => {
    await openEditor(page, 'mode=guest&doc=demo')
    await page.getByTestId('ed-end-comments').click()
    await expect(page.getByTestId('comments-gate')).toBeVisible()
    await expect(surfaces(page)).toHaveCount(0)
    await expect(pins(page)).toHaveCount(0)
    await page.getByTestId('comments-signup').click()
    await expect.poll(() => page.evaluate(() => window.__doory!.accountRequests)).toContain('comment')
  })

  test('a view-only link has no comments at all', async ({ page }) => {
    await openEditor(page, 'mode=shared-view&doc=demo')
    await expect(page.getByTestId('ed-end-comments')).toHaveCount(0)
    await page.keyboard.press('Shift+C')
    await expect(surfaces(page)).toHaveCount(0)
    await expect(page.getByTestId('comments-panel')).toHaveCount(0)
  })
})

test.describe('[layout] the keyboard shortcut', () => {
  test('Shift+C opens the list with comment mode, then switches comment mode off and on', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await page.keyboard.press('Shift+C')
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    await expect(surfaces(page).first()).toBeVisible()
    await page.keyboard.press('Shift+C')
    await expect(surfaces(page)).toHaveCount(0)
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    await expect(pins(page)).toHaveCount(3)
    await page.keyboard.press('Shift+C')
    await expect(surfaces(page).first()).toBeVisible()
  })

  test('works in a comment link, where the other shortcuts are off', async ({ page }) => {
    await openEditor(page, 'mode=shared-comment&viewer=commenter&doc=demo&comments=demo')
    await page.keyboard.press('Shift+C')
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    await expect(pins(page)).toHaveCount(3)
  })
})
