/**
 * [layout] Comments on a phone and in a design with a lot of them: the pins are only drawn for the pages that are near the
 * screen, and everything can be done with a finger.
 */
import { expect, test } from '@playwright/test'
import { getDoc, openEditor } from './helpers'
import { calls, expectTip, openComments, pinWith, pins, placeComment, stored } from './commentsHelpers'

test.describe('[layout] a design with 500 comments', () => {
  test('only the pages near the screen have pins, and the editor stays quick', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=stress&pages=10&objects=4&comments=500')
    const opened = Date.now()
    await page.getByTestId('ed-end-comments').click()
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    await expect(pins(page).first()).toBeVisible()
    expect(Date.now() - opened).toBeLessThan(5000)
    await expect(page.getByTestId('comments-badge')).toHaveText('99+')

    // 10 pages of 50 comments: far fewer than 500 pins are in the page, and no more than a few layers.
    const drawn = await pins(page).count()
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThanOrEqual(150)
    expect(await page.locator('[data-comment-layer]').count()).toBeLessThan(10)

    // Scrolling to the end draws other pages' pins and lets go of the first ones.
    const first = await page.locator('[data-comment-layer]').first().getAttribute('data-comment-layer')
    await page.locator('[data-artboard]').last().scrollIntoViewIfNeeded()
    await expect(page.locator(`[data-comment-layer="${first}"]`)).toHaveCount(0)
    await expect(pins(page).first()).toBeVisible()
    expect(await pins(page).count()).toBeLessThanOrEqual(150)
  })

  test('pins that sit close together are fanned out so that each can be clicked', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=blank&comments=40')
    await page.getByTestId('ed-end-comments').click()
    await expect(pins(page).first()).toBeVisible()
    // 40 comments of one page, 38 px apart in page pixels: at the fit zoom they overlap; nothing may hide another pin.
    const boxes = await pins(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })))
    expect(boxes.length).toBe(40)
    let overlapping = 0
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]
        const b = boxes[j]
        if (Math.abs(a.x - b.x) < a.w * 0.7 && Math.abs(a.y - b.y) < a.h * 0.7) overlapping += 1
      }
    }
    expect(overlapping).toBe(0)
  })
})

test.describe('[layout] on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('open the list from More, choose "Comment on the design", tap a page, write, send; open the pin again', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await page.getByTestId('ed-more').tap()
    await page.getByRole('menuitem', { name: /Comments/ }).tap()
    const sheet = page.getByTestId('sheet-comments')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('comment-surface')).toHaveCount(0)

    await sheet.getByTestId('comment-mode').tap()
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('comment-mode-hint')).toBeVisible()
    const art = await page.locator('[data-artboard]').first().boundingBox()
    if (!art) throw new Error('no artboard')
    await page.touchscreen.tap(art.x + art.width * 0.7, art.y + art.height * 0.8)
    const card = page.getByTestId('pin-draft-card')
    await expect(card).toBeVisible()
    // On a phone the card is a sheet at the bottom of the screen, not a popover over the page.
    const cardBox = await card.boundingBox()
    expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeGreaterThan(780)
    expect(cardBox?.width).toBeGreaterThan(360)
    await page.getByTestId('pin-compose-text').fill('Seen on a phone')
    await page.getByTestId('pin-compose-send').tap()
    const pin = pinWith(page, 'Seen on a phone')
    await expect(pin).toBeVisible()
    expect(await pin.boundingBox().then((b) => Math.min(b?.width ?? 0, b?.height ?? 0))).toBeGreaterThanOrEqual(26)
    await expect.poll(async () => (await stored(page)).some((c) => c.body === 'Seen on a phone')).toBe(true)

    // "Done" ends comment mode; the pins stay so that they can be tapped.
    await page.getByTestId('comment-mode-done').tap()
    await expect(page.getByTestId('comment-surface')).toHaveCount(0)
    await expect(pin).toBeVisible()
    await pin.tap()
    await expect(page.getByTestId('pin-card')).toContainText('Seen on a phone')
    expect(await calls(page)).toContain('create')
    await expect(page.locator('body')).toBeVisible()
    // No sideways scrolling anywhere.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('closing the list keeps the pins; switching them off in the list hides them', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=demo&comments=demo')
    await page.getByTestId('ed-more').tap()
    await page.getByRole('menuitem', { name: /Comments/ }).tap()
    await expect(page.getByTestId('sheet-comments').getByRole('switch', { name: 'Show comments on the design' })).toBeChecked()
    await page.getByTestId('sheet-close').tap()
    await expect(pins(page)).toHaveCount(3)
    await expect(page.getByTestId('comment-surface')).toHaveCount(0)
    await page.getByTestId('ed-more').tap()
    await page.getByRole('menuitem', { name: /Comments/ }).tap()
    await page.getByRole('switch', { name: 'Show comments on the design' }).setChecked(false)
    await page.getByTestId('sheet-close').tap()
    await expect(pins(page)).toHaveCount(0)
  })
})

