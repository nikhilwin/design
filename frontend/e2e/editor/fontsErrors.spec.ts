/**
 * [layout] Uploads that go wrong: every error code of `POST /fonts/mine/` has its own message in the dialog, a file that
 * cannot be a font is refused before anything is sent, and the rest of the batch is never lost.
 */
import { type Page, expect, test } from '@playwright/test'
import { installMockApi, makeUser } from '../support/mockApi'
import { FakeFontServer, fixture, openDesign, openUploadDialog } from './fontsApi'
import { addText } from './helpers'

const REGULAR = fixture('DooryBlocks-Regular.ttf')
const BOLD = fixture('DooryBlocks-Bold.ttf')

async function openDialog(page: Page) {
  const state = await installMockApi(page)
  state.user = makeUser()
  const fonts = new FakeFontServer()
  await fonts.install(page)
  await openDesign(page)
  await addText(page, 'heading')
  await page.keyboard.press('Escape')
  const dialog = await openUploadDialog(page)
  return { fonts, dialog }
}

const rowOf = (dialog: ReturnType<Page['getByRole']>, name: string) => dialog.getByTestId('font-upload-item').filter({ hasText: name })

test.describe('[layout] font upload errors', () => {
  test('a built-in name asks for another family name, focuses the field, and the retry goes through under the new name', async ({ page }) => {
    const { fonts, dialog } = await openDialog(page)
    fonts.reserved.push('doory blocks')
    await dialog.getByTestId('font-file-input').setInputFiles([REGULAR])
    await expect(dialog.getByTestId('font-upload-submit')).toBeEnabled()
    await dialog.getByTestId('font-upload-submit').click()
    const row = rowOf(dialog, 'DooryBlocks-Regular.ttf')
    await expect(row.getByRole('alert')).toContainText('A built-in font already has this name')
    await expect(dialog.getByTestId('font-family-input')).toBeFocused()
    await expect(dialog.getByTestId('font-family-input')).toHaveAttribute('aria-invalid', 'true')
    expect(fonts.families).toHaveLength(0)

    await dialog.getByTestId('font-family-input').fill('My Blocks')
    await dialog.getByTestId('font-upload-submit').click()
    await expect(dialog.getByTestId('font-upload-success')).toBeVisible()
    expect(fonts.uploads.at(-1)).toEqual({ files: ['DooryBlocks-Regular.ttf'], family: 'My Blocks' })
    expect(fonts.families.map((f) => f.family)).toEqual(['My Blocks'])
  })

  test('a weight and style that is already there fails on its own while the other files are stored', async ({ page }) => {
    const { fonts, dialog } = await openDialog(page)
    await fonts.seed('DooryBlocks-Regular.ttf')
    await dialog.getByTestId('font-file-input').setInputFiles([REGULAR, BOLD])
    await expect(dialog.getByTestId('font-upload-submit')).toBeEnabled()
    await dialog.getByTestId('font-upload-submit').click()
    await expect(rowOf(dialog, 'DooryBlocks-Regular.ttf').getByRole('alert')).toContainText('already in your fonts')
    await expect(rowOf(dialog, 'DooryBlocks-Bold.ttf')).toContainText('Added to Doory Blocks (2 styles)')
    await expect(dialog.getByTestId('font-upload-submit')).toHaveText('Upload again')
    expect(fonts.families[0].variants.map((v) => v.weight).sort()).toEqual([400, 700])
    // Removing the file that cannot go in leaves a finished batch.
    await rowOf(dialog, 'DooryBlocks-Regular.ttf').getByTestId('font-upload-remove').click()
    await expect(dialog.getByTestId('font-upload-success')).toContainText('1 font uploaded')
  })

  test('the family limit stops the batch, keeps the unsent files, and the retry sends them', async ({ page }) => {
    const { fonts, dialog } = await openDialog(page)
    fonts.failures.push({ status: 403, code: 'font_limit_reached' })
    await dialog.getByTestId('font-file-input').setInputFiles([REGULAR, BOLD])
    await expect(dialog.getByTestId('font-upload-submit')).toBeEnabled()
    await dialog.getByTestId('font-upload-submit').click()
    await expect(rowOf(dialog, 'DooryBlocks-Regular.ttf').getByRole('alert')).toContainText('limit of 50 font families')
    await expect(rowOf(dialog, 'DooryBlocks-Bold.ttf')).toHaveAttribute('data-status', 'ready')
    await expect(dialog.getByText('The upload stopped')).toBeVisible()
    expect(fonts.uploads).toHaveLength(1)

    await dialog.getByTestId('font-upload-submit').click()
    await expect(dialog.getByTestId('font-upload-success')).toContainText('2 fonts uploaded')
    expect(fonts.uploads.map((u) => u.files[0])).toEqual(['DooryBlocks-Regular.ttf', 'DooryBlocks-Regular.ttf', 'DooryBlocks-Bold.ttf'])
  })

  test('the storage limit, a rate limit, a rejected font and a lost connection each say what to do', async ({ page }) => {
    const { fonts, dialog } = await openDialog(page)
    await dialog.getByTestId('font-file-input').setInputFiles([REGULAR])
    const row = rowOf(dialog, 'DooryBlocks-Regular.ttf')
    const submit = dialog.getByTestId('font-upload-submit')
    await expect(submit).toBeEnabled()

    fonts.failures.push({ status: 403, code: 'font_storage_limit' })
    await submit.click()
    await expect(row.getByRole('alert')).toContainText('more than 150 MB')

    fonts.failures.push({ status: 429, code: 'throttled', retryAfter: 7 })
    await submit.click()
    await expect(row.getByRole('alert')).toContainText('Try again in 7 seconds')

    fonts.failures.push({ status: 400, code: 'validation_error', message: 'Invalid input.', fields: { files: ['DooryBlocks-Regular.ttf: the font has no vector outlines.'] } })
    await submit.click()
    await expect(row.getByRole('alert')).toHaveText('The font has no vector outlines.')

    fonts.failures.push({ status: 413, code: 'payload_too_large' })
    await submit.click()
    await expect(row.getByRole('alert')).toContainText('too large to upload')

    await page.route('**/api/v1/fonts/mine/', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.fallback()))
    await submit.click()
    await expect(row.getByRole('alert')).toContainText('Could not reach Doory')
    await page.unroute('**/api/v1/fonts/mine/')

    expect(fonts.families).toHaveLength(0)
  })

  test('files that cannot be fonts are refused on the spot and nothing is sent', async ({ page }) => {
    const { fonts, dialog } = await openDialog(page)
    const input = dialog.getByTestId('font-file-input')
    await input.setInputFiles([
      { name: 'brand.ttf', mimeType: 'font/ttf', buffer: Buffer.from('%PDF-1.7 this is a document') },
      { name: 'empty.otf', mimeType: 'font/otf', buffer: Buffer.alloc(0) },
      { name: 'huge.woff2', mimeType: 'font/woff2', buffer: Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(11 * 1024 * 1024)]) },
      { name: 'collection.ttc', mimeType: 'font/collection', buffer: Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(64)]) },
    ])
    await expect(rowOf(dialog, 'brand.ttf').getByRole('alert')).toContainText('not a TTF, OTF, WOFF or WOFF2 font')
    await expect(rowOf(dialog, 'empty.otf').getByRole('alert')).toContainText('The file is empty')
    await expect(rowOf(dialog, 'huge.woff2').getByRole('alert')).toContainText('larger than 10 MB')
    await expect(rowOf(dialog, 'collection.ttc').getByRole('alert')).toContainText('Font collections')
    await expect(dialog.getByTestId('font-upload-submit')).toBeDisabled()
    await rowOf(dialog, 'brand.ttf').getByTestId('font-upload-remove').click()
    await expect(dialog.getByTestId('font-upload-item')).toHaveCount(3)
    expect(fonts.uploads).toHaveLength(0)
  })

  test('at most five files go in, and the same file twice is ignored', async ({ page }) => {
    const { dialog } = await openDialog(page)
    const input = dialog.getByTestId('font-file-input')
    await input.setInputFiles([REGULAR, BOLD, fixture('DooryBlocks-Italic.ttf'), fixture('DooryDiamonds-Regular.woff2')])
    await expect(dialog.getByTestId('font-upload-item')).toHaveCount(4)
    await input.setInputFiles([REGULAR])
    await expect(dialog.getByText('This file is already in the list.')).toBeVisible()
    await input.setInputFiles([
      { name: 'a.ttf', mimeType: 'font/ttf', buffer: Buffer.from('nope') },
      { name: 'b.ttf', mimeType: 'font/ttf', buffer: Buffer.from('nope') },
    ])
    await expect(dialog.getByText('Only 5 files can be added at a time')).toBeVisible()
    await expect(dialog.getByTestId('font-upload-item')).toHaveCount(5)
  })

  test('a library that cannot be loaded says so with the server’s words and offers a retry in the font list', async ({ page }) => {
    const state = await installMockApi(page)
    state.user = makeUser()
    const fonts = new FakeFontServer()
    await fonts.seed('DooryBlocks-Regular.ttf')
    await fonts.install(page)
    // The editor asks when it opens, when a font is looked up and when the list is opened: every ask fails.
    fonts.listFailure = { status: 503, code: 'unavailable', message: 'The font library is resting.' }
    fonts.listFailures = Number.POSITIVE_INFINITY
    await openDesign(page)
    await addText(page, 'heading')
    await page.keyboard.press('Escape')
    await page.getByTestId('ed-font').click()
    await expect(page.getByTestId('font-mine-error')).toContainText('The font library is resting.')
    await expect(page.locator('[data-font="DejaVu Sans"], [data-font="Inter"]').first()).toBeVisible()
    fonts.listFailure = null
    await page.getByTestId('font-mine-error').getByRole('button', { name: 'Try again' }).click()
    await expect(page.locator('[data-font="Doory Blocks"]')).toHaveAttribute('data-group', 'mine')
    await expect(page.getByTestId('font-mine-error')).toHaveCount(0)
  })
})
