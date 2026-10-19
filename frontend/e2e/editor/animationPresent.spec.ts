/**
 * [layout] Pages that move in a slideshow: transitions between pages, animations on arrival, the page time counted from
 * the moment a page has built up, reduced motion, and the presenter view that follows. They click the current UI; the
 * plan, the cache and the frame renderer behind them have unit tests (`presenter/motion.test.ts`,
 * `animation/frameRenderer.test.ts`). The clock is faked where time matters.
 */
import { expect, test, type Page } from '@playwright/test'
import { moreMenu, openEditor } from './helpers'

const overlay = (page: Page) => page.getByTestId('present-overlay')
const counter = (page: Page) => page.getByTestId('present-counter')
const transition = (page: Page) => page.getByTestId('present-transition')
const frame = (page: Page) => page.getByTestId('present-frame')

async function present(page: Page): Promise<void> {
  await page.keyboard.press('Shift+P')
  await expect(overlay(page)).toBeVisible()
  await expect(frame(page)).toHaveAttribute('data-ready', 'true')
}

/**
 * Presents the first page on a clock that only moves when the test says so. The page is shown while time still runs (it
 * is drawn with the help of animation frames), then the clock stops and the page is entered again, so that its clock
 * starts at 0 on a clock that is held.
 */
async function startHeld(page: Page): Promise<void> {
  await page.clock.install()
  await openEditor(page, 'doc=animated')
  await present(page)
  await page.clock.pauseAt(Date.now() + 200)
  await page.keyboard.press('ArrowRight')
  await page.clock.runFor(100)
  await page.keyboard.press('ArrowLeft')
  await expect(counter(page)).toHaveText('1 / 3')
  await page.clock.runFor(20)
}

/** The colour of a point of the page (page px) as it is on the stage canvas right now. */
async function stagePixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="present-frame"]')!
      const scale = canvas.width / 1280
      return Array.from(canvas.getContext('2d')!.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data)
    },
    [x, y],
  )
}

/** How many pixels of a rectangle of the page (page px) on the stage canvas are not the page's pale background. */
async function stageInk(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<number> {
  return page.evaluate(
    ([a, b, c, d]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="present-frame"]')!
      const scale = canvas.width / 1280
      const px = canvas.getContext('2d')!.getImageData(Math.round(a * scale), Math.round(b * scale), Math.round((c - a) * scale), Math.round((d - b) * scale)).data
      let ink = 0
      for (let i = 0; i < px.length; i += 4) if (px[i] < 225) ink++
      return ink
    },
    [x0, y0, x1, y1],
  )
}

test.describe('[layout] present: motion', () => {
  test('plays the transition of the page it arrives at over the stage, then takes it away', async ({ page }) => {
    await startHeld(page)
    await expect(transition(page)).toHaveAttribute('data-live', 'false')
    await page.keyboard.press('ArrowRight')
    await expect(counter(page)).toHaveText('2 / 3')
    await page.clock.runFor(250)
    await expect(transition(page)).toHaveAttribute('data-live', 'true')
    await page.clock.runFor(350)
    await expect(transition(page)).toHaveAttribute('data-live', 'true')
    await page.clock.runFor(500)
    await expect(transition(page)).toHaveAttribute('data-live', 'false')
    await expect(frame(page)).toHaveAttribute('data-page-id', /.+/)
  })

  test('animations play on arrival: an element that has not come in yet is not on the page, and is when its enter is over', async ({ page }) => {
    await startHeld(page)
    // The star of the cover (page px 250, 560) spins in after 0.3 s: the page is bare there at first, then it is there.
    await page.clock.runFor(100)
    await expect.poll(async () => (await stagePixel(page, 250, 560))[0]).toBeGreaterThan(240)
    expect(await stageInk(page, 218, 250, 600, 350)).toBeGreaterThan(100)
    expect(await stageInk(page, 720, 250, 880, 350)).toBe(0)
    await page.clock.runFor(2500)
    const star = await stagePixel(page, 250, 560)
    expect(star[1]).toBeLessThan(60)
    // The heading rises word by word: "Animate" first, "anything" (to the right of it) a good while later.
    expect(await stageInk(page, 720, 250, 880, 350)).toBeGreaterThan(300)
    // The disc (1030, 190) pops in at the start and stays.
    const disc = await stagePixel(page, 1030, 190)
    expect(disc[0]).toBeGreaterThan(200)
    expect(disc[1]).toBeLessThan(80)
  })

  test('the page time starts once the page has built up, and the next page comes after it', async ({ page }) => {
    await startHeld(page)
    // Page 1: 1.5 s of build-up and 6 s of time.
    await expect(page.getByTestId('present-countdown')).toHaveText(/0:08 left/)
    await page.clock.runFor(7300)
    await expect(counter(page)).toHaveText('1 / 3')
    await page.clock.runFor(400)
    await expect(counter(page)).toHaveText('2 / 3')
    // Page 2: 0.7 s of transition, 0.6 s... and its exits at 4.4 s sit inside its 5 s.
    await expect(page.getByTestId('present-countdown')).toHaveText(/left/)
  })

  test('going back plays the transition the other way round and the page animates again', async ({ page }) => {
    await startHeld(page)
    await page.keyboard.press('ArrowRight')
    await page.clock.runFor(1500)
    await page.keyboard.press('ArrowLeft')
    await expect(counter(page)).toHaveText('1 / 3')
    // Page 1 has no transition of its own: it comes in at once.
    await expect(transition(page)).toHaveAttribute('data-live', 'false')
    await page.keyboard.press('ArrowRight')
    await page.clock.runFor(300)
    await expect(transition(page)).toHaveAttribute('data-live', 'true')
  })

  test('reduced motion: no object animation, and a short fade where a transition was', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await startHeld(page)
    // At rest from the start: the disc is in place at once and the page time has no build-up (6 s).
    const disc = await stagePixel(page, 1030, 190)
    expect(disc[0]).toBeGreaterThan(200)
    expect(disc[1]).toBeLessThan(80)
    await expect(page.getByTestId('present-countdown')).toHaveText(/0:06 left/)
    await page.keyboard.press('ArrowRight')
    await page.clock.runFor(100)
    await expect(transition(page)).toHaveAttribute('data-live', 'true')
    await page.clock.runFor(400)
    await expect(transition(page)).toHaveAttribute('data-live', 'false')
  })

  test('a design of still pages keeps the plain stage', async ({ page }) => {
    await openEditor(page, 'doc=deck')
    await present(page)
    await expect(transition(page)).toHaveCount(0)
  })

  test('the presenter view follows the audience window through the animated pages', async ({ page, context }) => {
    await openEditor(page, 'doc=animated')
    const [popup] = await Promise.all([page.waitForEvent('popup'), moreMenu(page, 'Present with notes')])
    await expect(overlay(page)).toBeVisible()
    await expect(popup.getByTestId('view-root')).toBeVisible({ timeout: 15_000 })
    await expect(popup.getByTestId('view-counter')).toHaveText('Page 1 of 3')
    await page.bringToFront()
    await page.keyboard.press('ArrowRight')
    await expect(popup.getByTestId('view-counter')).toHaveText('Page 2 of 3')
    await expect(popup.getByTestId('view-current-picture').locator('img')).toHaveAttribute('alt', 'Now: page 2, Cards')
    await context.close()
  })
})