test.describe('[layout] pages of different sizes', () => {
  /** A poster and a business card in one design (the way sizes.spec.ts makes them). */
  async function openPosterAndCard(page: import('@playwright/test').Page): Promise<void> {
    await openEditor(page, 'mode=account&doc=blank&w=1080&h=1920')
    await page.getByTestId('ed-pages-add').click()
    await expect(page.locator('[data-artboard]')).toHaveCount(2)
    await page.getByTestId('ed-page-size').nth(1).click()
    const pop = page.getByTestId('ed-canvas-size-pop')
    await pop.getByTestId('ed-canvas-width').fill('336')
    await pop.getByTestId('ed-canvas-height').fill('192')
    await pop.getByTestId('ed-canvas-apply').click()
    await expect(pop).toBeHidden()
    await expect.poll(async () => ((await getDoc(page)).pages[1] as { width?: number }).width).toBe(336)
  }

  test('every pin is placed and drawn through the size of its own page, whatever the zoom', async ({ page }) => {
    await openPosterAndCard(page)
    await openComments(page)
    await page.locator('[data-workspace-bg]').first().evaluate((el) => el.scrollTo(0, 0))
    await placeComment(page, 100, 200, 'On the poster', 0)
    await page.locator('[data-artboard]').nth(1).scrollIntoViewIfNeeded()
    await placeComment(page, 300, 150, 'On the card', 1)
    const [poster, card] = (await stored(page)).sort((a, b) => a.body.localeCompare(b.body)).reverse()
    expect(poster).toMatchObject({ body: 'On the poster' })
    expect(card).toMatchObject({ body: 'On the card' })
    expect(Math.abs((card.x ?? 0) - 300)).toBeLessThan(3)
    expect(Math.abs((card.y ?? 0) - 150)).toBeLessThan(3)
    expect(card.page_id).toBe((await getDoc(page)).pages[1].id)
    for (const zoomKey of ['Shift+0', '=', '-', '-']) {
      await page.keyboard.press(zoomKey)
      await page.locator('[data-artboard]').nth(1).scrollIntoViewIfNeeded()
      await expectTip(page, pinWith(page, 'On the card'), card.x ?? 0, card.y ?? 0, 1)
    }
    await page.locator('[data-workspace-bg]').first().evaluate((el) => el.scrollTo(0, 0))
    await expectTip(page, pinWith(page, 'On the poster'), poster.x ?? 0, poster.y ?? 0, 0)
  })

  test('a pin stays inside a page that was made smaller than where the comment was left', async ({ page }) => {
    await openEditor(page, 'mode=account&doc=blank&w=1080&h=1080')
    await openComments(page)
    await placeComment(page, 900, 900, 'Far corner', 0)
    // Make the (only) page small: the pin must not hang outside it.
    await page.getByTestId('ed-canvas-size').click()
    const pop = page.getByTestId('ed-canvas-size-pop')
    await pop.getByTestId('ed-canvas-width').fill('500')
    await pop.getByTestId('ed-canvas-height').fill('400')
    await pop.getByTestId('ed-canvas-apply').click()
    await expect(pop).toBeHidden()
    await expect.poll(async () => (await getDoc(page)).width).toBe(500)
    const art = await page.locator('[data-artboard]').first().boundingBox()
    const tip = await pinWith(page, 'Far corner').boundingBox()
    if (!art || !tip) throw new Error('no boxes')
    expect(tip.x).toBeGreaterThanOrEqual(art.x - 1)
    expect(tip.x).toBeLessThanOrEqual(art.x + art.width + 1)
    expect(tip.y + tip.height).toBeLessThanOrEqual(art.y + art.height + 1)
  })
})
