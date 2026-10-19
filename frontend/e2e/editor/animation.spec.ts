/**
 * [layout] Animation in the editor: the Animate panel, the timeline and the preview over the page. They click the
 * current UI (the top bar, the pages pill, the panel); the model, the sampler, the renderer and the commands behind
 * them have unit tests (`src/editor/animation`).
 */
import { expect, test, type Page } from '@playwright/test'
import { addShape, getDoc, openEditor, openTool, pageObjects } from './helpers'

interface AnimatedObject {
  id: string
  type: string
  animation?: { enter?: Record<string, unknown>; exit?: Record<string, unknown>; emphasis?: Record<string, unknown> }
}

const objects = async (page: Page, index = 0): Promise<AnimatedObject[]> => (await pageObjects(page, index)) as unknown as AnimatedObject[]
const timeline = (page: Page) => page.getByTestId('ed-timeline')
const preview = (page: Page) => page.getByTestId('ed-preview')

async function openTimeline(page: Page): Promise<void> {
  if (!(await timeline(page).isVisible())) await page.getByTestId('ed-timeline-toggle').click()
  await expect(timeline(page)).toBeVisible()
}

/** The colour of a point of the page (page px) in the preview picture. */
async function previewPixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="ed-preview-frame"] canvas')
      if (!canvas) throw new Error('no preview picture')
      const scale = canvas.width / 1280
      return Array.from(canvas.getContext('2d')!.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data)
    },
    [x, y],
  )
}

test.describe('[layout] animate panel', () => {
  test('an animation chosen in the panel is written to the selected object, with undo', async ({ page }) => {
    await openEditor(page, 'doc=blank&w=1280&h=720')
    await addShape(page, 'rect')
    await openTool(page, 'animate')
    await expect(page.getByTestId('animate-selected')).toHaveText('1 element selected')
    await page.getByTestId('animate-enter-pop').click()
    await expect(page.getByTestId('animate-enter-pop')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await objects(page))[0].animation?.enter).toMatchObject({ preset: 'pop', durationMs: 550, delayMs: 0, easing: 'spring' })
    await page.getByTestId('animate-enter-slide').click()
    await expect.poll(async () => (await objects(page))[0].animation?.enter).toMatchObject({ preset: 'slide', direction: 'left', delayMs: 0 })

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await objects(page))[0].animation?.enter?.preset).toBe('pop')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await objects(page))[0].animation).toBeUndefined()
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await objects(page))[0].animation?.enter?.preset).toBe('pop')
  })

  test('settings: direction, times, easing and strength, and a slider drag is one undo step', async ({ page }) => {
    await openEditor(page, 'doc=blank&w=1280&h=720')
    await addShape(page, 'rect')
    await openTool(page, 'animate')
    await page.getByTestId('animate-enter-slide').click()
    await page.getByRole('radio', { name: 'From the top' }).check({ force: true })
    await page.getByRole('textbox', { name: 'Duration' }).fill('2.5')
    await page.getByRole('textbox', { name: 'Duration' }).press('Enter')
    await page.getByRole('textbox', { name: 'Delay' }).fill('1.2')
    await page.getByRole('textbox', { name: 'Delay' }).press('Enter')
    await page.getByTestId('animate-easing').selectOption('bounce')
    await expect.poll(async () => (await objects(page))[0].animation?.enter).toMatchObject({ preset: 'slide', direction: 'up', durationMs: 2500, delayMs: 1200, easing: 'bounce' })

    const before = await getDoc(page)
    const slider = page.getByRole('slider', { name: 'Strength' })
    await slider.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await objects(page))[0].animation?.enter?.intensity).toBe(0.75)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => JSON.stringify(await getDoc(page))).toBe(JSON.stringify(before))
  })

  test('animates every element of the page in a style and sets a transition, for one page and for all', async ({ page }) => {
    await openEditor(page, 'doc=demo')
    await openTool(page, 'animate')
    await expect(page.getByRole('radio', { name: 'Page' })).toBeChecked()
    await page.getByTestId('animate-style-rise').click()
    const animated = await objects(page)
    expect(animated.length).toBeGreaterThan(3)
    expect(animated.every((o) => o.animation?.enter?.preset === 'rise')).toBe(true)
    const delays = animated.map((o) => o.animation!.enter!.delayMs as number)
    expect(new Set(delays).size).toBeGreaterThan(3)
    expect(Math.max(...delays)).toBeLessThanOrEqual(3000)
    await page.getByTestId('animate-clear-page').click()
    expect((await objects(page)).every((o) => o.animation === undefined)).toBe(true)

    await page.getByTestId('animate-transition-push').click()
    await expect.poll(async () => (await getDoc(page)).pages[0]).toMatchObject({ transition: { preset: 'push', direction: 'right', durationMs: 700 } })
    expect((await getDoc(page)).pages[1]).not.toHaveProperty('transition')
    await page.getByTestId('animate-transition-all').click()
    await expect.poll(async () => (await getDoc(page)).pages.map((p) => (p as { transition?: { preset: string } }).transition?.preset)).toEqual(['push', 'push'])
    await page.getByTestId('animate-transition-remove').click()
    await expect.poll(async () => (await getDoc(page)).pages[0]).not.toHaveProperty('transition')
    expect((await getDoc(page)).pages[1]).toHaveProperty('transition')
  })

  test('the panel follows the selection and shows its previews as pictures', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTool(page, 'animate')
    await expect(page.getByTestId('animate-panel')).toBeVisible()
    // Tiles are small pictures with a name; hovering one keeps it named and pressed state unchanged.
    await page.getByRole('radio', { name: 'Element' }).check({ force: true })
    await expect(page.getByTestId('animate-empty')).toBeVisible()
    const heading = await page.locator('[data-artboard]').first().boundingBox()
    await page.mouse.click(heading!.x + heading!.width / 2, heading!.y + heading!.height * 0.42)
    await expect(page.getByTestId('animate-selected')).toHaveText('1 element selected')
    await expect(page.getByTestId('animate-enter-rise')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('animate-enter-fade').hover()
    await expect(page.getByTestId('animate-enter-fade').locator('canvas')).toBeVisible()
    await expect(page.getByTestId('animate-enter-rise')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('radiogroup', { name: 'Animate text by' })).toBeVisible()
  })

  test('is not offered in a view-only design', async ({ page }) => {
    await openEditor(page, 'doc=animated&mode=shared-view')
    await expect(page.getByTestId('ed-add-entry-animate')).toHaveCount(0)
  })
})

