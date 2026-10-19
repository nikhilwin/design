/**
 * [layout] The slideshow window: letterboxing of pages of different sizes, the keyboard map, click, tap and swipe,
 * the progress indicator, auto-advance on a fake clock, the laser pointer, the black screen and the end screen.
 * The state machine behind it has unit tests (`presenter/machine.test.ts`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { getDoc, moreMenu, openEditor } from './helpers'

const overlay = (page: Page) => page.getByTestId('present-overlay')
const counter = (page: Page) => page.getByTestId('present-counter')
const frame = (page: Page) => page.getByTestId('present-frame')

async function openDeck(page: Page, query = ''): Promise<void> {
  await openEditor(page, `doc=deck${query ? `&${query}` : ''}`)
}

async function present(page: Page): Promise<void> {
  await page.keyboard.press('Shift+P')
  await expect(overlay(page)).toBeVisible()
  await ready(page)
}

/** The current page has been rendered onto the stage. */
async function ready(page: Page): Promise<void> {
  await expect(frame(page)).toHaveAttribute('data-ready', 'true')
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

/** Every page gets "Apply to all pages" with this many seconds through the first page's chip. */
async function setAllTimes(page: Page, seconds: number): Promise<void> {
  await page.locator('section[data-page-id]').first().getByTestId('ed-time-chip').click()
  await page.getByTestId('ed-time-input').fill(String(seconds))
  await page.getByTestId('ed-time-input').press('Enter')
  await page.getByTestId('ed-time-all').click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await getDoc(page)).pages.map((p) => (p as { durationSec?: number }).durationSec)).toEqual([seconds, seconds, seconds])
}

test.describe('[layout] present: opening and leaving', () => {
  test('opens from the shortcut, the top bar and the More menu; Escape leaves', async ({ page }) => {
    await openDeck(page)
    await page.keyboard.press('Shift+P')
    await expect(overlay(page)).toBeVisible()
    await expect(overlay(page)).toHaveAttribute('aria-modal', 'true')
    await page.keyboard.press('Escape')
    await expect(overlay(page)).toBeHidden()
    await moreMenu(page, /^Present$/)
    await expect(overlay(page)).toBeVisible()
    await page.getByTestId('present-exit').click()
    await expect(overlay(page)).toBeHidden()
  })

  test('starts on the page that is active in the editor', async ({ page }) => {
    await openDeck(page)
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await present(page)
    await expect(counter(page)).toHaveText('2 / 3')
  })

  test('the editor shortcuts are off while presenting', async ({ page }) => {
    await openDeck(page)
    await present(page)
    // "R" is Add rectangle in the editor; here it restarts the show, and nothing is added to the design.
    await page.keyboard.press('r')
    await page.keyboard.press('l')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(overlay(page)).toBeHidden()
    for (const p of (await getDoc(page)).pages) expect(p.objects.filter((o) => o.type === 'rect' || o.type === 'doryline')).toHaveLength(0)
  })

  test('Full screen: F toggles it without ending the presentation', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true)
    await expect(page.getByTestId('present-fullscreen')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('f')
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false)
    await expect(overlay(page)).toBeVisible()
    await page.keyboard.press('f')
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(overlay(page)).toBeHidden()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false)
  })
})

