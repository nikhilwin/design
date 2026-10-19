/**
 * [layout] Comment pins on the artboard: comment mode, where a pin lands and whether it stays there, the card next to a
 * pin, the list in the sidebar and how the two follow each other. The harness serves the owner's in-memory comments
 * (`src/editor/dev/memoryComments.ts`); the roles, the real adapters and a real server are in `commentsRoles.spec.ts`
 * and `e2e/comments/`.
 */
import { expect, test } from '@playwright/test'
import { getDoc, openEditor } from './helpers'
import { calls, expectTip, openComments, pinWith, pins, placeComment, stored, surfaces, toClient } from './commentsHelpers'

test.describe('[layout] comment mode and pins', () => {
  test('the Comments button opens the list and comment mode: a crosshair over every page and a hint with a way out', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo')
    await expect(surfaces(page)).toHaveCount(0)
    await openComments(page)
    await expect(surfaces(page).first()).toBeVisible()
    expect(await surfaces(page).first().evaluate((el) => getComputedStyle(el).cursor)).toBe('crosshair')
    await expect(page.getByTestId('comment-mode-hint')).toBeVisible()
    await page.getByTestId('comment-mode-done').click()
    await expect(surfaces(page)).toHaveCount(0)
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    // The sidebar button brings the mode back.
    await page.getByTestId('comment-mode').click()
    await expect(surfaces(page).first()).toBeVisible()
    // Closing the sidebar ends comment mode and takes the pins away.
    await page.getByTestId('ed-end-comments').click()
    await expect(surfaces(page)).toHaveCount(0)
    await expect(pins(page)).toHaveCount(0)
  })

  test('the switch in the sidebar hides the pins and ends comment mode while the list stays', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    await expect(pins(page)).toHaveCount(3)
    await page.getByRole('switch', { name: 'Show comments on the design' }).setChecked(false)
    await expect(pins(page)).toHaveCount(0)
    await expect(surfaces(page)).toHaveCount(0)
    await expect(page.getByTestId('comment-thread')).toHaveCount(5)
    await page.getByRole('switch', { name: 'Show comments on the design' }).setChecked(true)
    await expect(pins(page)).toHaveCount(3)
    await expect(surfaces(page)).toHaveCount(0)
    await page.getByTestId('comment-mode').click()
    await expect(surfaces(page).first()).toBeVisible()
  })

  test('a click starts a comment exactly there; the pin keeps pointing at that spot through zoom, scroll and a reload of the layout', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo')
    await openComments(page)
    const target = await toClient(page, 300, 200)
    await page.mouse.click(target.x, target.y)
    const draft = page.getByTestId('comment-draft-pin')
    await expect(draft).toBeVisible()
    await expectTip(page, draft, 300, 200)
    await expect(page.getByTestId('pin-compose-text')).toBeFocused()
    await page.getByTestId('pin-compose-text').fill('Make this headline bolder')
    await page.getByTestId('pin-compose-send').click()

    const pin = pinWith(page, 'Make this headline bolder')
    await expect(pin).toBeVisible()
    await expect(page.getByTestId('pin-draft-card')).toHaveCount(0)
    await expectTip(page, pin, 300, 200)
    // A click lands on a whole CSS pixel, which is more than one page pixel at this zoom: what is stored is what was clicked.
    const [saved] = await stored(page)
    expect(saved).toMatchObject({ body: 'Make this headline bolder', resolved: false })
    expect(Math.abs((saved.x ?? 0) - 300)).toBeLessThan(2)
    expect(Math.abs((saved.y ?? 0) - 200)).toBeLessThan(2)
    expect(saved.page_id).toBe((await getDoc(page)).pages[0].id)
    const [x, y] = [saved.x ?? 0, saved.y ?? 0]

    // 100 %, then in, then out: the tip follows the page.
    await page.keyboard.press('Shift+0')
    await expectTip(page, pin, x, y)
    await page.keyboard.press('=')
    await page.keyboard.press('=')
    await expectTip(page, pin, x, y)
    await page.keyboard.press('-')
    await page.keyboard.press('-')
    await page.keyboard.press('-')
    await expectTip(page, pin, x, y)
    // Scrolling moves the page and the pin together.
    await page.keyboard.press('Shift+0')
    await page.mouse.move(700, 500)
    await page.mouse.wheel(0, 260)
    await page.mouse.wheel(60, 0)
    await expectTip(page, pin, x, y)
  })

  test('pins of the second page appear when it is scrolled into view, and stay on their page when pages are reordered', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo')
    await openComments(page)
    await page.locator('[data-artboard]').nth(1).scrollIntoViewIfNeeded()
    await placeComment(page, 120, 90, 'Second page note', 1)
    const pin = pinWith(page, 'Second page note')
    await expectTip(page, pin, 120, 90, 1)
    const secondId = (await getDoc(page)).pages[1].id
    expect((await stored(page))[0].page_id).toBe(secondId)

    // Move page 2 above page 1: the comment belongs to the page, not to its position in the stack.
    await page.getByRole('button', { name: 'Move page up' }).nth(1).click()
    await expect.poll(async () => (await getDoc(page)).pages[0].id).toBe(secondId)
    await expect(page.locator(`[data-artboard][data-page-id="${secondId}"] [data-testid="comment-pin"]`)).toHaveCount(1)
    await page.locator(`[data-artboard][data-page-id="${secondId}"]`).scrollIntoViewIfNeeded()
    await expectTip(page, pinWith(page, 'Second page note'), 120, 90, 0)
  })

  test('Esc steps back one thing at a time: the comment being written, the open card, comment mode', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await openComments(page)
    await expect(pins(page)).toHaveCount(3)

    const target = await toClient(page, 800, 800)
    await page.mouse.click(target.x, target.y)
    await expect(page.getByTestId('pin-draft-card')).toBeVisible()
    await page.getByTestId('pin-compose-text').fill('not sent')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('pin-draft-card')).toHaveCount(0)
    await expect(page.getByTestId('comment-draft-pin')).toHaveCount(0)
    expect(await calls(page)).not.toContain('create')

    const first = pinWith(page, 'Try a bolder headline')
    await first.click()
    await expect(page.getByTestId('pin-card')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('pin-card')).toHaveCount(0)
    await expect(first).toBeFocused()
    await expect(surfaces(page).first()).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(surfaces(page)).toHaveCount(0)
    await expect(pins(page)).toHaveCount(3)
  })

  test('clicking another spot while writing moves the comment there and keeps the text', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo')
    await openComments(page)
    const a = await toClient(page, 200, 200)
    await page.mouse.click(a.x, a.y)
    await page.getByTestId('pin-compose-text').fill('half a thought')
    const b = await toClient(page, 500, 600)
    await page.mouse.click(b.x, b.y)
    await expectTip(page, page.getByTestId('comment-draft-pin'), 500, 600)
    await expect(page.getByTestId('pin-compose-text')).toHaveValue('half a thought')
    await expect(page.getByTestId('pin-compose-text')).toBeFocused()
  })

  test('the hand tool and the space bar pan instead of placing comments', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo')
    await openComments(page)
    await page.keyboard.press('h')
    const at = await toClient(page, 300, 300)
    await page.mouse.click(at.x, at.y)
    await expect(page.getByTestId('pin-draft-card')).toHaveCount(0)
    await page.keyboard.press('v')
    await page.mouse.click(at.x, at.y)
    await expect(page.getByTestId('pin-draft-card')).toBeVisible()
  })
})
