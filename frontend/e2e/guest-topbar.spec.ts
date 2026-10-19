import { expect, test } from '@playwright/test'
import { seedLocalDesignWithImage } from './support/helpers'
import { installMockApi } from './support/mockApi'

/**
 * The guest editor's top bar offers two actions side by side: Share and Sign up. Share is the primary
 * button of the bar; Sign up must stay the quieter secondary one, at every width.
 * Set SCREENSHOT_DIR to also write the PNGs used to review it by eye.
 */
const VIEWS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
]

for (const view of VIEWS) {
  for (const theme of ['light'] as const) {
    test(`guest top bar ${view.name} ${theme}: Share is primary, Sign up is secondary`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: theme })
      const page = await context.newPage()
      await installMockApi(page)
      await page.goto('/')
      const { designId } = await seedLocalDesignWithImage(page)
      await page.goto(`/local/${designId}`)
      await expect(page.locator('[data-editor-root]')).toBeVisible()

      const share = page.getByTestId('ed-share')
      const signUp = page.getByRole('button', { name: 'Sign up' })
      await expect(share).toBeVisible()
      await expect(signUp).toBeVisible()
      await expect(signUp).toHaveAttribute('data-variant', 'secondary')

      const background = (locator: typeof share) => locator.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(await background(share)).not.toBe(await background(signUp))

      const a = await share.boundingBox()
      const b = await signUp.boundingBox()
      if (!a || !b) throw new Error('top bar buttons have no box')
      const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(overlaps).toBe(false)

      const out = process.env.SCREENSHOT_DIR
      if (out) {
        await page.waitForTimeout(500)
        await page.screenshot({ path: `${out}/guest-topbar-${view.name}-${theme}.png`, clip: { x: 0, y: 0, width: view.width, height: view.name === '390' ? 140 : 80 } })
      }
      await context.close()
    })
  }
}

for (const view of VIEWS) {
  test(`the guest editor fills the ${view.name} px window: the workspace and the page are there`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: view.width, height: view.height } })
    const page = await context.newPage()
    await installMockApi(page)
    await page.goto('/')
    const { designId } = await seedLocalDesignWithImage(page)
    await page.goto(`/local/${designId}`)
    const editor = page.locator('[data-editor-root]')
    await expect(editor).toBeVisible()
    await expect(page.locator('[data-artboard]').first()).toBeVisible()
    const box = await editor.boundingBox()
    if (!box) throw new Error('the editor has no box')
    expect(box.height).toBeGreaterThanOrEqual(view.height - 1)
    const artboard = await page.locator('[data-artboard]').first().boundingBox()
    if (!artboard) throw new Error('the page has no box')
    expect(artboard.y + artboard.height).toBeLessThanOrEqual(view.height)
    expect(artboard.width).toBeGreaterThan(100)
    await context.close()
  })
}
