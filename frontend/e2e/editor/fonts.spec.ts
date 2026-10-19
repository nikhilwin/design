/**
 * [layout] Uploaded fonts end to end: upload in the dialog, find the family in the font list, apply it to text, reload,
 * export (SVG and the server PDF) and delete. The app runs against the fake API of `e2e/support/mockApi.ts` plus
 * `fontsApi.ts` (the font endpoints and the font files); the fonts are generated, see `fixtures/fonts/make_fonts.py`.
 */
import { type Page, expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { installMockApi, makeUser } from '../support/mockApi'
import { FakeFontServer, fixture, longestDarkRun, openDesign, openUploadDialog, pageInk, settledInk } from './fontsApi'
import { addText, openDownloadDialog, openEditor, openTool } from './helpers'

const REGULAR = fixture('DooryBlocks-Regular.ttf')
const BOLD = fixture('DooryBlocks-Bold.ttf')
const ITALIC = fixture('DooryBlocks-Italic.ttf')

async function setup(page: Page, options: { serverPdf?: boolean } = {}) {
  const state = await installMockApi(page)
  state.user = makeUser()
  if (options.serverPdf) state.config = { ...state.config, features: { ...(state.config.features as Record<string, boolean>), server_pdf: true } }
  const fonts = new FakeFontServer()
  await fonts.install(page)
  return { state, fonts }
}

/** The text of the design in the saved document: what the server would load next time. */
const savedText = (state: Awaited<ReturnType<typeof setup>>['state']): string => JSON.stringify(state.designs.find((d) => d.id === 'design-1')?.document)

test.describe('[layout] uploaded fonts', () => {
  test('upload → listed first in the font list → applied to text → still there after a reload → in the PNG, the SVG and the server PDF', async ({ page }) => {
    const { state, fonts } = await setup(page, { serverPdf: true })
    await openDesign(page)
    await addText(page, 'heading')
    await page.keyboard.press('Escape')
    const plain = await pageInk(page)

    // Nothing uploaded yet: no group, but the upload row.
    await page.getByTestId('ed-font').click()
    await expect(page.getByTestId('font-picker')).toBeVisible()
    await expect(page.locator('[data-group="mine"]')).toHaveCount(0)
    await page.getByTestId('font-upload-row').click()
    await expect(page.getByTestId('font-picker')).toHaveCount(0)

    const dialog = page.getByRole('dialog', { name: 'Upload fonts' })
    await expect(dialog.getByTestId('font-licence')).toContainText('licence')
    await dialog.getByTestId('font-file-input').setInputFiles([REGULAR, BOLD, ITALIC])
    const rows = dialog.getByTestId('font-upload-item')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Doory Blocks')
    await expect(rows.nth(0)).toContainText('Regular')
    await expect(rows.nth(1)).toContainText('Bold')
    await expect(rows.nth(2)).toContainText('Italic')
    await expect(dialog.getByTestId('font-family-input')).toHaveAttribute('placeholder', 'Doory Blocks')
    await dialog.getByTestId('font-upload-submit').click()
    await expect(dialog.getByTestId('font-upload-success')).toContainText('3 fonts uploaded')
    expect(fonts.uploads.map((u) => u.files)).toEqual([['DooryBlocks-Regular.ttf'], ['DooryBlocks-Bold.ttf'], ['DooryBlocks-Italic.ttf']])
    await dialog.getByTestId('font-upload-close').click()
    await expect(dialog).toHaveCount(0)

    // "Your fonts" is the first group; picking the family applies it to the selected text.
    await page.getByTestId('ed-font').click()
    const option = page.locator('[data-font="Doory Blocks"]')
    await expect(option).toHaveAttribute('data-group', 'mine')
    await expect(page.getByRole('option').first()).toHaveAttribute('data-font', 'Doory Blocks')
    await option.click()
    await expect.poll(() => pageInk(page)).toBeGreaterThan(plain * 1.6)
    await expect(page.getByTestId('ed-font')).toContainText('Doory Blocks')

    // Saved with the document, and loaded again from the library when the design is reopened.
    await expect.poll(() => savedText(state), { timeout: 15_000 }).toContain('Doory Blocks')
    await page.reload()
    await page.waitForSelector('[data-artboard] .doory-canvas', { timeout: 20_000 })
    await expect.poll(() => pageInk(page)).toBeGreaterThan(plain * 1.6)
    await page.waitForTimeout(900) // the missing-font notice settles after 400 ms
    await expect(page.getByTestId('missing-fonts')).toHaveCount(0)

    // PNG export waits for the font: the exported text is made of the font's solid glyphs.
    await openDownloadDialog(page)
    const download = page.getByRole('dialog', { name: 'Download' })
    await download.getByRole('radio', { name: /^PNG/ }).check()
    await download.getByRole('radio', { name: 'Current page' }).check()
    const pngDownload = page.waitForEvent('download', { timeout: 30_000 })
    await download.getByRole('button', { name: 'Download', exact: true }).click()
    const png = await readFile(await (await pngDownload).path())
    expect(await longestDarkRun(page, png)).toBeGreaterThan(30)

    // SVG export embeds every file of the family.
    await openDownloadDialog(page)
    await download.getByRole('radio', { name: /^SVG/ }).check()
    await download.getByRole('radio', { name: 'Current page' }).check()
    const svgDownload = page.waitForEvent('download', { timeout: 30_000 })
    await download.getByRole('button', { name: 'Download', exact: true }).click()
    const svg = (await readFile(await (await svgDownload).path())).toString('utf8')
    expect(svg.match(/@font-face\{font-family:"Doory Blocks";font-weight:\d+;font-style:(?:normal|italic);src:url\(data:/g)).toHaveLength(3)

    // The server PDF gets the family, weight, style and URL of the file the text uses.
    let sent: Buffer | null = null
    await page.route('**/api/v1/exports/pdf/', async (route) => {
      sent = route.request().postDataBuffer()
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.7 test' })
    })
    await openDownloadDialog(page)
    await download.getByRole('radio', { name: /Print-quality PDF/ }).check()
    await download.getByRole('radio', { name: 'Current page' }).check()
    const pdfDownload = page.waitForEvent('download', { timeout: 30_000 })
    await download.getByRole('button', { name: 'Download', exact: true }).click()
    await pdfDownload
    const form = (sent as Buffer | null)?.toString('latin1') ?? ''
    const list = /name="fonts"\r\n\r\n(\[.*?\])\r\n/s.exec(form)?.[1] ?? '[]'
    const bold = fonts.families[0].variants.find((v) => v.weight === 700)
    expect(JSON.parse(list)).toEqual([{ family: 'Doory Blocks', url: bold?.path, weight: 700, style: 'normal' }])
  })

  test('"Use" in the upload dialog applies the new font to the selected text, and the text keeps its own weight and style', async ({ page }) => {
    const { fonts } = await setup(page)
    await openDesign(page)
    await addText(page, 'heading')
    await page.keyboard.press('Escape')
    const plain = await pageInk(page)
    const dialog = await openUploadDialog(page)
    await dialog.getByTestId('font-file-input').setInputFiles([REGULAR, BOLD])
    await expect(dialog.getByTestId('font-upload-item')).toHaveCount(2)
    await dialog.getByTestId('font-upload-submit').click()
    await dialog.getByTestId('font-upload-use').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('ed-font')).toContainText('Doory Blocks')
    await expect.poll(() => pageInk(page)).toBeGreaterThan(plain * 1.6)
    expect(fonts.families[0].variants.map((v) => v.weight).sort()).toEqual([400, 700])
  })

  test('hovering a family in the list previews it and Escape puts the old font back', async ({ page }) => {
    const { fonts } = await setup(page)
    await fonts.seed('DooryBlocks-Regular.ttf')
    await openDesign(page)
    await addText(page, 'heading')
    await page.keyboard.press('Escape')
    const plain = await pageInk(page)
    await page.getByTestId('ed-font').click()
    await page.locator('[data-font="Doory Blocks"]').hover()
    await expect.poll(() => pageInk(page)).toBeGreaterThan(plain * 1.6)
    await page.keyboard.press('Escape')
    await expect.poll(() => pageInk(page)).toBeLessThan(plain * 1.2)
  })

  test('search covers your fonts and the catalog; the family is also offered as a brand kit font', async ({ page }) => {
    const { fonts } = await setup(page)
    await fonts.seed('DooryBlocks-Regular.ttf', 'DooryDiamonds-Regular.woff2')
    await openDesign(page)
    await addText(page, 'heading')
    await page.getByTestId('ed-font').click()
    await page.getByTestId('font-search').fill('doory')
    await expect(page.locator('[data-group="mine"]')).toHaveCount(2)
    await page.getByTestId('font-search').fill('diamonds')
    await expect(page.locator('[data-group="mine"]')).toHaveCount(1)
    await expect(page.locator('[data-font="Doory Diamonds"]')).toBeVisible()
    await page.getByTestId('font-search').fill('inter')
    await expect(page.locator('[data-group="mine"]')).toHaveCount(0)
    await expect(page.locator('[data-font="Inter"]')).toBeVisible()
    await page.keyboard.press('Escape')

    // The Brand panel: pick the uploaded family as the heading font of a kit.
    await openTool(page, 'brand')
    await page.getByTestId('brand-kit-name').fill('Acme')
    await page.getByTestId('brand-kit-create').click()
    await page.getByTestId('brand-font-heading').click()
    await page.locator('[data-font="Doory Diamonds"]').click()
    await expect(page.getByTestId('brand-font-heading')).toContainText('Doory Diamonds')
    await expect.poll(() => fonts.families.length).toBe(2)
  })

  test('deleting a family asks first, names the text that uses it, and the text falls back with a dismissible warning', async ({ page }) => {
    const { fonts } = await setup(page)
    await fonts.seed('DooryBlocks-Regular.ttf')
    await openDesign(page)
    await addText(page, 'heading')
    await page.keyboard.press('Escape')
    const plain = await pageInk(page)
    await page.getByTestId('ed-font').click()
    await page.locator('[data-font="Doory Blocks"]').click()
    await expect.poll(() => pageInk(page)).toBeGreaterThan(plain * 1.6)

    await openTool(page, 'brand')
    await page.getByTestId('brand-kit-name').fill('Acme')
    await page.getByTestId('brand-kit-create').click()
    const card = page.locator('[data-testid="your-font"][data-family="Doory Blocks"]')
    await expect(card).toContainText('Regular')
    const drawn = await settledInk(page)
    await card.getByTestId('font-delete').click()
    const confirm = page.getByTestId('font-delete-confirm')
    await expect(confirm).toContainText('used by 1 text layer')
    await confirm.getByRole('button', { name: 'Keep it' }).click()
    expect(fonts.deleted).toEqual([])
    await card.getByTestId('font-delete').click()
    await page.getByTestId('font-delete-confirm-button').click()
    await expect(card).toHaveCount(0)
    expect(fonts.deleted).toEqual(['Doory Blocks'])

    // The text is drawn in a fallback font at once, and the notice says so.
    await expect.poll(() => pageInk(page)).toBeLessThan(drawn * 0.7)
    const notice = page.getByTestId('missing-fonts')
    await expect(notice).toContainText('Doory Blocks')
    await notice.getByTestId('missing-fonts-dismiss').click()
    await expect(notice).toHaveCount(0)
  })

  test('guests see the same row in the font list and are asked to sign up instead of getting the dialog', async ({ page }) => {
    await openEditor(page, 'mode=guest&doc=blank')
    await addText(page, 'heading')
    await page.keyboard.press('Escape')
    await page.getByTestId('ed-font').click()
    await expect(page.locator('[data-group="mine"]')).toHaveCount(0)
    await page.getByTestId('font-upload-row').click()
    await expect.poll(() => page.evaluate(() => window.__doory!.accountRequests)).toEqual(['brand-kit'])
    await expect(page.getByRole('dialog', { name: 'Upload fonts' })).toHaveCount(0)
  })
})