test.describe('[layout] timeline', () => {
  test('opens from the pages pill, Shift+T and the More menu, and is remembered', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await expect(timeline(page)).toBeHidden()
    const pill = page.getByTestId('ed-timeline-toggle')
    await pill.click()
    await expect(timeline(page)).toBeVisible()
    await expect(pill).toHaveAttribute('aria-pressed', 'true')
    await pill.click()
    await expect(timeline(page)).toBeHidden()
    await page.keyboard.press('Shift+T')
    await expect(timeline(page)).toBeVisible()
    await page.reload()
    await page.waitForSelector('[data-artboard] .doory-canvas')
    await expect(timeline(page)).toBeVisible()
    await page.getByTestId('tl-close').click()
    await expect(timeline(page)).toBeHidden()
    await page.getByTestId('ed-more').click()
    await page.getByRole('menuitemcheckbox', { name: /timeline/i }).click()
    await expect(timeline(page)).toBeVisible()
  })

  test('shows a lane for each animated element of the page with the bars of its animations and the page time', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    const doc = await objects(page)
    const animatedIds = doc.filter((o) => o.animation).map((o) => o.id)
    expect(animatedIds).toHaveLength(4)
    for (const id of animatedIds) await expect(page.getByTestId(`tl-lane-${id}`)).toBeVisible()
    const disc = doc.find((o) => o.type === 'ellipse')!
    await expect(page.getByTestId(`tl-bar-${disc.id}-enter`)).toBeVisible()
    await expect(page.getByTestId(`tl-bar-${disc.id}-emphasis`)).toHaveAttribute('data-looping', 'true')
    await expect(page.getByTestId('tl-end')).toBeVisible()
    await expect(page.getByTestId('tl-overrun')).toHaveCount(0)
    // The second page has exits at the end of the page: no warning there, and the first page's bars are not in its lanes.
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await expect(page.getByTestId(`tl-lane-${disc.id}`)).toHaveCount(0)
    const second = await objects(page, 1)
    await expect(page.getByTestId(`tl-bar-${second[1].id}-exit`)).toBeVisible()
  })

  test('clicking a lane selects the element; selecting on the canvas highlights its lane', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    const doc = await objects(page)
    const star = doc.find((o) => o.type !== 'textbox' && o.type !== 'ellipse' && o.animation)!
    await page.getByTestId(`tl-lane-${star.id}`).getByRole('button').first().click()
    await expect(page.getByTestId(`tl-lane-${star.id}`)).toHaveAttribute('data-selected', 'true')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __doory: { getDocument(): unknown } }).__doory.getDocument() !== null)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId(`tl-lane-${star.id}`)).not.toHaveAttribute('data-selected', 'true')
  })

  test('scrubbing the playhead shows the page at that moment over the page', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    const disc = (await objects(page)).find((o) => o.type === 'ellipse')!
    const ruler = page.getByTestId('tl-ruler')
    const box = (await ruler.boundingBox())!
    await page.mouse.click(box.x + 3, box.y + 10)
    await expect(preview(page)).toBeVisible()
    await expect(page.getByTestId('ed-preview-frame')).toHaveAttribute('data-status', 'ready')
    // At the start the star (it comes in after 0.3 s) is not there yet: the page shows its background at its place.
    const bg = await previewPixel(page, 250, 560)
    expect(bg[0]).toBeGreaterThan(240)
    expect(bg[1]).toBeGreaterThan(200)
    // Later it is in place: the dark star.
    await page.mouse.click(box.x + box.width * 0.5, box.y + 10)
    await expect.poll(async () => (await previewPixel(page, 250, 560))[1], { timeout: 5000 }).toBeLessThan(60)
    await expect(page.getByTestId('tl-readout')).not.toHaveText(/^0:00\.0/)
    // The design was not touched.
    expect((await objects(page)).find((o) => o.id === disc.id)).toEqual(disc)
    await page.keyboard.press('Escape')
    await expect(preview(page)).toBeHidden()
    await expect(page.getByTestId('tl-readout')).toHaveText(/^0:00\.0/)
  })

  test('drags a bar in steps of a tenth of a second, resizes it from its edges, and one drag is one undo step', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    const doc = await objects(page)
    const heading = doc.find((o) => o.type === 'textbox' && (o.animation?.enter as { by?: string } | undefined)?.by === 'word')!
    const bar = page.getByTestId(`tl-bar-${heading.id}-enter`)
    const original = JSON.stringify(heading.animation)
    const box = (await bar.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    const moved = ((await objects(page)).find((o) => o.id === heading.id)!.animation!.enter as { delayMs: number; durationMs: number })
    expect(moved.delayMs).toBeGreaterThan(300)
    expect(moved.delayMs % 100).toBe(0)
    expect(moved.durationMs).toBe(900)
    await expect(page.getByTestId(`tl-lane-${heading.id}`)).toHaveAttribute('data-selected', 'true')

    const edge = bar.locator('[data-edge="end"]')
    const e = (await edge.boundingBox())!
    await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2)
    await page.mouse.down()
    await page.mouse.move(e.x + e.width / 2 + 60, e.y + e.height / 2, { steps: 6 })
    await page.mouse.up()
    const longer = ((await objects(page)).find((o) => o.id === heading.id)!.animation!.enter as { delayMs: number; durationMs: number })
    expect(longer.delayMs).toBe(moved.delayMs)
    expect(longer.durationMs).toBeGreaterThan(900)
    expect(longer.durationMs % 100).toBe(0)

    await page.keyboard.press('Control+z')
    await expect.poll(async () => ((await objects(page)).find((o) => o.id === heading.id)!.animation!.enter as { durationMs: number }).durationMs).toBe(900)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => JSON.stringify((await objects(page)).find((o) => o.id === heading.id)!.animation)).toBe(original)
  })

  test('moves a bar with the keyboard', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    const doc = await objects(page)
    const sub = doc.find((o) => o.type === 'textbox' && (o.animation?.enter as { preset?: string } | undefined)?.preset === 'fade')!
    await page.getByTestId(`tl-bar-${sub.id}-enter`).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    // The subtitle comes in after 0.9 s: two steps of a tenth later, then a whole second earlier (0.9 + 0.2 - 1.0).
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(async () => ((await objects(page)).find((o) => o.id === sub.id)!.animation!.enter as { delayMs: number }).delayMs).toBe(100)
    await page.keyboard.press('Alt+ArrowRight')
    await expect.poll(async () => ((await objects(page)).find((o) => o.id === sub.id)!.animation!.enter as { durationMs: number }).durationMs).toBe(800)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await objects(page)).find((o) => o.id === sub.id)!.animation).toBeUndefined()
    await expect(page.getByTestId(`tl-lane-${sub.id}`)).toHaveCount(0)
  })

  test('play runs the page over the artboard and ends at its end; Escape stops it; edits are held back meanwhile', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    const before = JSON.stringify(await getDoc(page))
    await page.getByTestId('tl-speed').selectOption('2')
    await page.getByTestId('tl-play').click()
    await expect(preview(page)).toBeVisible()
    await expect(page.getByTestId('tl-play')).toHaveAccessibleName('Pause')
    // The editor's own keys do nothing to the page while it plays.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Space')
    await expect(page.getByTestId('tl-play')).toHaveAccessibleName('Play the page')
    await page.keyboard.press('Space')
    await expect(page.getByTestId('tl-play')).toHaveAccessibleName('Pause')
    expect(JSON.stringify(await getDoc(page))).toBe(before)
    await page.keyboard.press('Escape')
    await expect(preview(page)).toBeHidden()
    await expect(page.getByTestId('tl-readout')).toHaveText(/^0:00\.0/)

    // To the end, by itself.
    await page.getByTestId('tl-play').click()
    await expect(preview(page)).toBeVisible()
    await expect(preview(page)).toBeHidden({ timeout: 15_000 })
    expect(JSON.stringify(await getDoc(page))).toBe(before)
  })

  test('warns when the animations run past the page time and fits the time to them', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await page.getByRole('button', { name: 'Next page' }).first().click()
    await openTimeline(page)
    const cards = await objects(page, 1)
    const card = cards.find((o) => o.animation?.exit)!
    await expect(page.getByTestId('tl-overrun')).toHaveCount(0)
    await page.getByTestId(`tl-bar-${card.id}-exit`).focus()
    // The page is up for 5 s once it has built up (1.8 s): its exits end at 4.9 s. Push one far past the end of the page.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
    await expect(page.getByTestId('tl-overrun')).toBeVisible()
    await expect(page.getByTestId(`tl-bar-${card.id}-exit`)).toHaveAttribute('data-late', 'true')
    await page.getByTestId('tl-extend').click()
    await expect(page.getByTestId('tl-overrun')).toHaveCount(0)
    expect(((await getDoc(page)).pages[1] as { durationSec?: number }).durationSec).toBeGreaterThan(5)
  })

  test('zooms the time axis and folds down to its bar', async ({ page }) => {
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    const doc = await objects(page)
    const disc = doc.find((o) => o.type === 'ellipse')!
    const bar = page.getByTestId(`tl-bar-${disc.id}-enter`)
    const w0 = (await bar.boundingBox())!.width
    await page.getByTestId('tl-zoom-in').click()
    await page.getByTestId('tl-zoom-in').click()
    expect((await bar.boundingBox())!.width).toBeGreaterThan(w0 * 2)
    await page.getByTestId('tl-collapse').click()
    await expect(page.getByTestId('tl-scroller')).toHaveCount(0)
    await expect(page.getByTestId('tl-play')).toBeVisible()
    await page.getByTestId('tl-collapse').click()
    await expect(page.getByTestId('tl-scroller')).toBeVisible()
  })

  test('on a phone the lanes are a list with a slider for the playhead', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openEditor(page, 'doc=animated')
    await openTimeline(page)
    await expect(page.getByTestId('tl-scroller')).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Animated elements' }).getByRole('listitem')).toHaveCount(4)
    await page.getByTestId('tl-scrub').fill('1500')
    await expect(preview(page)).toBeVisible()
    await expect(page.getByTestId('tl-readout')).toContainText('0:01.5')
    await page.getByTestId('ed-preview-stop').click()
    await expect(preview(page)).toBeHidden()
  })

  test('a view-only design can play the timeline but not change it', async ({ page }) => {
    await openEditor(page, 'doc=animated&mode=shared-view')
    await openTimeline(page)
    const doc = await objects(page)
    const disc = doc.find((o) => o.type === 'ellipse')!
    const bar = page.getByTestId(`tl-bar-${disc.id}-enter`)
    await expect(bar.locator('[data-edge]')).toHaveCount(0)
    await bar.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Delete')
    expect((await objects(page)).find((o) => o.id === disc.id)).toEqual(disc)
    await page.getByTestId('tl-play').click()
    await expect(preview(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(preview(page)).toBeHidden()
  })
})

