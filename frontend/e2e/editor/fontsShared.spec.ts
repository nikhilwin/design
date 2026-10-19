/**
 * [layout] Uploaded fonts away from the owner's editor: a shared link carries the owner's fonts that the design uses (and
 * degrades with a warning when it does not), and the dashboard's Brand page manages the same library.
 */
import { type Page, expect, test } from '@playwright/test'
import { installMockApi, makeUser } from '../support/mockApi'
import { FakeFontServer, fixture, openDesign, settledInk } from './fontsApi'
import { addText } from './helpers'

const REGULAR = fixture('DooryBlocks-Regular.ttf')

async function setup(page: Page) {
  const state = await installMockApi(page)
  state.user = makeUser()
  const fonts = new FakeFontServer()
  await fonts.install(page)
  return { state, fonts }
}

/** A design whose heading is set in the uploaded family, as the server stored it. */
async function designWithUploadedFont(page: Page, state: Awaited<ReturnType<typeof setup>>['state'], fonts: FakeFontServer): Promise<Record<string, unknown>> {
  await fonts.seed('DooryBlocks-Regular.ttf')
  await openDesign(page)
  await addText(page, 'heading')
  await page.keyboard.press('Escape')
  await page.getByTestId('ed-font').click()
  await page.locator('[data-font="Doory Blocks"]').click()
  await expect.poll(() => JSON.stringify(state.designs.find((d) => d.id === 'design-1')?.document), { timeout: 15_000 }).toContain('Doory Blocks')
  return state.designs.find((d) => d.id === 'design-1')?.document ?? {}
}

async function shareDesign(page: Page, document: Record<string, unknown>, fonts: Record<string, unknown>[], role: 'view' | 'edit' = 'view'): Promise<void> {
  await page.route('**/api/v1/shared/tok/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ role, title: 'Shared poster', width: 1080, height: 1080, revision: 1, owner: { name: 'Grace Hopper', avatar_url: null }, document, fonts }),
    }),
  )
}

test.describe('[layout] uploaded fonts in shared designs and on the dashboard', () => {
  test('a view link draws the text in the owner’s font, and warns when the link does not carry it', async ({ page }) => {
    const { state, fonts } = await setup(page)
    const document = await designWithUploadedFont(page, state, fonts)
    const owners = fonts.families.map((f) => fonts.describe(f))

    await shareDesign(page, document, owners)
    await page.goto('/s/tok')
    await page.waitForSelector('[data-artboard] .doory-canvas', { timeout: 20_000 })
    const withFont = await settledInk(page)
    await page.waitForTimeout(900)
    await expect(page.getByTestId('missing-fonts')).toHaveCount(0)

    await page.unroute('**/api/v1/shared/tok/')
    await shareDesign(page, document, [])
    await page.goto('/s/tok')
    await page.waitForSelector('[data-artboard] .doory-canvas', { timeout: 20_000 })
    const notice = page.getByTestId('missing-fonts')
    await expect(notice).toContainText('Doory Blocks')
    await expect(notice).toContainText('fallback font')
    await expect(notice.getByTestId('missing-fonts-upload')).toHaveCount(0)
    expect(await settledInk(page)).toBeLessThan(withFont * 0.7)
    await notice.getByTestId('missing-fonts-dismiss').click()
    await expect(notice).toHaveCount(0)
  })

  test('an edit link offers the design’s fonts to the collaborator, without an upload row', async ({ page }) => {
    const { state, fonts } = await setup(page)
    const document = await designWithUploadedFont(page, state, fonts)
    await shareDesign(page, document, fonts.families.map((f) => fonts.describe(f)), 'edit')
    await page.goto('/s/tok')
    await page.waitForSelector('[data-artboard] .doory-canvas', { timeout: 20_000 })
    // Select everything on the page (the heading is its only object) to get the text tools.
    await page.mouse.click(200, 400)
    await page.keyboard.press('Control+a')
    await page.getByTestId('ed-font').click()
    await expect(page.locator('[data-font="Doory Blocks"]')).toHaveAttribute('data-group', 'shared')
    await expect(page.getByText('Fonts of this design')).toBeVisible()
    await expect(page.getByTestId('font-upload-row')).toHaveCount(0)
  })

  test('the Brand page lists, uploads and deletes the same fonts', async ({ page }) => {
    const { fonts } = await setup(page)
    await fonts.seed('DooryDiamonds-Regular.woff2')
    await page.goto('/dashboard/brand')
    const diamonds = page.locator('[data-testid="your-font"][data-family="Doory Diamonds"]')
    await expect(diamonds).toContainText('1 style: Regular')

    await page.getByRole('button', { name: 'Upload fonts' }).click()
    const dialog = page.getByRole('dialog', { name: 'Upload fonts' })
    await expect(dialog.getByText(/Only upload fonts you made/)).toBeVisible()
    await dialog.getByTestId('font-file-input').setInputFiles([REGULAR, fixture('DooryBlocks-Bold.ttf')])
    await expect(dialog.getByTestId('font-upload-item').first()).toContainText('Regular')
    await dialog.getByRole('button', { name: 'Upload 2 fonts' }).click()
    await expect(dialog.getByText('2 fonts uploaded')).toBeVisible()
    await dialog.getByRole('button', { name: 'Done' }).click()
    const blocks = page.locator('[data-testid="your-font"][data-family="Doory Blocks"]')
    await expect(blocks).toContainText('2 styles: Regular · Bold')

    await page.getByRole('button', { name: 'Delete Doory Diamonds' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete font' }).click()
    await expect(diamonds).toHaveCount(0)
    expect(fonts.deleted).toEqual(['Doory Diamonds'])

    // The family is a choice for the kit's fonts.
    await page.getByRole('button', { name: 'New brand kit' }).first().click()
    await expect(page.getByRole('dialog', { name: 'New brand kit' }).getByLabel('Heading font', { exact: true })).toContainText('Doory Blocks (uploaded)')
  })
})