test.describe('[layout] present: letterboxing', () => {
  for (const view of [
    { name: '1440 x 900', width: 1440, height: 900 },
    { name: '1024 x 768', width: 1024, height: 768 },
    { name: '390 x 844', width: 390, height: 844 },
  ]) {
    test(`each page is boxed by its own size at ${view.name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: 2 })
      const page = await context.newPage()
      await openDeck(page)
      const doc = await getDoc(page)
      // A page of the design's own size carries no size of its own.
      const sizes = doc.pages.map((p) => ({ width: (p as { width?: number }).width ?? doc.width, height: (p as { height?: number }).height ?? doc.height }))
      await present(page)
      // The slideshow starts on the page the workspace has active, which on a phone may be the second one.
      await page.keyboard.press('Home')
      for (let i = 0; i < sizes.length; i++) {
        await expect(counter(page)).toHaveText(`${i + 1} / 3`)
        await ready(page)
        const stage = await box(page.getByTestId('present-stage'))
        const framed = await box(page.getByTestId('present-frame-box'))
        // The page's shape, never stretched.
        expect(framed.width / framed.height).toBeCloseTo(sizes[i].width / sizes[i].height, 1)
        // As large as fits: one side is the stage's own.
        const fits = Math.abs(framed.width - stage.width) <= 1 || Math.abs(framed.height - stage.height) <= 1
        expect(fits).toBe(true)
        expect(framed.width).toBeLessThanOrEqual(stage.width + 1)
        expect(framed.height).toBeLessThanOrEqual(stage.height + 1)
        // Centred.
        expect(Math.abs(framed.x - stage.x - (stage.width - framed.width) / 2)).toBeLessThanOrEqual(1)
        expect(Math.abs(framed.y - stage.y - (stage.height - framed.height) / 2)).toBeLessThanOrEqual(1)
        // Crisp: the bitmap has the device pixels of the box.
        const pixels = await frame(page).evaluate((c: HTMLCanvasElement) => c.width)
        expect(Math.abs(pixels - framed.width * 2)).toBeLessThanOrEqual(3)
        if (i < sizes.length - 1) await page.keyboard.press('ArrowRight')
      }
      await context.close()
    })
  }

  test('the stage is repainted for its new size after the window is resized', async ({ page }) => {
    await openDeck(page)
    await present(page)
    const before = await frame(page).evaluate((c: HTMLCanvasElement) => c.width)
    await page.setViewportSize({ width: 800, height: 600 })
    await expect.poll(() => frame(page).evaluate((c: HTMLCanvasElement) => c.width), { timeout: 5000 }).not.toBe(before)
    const framed = await box(page.getByTestId('present-frame-box'))
    const pixels = await frame(page).evaluate((c: HTMLCanvasElement) => c.width)
    expect(Math.abs(pixels - framed.width)).toBeLessThanOrEqual(3)
  })
})

test.describe('[layout] present: keyboard', () => {
  test('the navigation keys', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await expect(counter(page)).toHaveText('1 / 3')
    for (const [key, expected] of [
      ['ArrowRight', '2 / 3'],
      ['Space', '3 / 3'],
      ['ArrowLeft', '2 / 3'],
      ['PageDown', '3 / 3'],
      ['PageUp', '2 / 3'],
      ['Home', '1 / 3'],
      ['End', '3 / 3'],
      ['Backspace', '2 / 3'],
      ['ArrowDown', '3 / 3'],
      ['ArrowUp', '2 / 3'],
      ['Enter', '3 / 3'],
      ['Shift+Space', '2 / 3'],
    ] as const) {
      await page.keyboard.press(key)
      await expect(counter(page)).toHaveText(expected)
    }
  })

  test('keys with Ctrl, Cmd or Alt are left to the browser', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await page.keyboard.press('Control+ArrowRight')
    await page.keyboard.press('Alt+ArrowRight')
    await expect(counter(page)).toHaveText('1 / 3')
  })

  test('N shows the speaker notes under the page; B blacks the screen out and any key brings it back', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await expect(page.getByTestId('present-notes')).toHaveCount(0)
    await page.keyboard.press('n')
    await expect(page.getByTestId('present-notes')).toContainText('Welcome everyone.')
    await expect(page.getByTestId('present-notes-toggle')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('present-notes')).toHaveText('Walk through the square layout.')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('present-notes')).toHaveText('No notes for this page.')
    await page.keyboard.press('n')
    await expect(page.getByTestId('present-notes')).toHaveCount(0)

    await page.keyboard.press('b')
    await expect(page.getByTestId('present-black')).toBeVisible()
    await expect(page.getByTestId('present-blackout')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('present-black')).toHaveCount(0)
    await expect(counter(page)).toHaveText('2 / 3')
    await page.keyboard.press('b')
    await page.keyboard.press('b')
    await expect(page.getByTestId('present-black')).toHaveCount(0)
  })

  test('? lists the keys; Escape closes the list first and then leaves', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await page.keyboard.press('?')
    const help = page.getByTestId('present-help-panel')
    await expect(help).toContainText('Space, →, Page Down')
    await expect(help).toContainText('Laser pointer')
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden()
    await expect(overlay(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(overlay(page)).toBeHidden()
  })

  test('a focused control keeps Space and Enter for itself', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await page.getByTestId('present-loop').focus()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('present-loop')).toHaveAttribute('aria-pressed', 'true')
    await expect(counter(page)).toHaveText('1 / 3')
  })

  test('the controls are named and reachable by keyboard', async ({ page }) => {
    await openDeck(page)
    await present(page)
    const toolbar = page.getByRole('toolbar', { name: 'Presentation controls' })
    await expect(toolbar).toBeVisible()
    for (const name of [/^Previous page$/, /^Next page$/, /^Auto-advance$/, /^Loop$/, /^Start again from the first page$/, /^Laser pointer$/, /^Black screen$/, /^Speaker notes$/, /^Presenter view$/, /^Full screen$/, /^Keyboard shortcuts$/, /^Exit presentation$/]) {
      await expect(toolbar.getByRole('button', { name })).toBeVisible()
    }
    // Tab stays inside the presentation.
    for (let i = 0; i < 30; i++) await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="present-overlay"]') !== null)).toBe(true)
  })
})

test.describe('[layout] present: pointer', () => {
  test('a click on the right moves forward, on the left edge back', async ({ page }) => {
    await openDeck(page)
    await present(page)
    const stage = await box(page.getByTestId('present-stage'))
    await page.mouse.click(stage.x + stage.width * 0.7, stage.y + stage.height * 0.4)
    await expect(counter(page)).toHaveText('2 / 3')
    await page.mouse.click(stage.x + stage.width * 0.1, stage.y + stage.height * 0.4)
    await expect(counter(page)).toHaveText('1 / 3')
    await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.4)
    await expect(counter(page)).toHaveText('2 / 3')
  })

  test('a swipe moves a page: left goes forward, right goes back', async ({ page }) => {
    await openDeck(page)
    await present(page)
    const stage = await box(page.getByTestId('present-stage'))
    const y = stage.y + stage.height * 0.4
    await page.mouse.move(stage.x + 700, y)
    await page.mouse.down()
    await page.mouse.move(stage.x + 520, y + 10, { steps: 6 })
    await page.mouse.up()
    await expect(counter(page)).toHaveText('2 / 3')
    await page.mouse.move(stage.x + 400, y)
    await page.mouse.down()
    await page.mouse.move(stage.x + 600, y, { steps: 6 })
    await page.mouse.up()
    await expect(counter(page)).toHaveText('1 / 3')
  })

  test('a tap on a touch screen moves forward', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await context.newPage()
    await openDeck(page)
    await present(page)
    await page.getByRole('button', { name: 'Go to page 1' }).tap()
    await expect(counter(page)).toHaveText('1 / 3')
    await page.getByTestId('present-stage').tap({ position: { x: 300, y: 300 } })
    await expect(counter(page)).toHaveText('2 / 3')
    await context.close()
  })

  test('the timeline jumps to a page', async ({ page }) => {
    await openDeck(page)
    await present(page)
    const timeline = page.getByTestId('present-timeline')
    await expect(timeline.getByRole('button')).toHaveCount(3)
    await timeline.getByRole('button', { name: 'Go to page 3' }).click()
    await expect(counter(page)).toHaveText('3 / 3')
    await expect(timeline.getByRole('button', { name: 'Go to page 3' })).toHaveAttribute('aria-current', 'step')
    await expect(timeline.getByRole('button', { name: 'Go to page 1' })).toHaveAttribute('data-state', 'done')
  })

  test('the laser pointer follows the pointer, and clicks do not turn pages while it is on', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await page.keyboard.press('l')
    await expect(overlay(page)).toHaveAttribute('data-laser', 'true')
    await page.mouse.move(500, 300)
    const dot = page.getByTestId('present-laser-dot')
    await expect(dot).toHaveAttribute('data-seen', '')
    const at = await box(dot)
    expect(Math.abs(at.x + at.width / 2 - 500)).toBeLessThanOrEqual(2)
    expect(Math.abs(at.y + at.height / 2 - 300)).toBeLessThanOrEqual(2)
    await page.mouse.click(900, 300)
    await expect(counter(page)).toHaveText('1 / 3')
    await page.keyboard.press('l')
    await expect(overlay(page)).not.toHaveAttribute('data-laser', 'true')
    await page.mouse.click(900, 300)
    await expect(counter(page)).toHaveText('2 / 3')
  })

  test('holding L shows the laser only while the key is down', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await page.keyboard.down('l')
    await expect(overlay(page)).toHaveAttribute('data-laser', 'true')
    await page.waitForTimeout(500)
    await page.keyboard.up('l')
    await expect(overlay(page)).not.toHaveAttribute('data-laser', 'true')
  })
})

test.describe('[layout] present: end screen', () => {
  test('after the last page, the end screen offers Start again, Back and Exit', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowRight')
    const end = page.getByTestId('present-end')
    await expect(end).toBeVisible()
    await expect(end).toContainText('End of presentation')
    await page.getByTestId('present-end-back').click()
    await expect(end).toHaveCount(0)
    await expect(counter(page)).toHaveText('3 / 3')
    await page.keyboard.press('ArrowRight')
    await page.getByTestId('present-end-restart').click()
    await expect(end).toHaveCount(0)
    await expect(counter(page)).toHaveText('1 / 3')
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowRight')
    await page.getByTestId('present-end-exit').click()
    await expect(overlay(page)).toBeHidden()
  })
})

test.describe('[layout] present: auto-advance on a fake clock', () => {
  async function startTimed(page: Page, seconds: number): Promise<void> {
    await page.clock.install()
    await openDeck(page)
    await setAllTimes(page, seconds)
    await present(page)
    // From here on time only moves when the test says so.
    await page.clock.pauseAt(Date.now() + 200)
  }

  test('a timed design starts with auto-advance on and moves on after each page time', async ({ page }) => {
    await startTimed(page, 2)
    await expect(page.getByTestId('present-auto')).toHaveAttribute('aria-pressed', 'true')
    await expect(counter(page)).toHaveText('1 / 3')
    await page.clock.runFor(1000)
    await expect(counter(page)).toHaveText('1 / 3')
    await expect(page.getByTestId('present-countdown')).toContainText('left')
    await page.clock.runFor(1500)
    await expect(counter(page)).toHaveText('2 / 3')
    await page.clock.runFor(2200)
    await expect(counter(page)).toHaveText('3 / 3')
    await page.clock.runFor(2200)
    await expect(page.getByTestId('present-end')).toBeVisible()
  })

  test('P pauses and resumes the countdown', async ({ page }) => {
    await startTimed(page, 2)
    await page.keyboard.press('p')
    await expect(page.getByTestId('present-pause')).toHaveAccessibleName('Resume auto-advance')
    await expect(page.getByTestId('present-countdown')).toHaveText('Paused')
    await page.clock.runFor(10_000)
    await expect(counter(page)).toHaveText('1 / 3')
    await page.keyboard.press('p')
    await expect(page.getByTestId('present-pause')).toHaveAccessibleName('Pause auto-advance')
    await page.clock.runFor(2500)
    await expect(counter(page)).toHaveText('2 / 3')
  })

  test('moving by hand restarts the countdown of the new page', async ({ page }) => {
    await startTimed(page, 3)
    await page.clock.runFor(2000)
    await page.keyboard.press('ArrowRight')
    await expect(counter(page)).toHaveText('2 / 3')
    await page.clock.runFor(2000)
    await expect(counter(page)).toHaveText('2 / 3')
    await page.clock.runFor(1500)
    await expect(counter(page)).toHaveText('3 / 3')
  })

  test('the timeline segment of the current page fills as its time runs out', async ({ page }) => {
    await startTimed(page, 4)
    const current = page.getByTestId('present-timeline').getByRole('button', { name: 'Go to page 1' }).locator('span')
    await page.clock.runFor(2000)
    const scale = await current.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
    expect(scale).toBeGreaterThan(0.3)
    expect(scale).toBeLessThan(0.8)
  })

  test('Restart goes back to the first page with fresh clocks', async ({ page }) => {
    await startTimed(page, 2)
    await page.clock.runFor(2500)
    await expect(counter(page)).toHaveText('2 / 3')
    await page.keyboard.press('r')
    await expect(counter(page)).toHaveText('1 / 3')
    await page.clock.runFor(1000)
    await expect(counter(page)).toHaveText('1 / 3')
  })

  test('Loop wraps to the first page instead of ending', async ({ page }) => {
    await startTimed(page, 1)
    await page.getByTestId('present-loop').click()
    await expect(page.getByTestId('present-loop')).toHaveAttribute('aria-pressed', 'true')
    await page.clock.runFor(3500)
    await expect(page.getByTestId('present-end')).toHaveCount(0)
    await expect(counter(page)).toHaveText('1 / 3')
  })

  test('a page without a time waits for the presenter when others have one', async ({ page }) => {
    await page.clock.install()
    await openDeck(page)
    await page.locator('section[data-page-id]').first().getByTestId('ed-time-chip').click()
    await page.getByTestId('ed-time-input').fill('1')
    await page.getByTestId('ed-time-input').press('Enter')
    await page.keyboard.press('Escape')
    await present(page)
    await page.clock.pauseAt(Date.now() + 200)
    await page.clock.runFor(1500)
    await expect(counter(page)).toHaveText('2 / 3')
    await expect(page.getByTestId('present-countdown')).toHaveText('Waits for you')
    await page.clock.runFor(30_000)
    await expect(counter(page)).toHaveText('2 / 3')
  })

  test('an untimed design can still be played: auto-advance uses 5 s per page', async ({ page }) => {
    await page.clock.install()
    await openDeck(page)
    await present(page)
    await expect(page.getByTestId('present-auto')).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('present-auto').click()
    await expect(page.getByTestId('present-auto')).toHaveAttribute('aria-pressed', 'true')
    await page.clock.pauseAt(Date.now() + 200)
    await page.clock.runFor(4000)
    await expect(counter(page)).toHaveText('1 / 3')
    await page.clock.runFor(1500)
    await expect(counter(page)).toHaveText('2 / 3')
  })

  test('the black screen holds the countdown', async ({ page }) => {
    await startTimed(page, 2)
    await page.keyboard.press('b')
    await page.clock.runFor(10_000)
    await expect(counter(page)).toHaveText('1 / 3')
    await page.keyboard.press('b')
    await page.clock.runFor(2500)
    await expect(counter(page)).toHaveText('2 / 3')
  })
})

test.describe('[layout] present: motion and fonts', () => {
  test('prefers-reduced-motion removes the transitions of the controls and the timeline', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openDeck(page)
    await present(page)
    const durations = await page.evaluate(() => ({
      controls: getComputedStyle(document.querySelector('[data-testid="present-controls"]') as Element).transitionDuration,
      fill: getComputedStyle(document.querySelector('[data-testid="present-timeline"] span') as Element).transitionDuration,
    }))
    // The editor's own reduced-motion rule makes every duration 0.01 ms; the presentation's rules make them 0.
    for (const value of [durations.controls, durations.fill]) expect(Number.parseFloat(value)).toBeLessThan(0.001)
  })

  test('the stage waits for the page to be rendered and shows a placeholder of its shape meanwhile', async ({ page }) => {
    await openDeck(page)
    await present(page)
    await page.keyboard.press('End')
    await ready(page)
    const pixels = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="present-frame"]') as HTMLCanvasElement
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      const d = ctx.getImageData(5, 5, 1, 1).data
      return [d[0], d[1], d[2], d[3]]
    })
    // The third page has a near-black background (#1c1517), so the bitmap is really painted.
    expect(pixels[3]).toBe(255)
    expect(pixels[0]).toBeLessThan(60)
  })
})
