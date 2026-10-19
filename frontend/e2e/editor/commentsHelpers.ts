import { type Locator, type Page, expect } from '@playwright/test'
import { getDoc } from './helpers'

/** The Comments button at the right end of the top bar opens the sidebar (and, on a desktop screen, comment mode). */
export async function openComments(page: Page): Promise<void> {
  await page.getByTestId('ed-end-comments').click()
  await expect(page.getByTestId('comments-panel')).toBeVisible()
}

export const pins = (page: Page): Locator => page.locator('[data-testid="comment-pin"]')
export const surfaces = (page: Page): Locator => page.locator('[data-testid="comment-surface"]')

/** Client coordinates of a point of page `index`, using that page's own size (pages of one design may differ). */
export async function toClient(page: Page, x: number, y: number, index = 0): Promise<{ x: number; y: number }> {
  const doc = await getDoc(page)
  const size = doc.pages[index] as { width?: number }
  const box = await page.locator('[data-artboard]').nth(index).boundingBox()
  if (!box) throw new Error('artboard not found')
  const zoom = box.width / (size.width ?? doc.width)
  return { x: box.x + x * zoom, y: box.y + y * zoom }
}

/** The pin of the thread that starts with `text`. */
export const pinWith = (page: Page, text: string | RegExp): Locator => page.getByRole('button', { name: new RegExp(`: ${typeof text === 'string' ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : text.source}`) })

/** The tip of a pin (where it points): the bottom-left corner of its box. */
export async function tipOf(pin: Locator): Promise<{ x: number; y: number }> {
  const box = await pin.boundingBox()
  if (!box) throw new Error('the pin is not on the screen')
  return { x: box.x, y: box.y + box.height }
}

/** Waits until the pin points at the point (x, y) of page `index`, whatever the zoom and scroll position are by now. */
export async function expectTip(page: Page, pin: Locator, x: number, y: number, index = 0, tolerance = 1.25): Promise<void> {
  await expect
    .poll(
      async () => {
        const tip = await tipOf(pin)
        const want = await toClient(page, x, y, index)
        return Math.max(Math.abs(tip.x - want.x), Math.abs(tip.y - want.y))
      },
      { message: `the pin should point at page ${index + 1} (${x}, ${y})` },
    )
    .toBeLessThan(tolerance)
}

/** Clicks a point of page `index` in comment mode, writes the comment and sends it. */
export async function placeComment(page: Page, x: number, y: number, text: string, index = 0): Promise<void> {
  const target = await toClient(page, x, y, index)
  const before = await pins(page).count()
  await page.mouse.click(target.x, target.y)
  await expect(page.getByTestId('pin-draft-card')).toBeVisible()
  await page.getByTestId('pin-compose-text').fill(text)
  await page.getByTestId('pin-compose-send').click()
  await expect(pins(page)).toHaveCount(before + 1)
}

/** What the in-memory service holds right now. */
export async function stored(page: Page): Promise<{ id: string; body: string; page_id: string | null; x: number | null; y: number | null; resolved: boolean; parent: string | null }[]> {
  return page.evaluate(() => window.__doory!.comments.snapshot().map((c) => ({ id: c.id, body: c.body, page_id: c.page_id, x: c.x, y: c.y, resolved: c.resolved, parent: c.parent })))
}

export const calls = (page: Page): Promise<string[]> => page.evaluate(() => [...window.__doory!.comments.calls])