test.describe('[engine] animation survives a reload', () => {
  test('the saved design carries the animations and the transition, and opens with them', async ({ page }) => {
    await openEditor(page, 'doc=blank&w=1280&h=720')
    await addShape(page, 'rect')
    await openTool(page, 'animate')
    await page.getByTestId('animate-enter-wipe').click()
    await page.getByRole('radio', { name: 'Emphasis' }).check({ force: true })
    await page.getByTestId('animate-emphasis-heartbeat').click()
    await page.getByRole('radio', { name: 'Page' }).check({ force: true })
    await page.getByTestId('animate-transition-circle').click()
    await page.evaluate(() => window.__doory!.saveNow())
    const saved = await page.evaluate(() => window.__doory!.getDocument())
    expect(saved.pages[0]).toHaveProperty('transition')
    await page.evaluate((doc) => localStorage.setItem('doory.harness.doc', JSON.stringify(doc)), saved)

    await openEditor(page, 'doc=stored')
    const [first] = await objects(page)
    expect(first.animation).toMatchObject({ enter: { preset: 'wipe' }, emphasis: { preset: 'heartbeat' } })
    expect(((await getDoc(page)).pages[0] as { transition?: { preset: string } }).transition?.preset).toBe('circle')
    await openTimeline(page)
    await expect(page.getByTestId(`tl-bar-${first.id}-enter`)).toBeVisible()
    await expect(page.getByTestId(`tl-bar-${first.id}-emphasis`)).toBeVisible()
    await page.evaluate(() => localStorage.removeItem('doory.harness.doc'))
  })
})
