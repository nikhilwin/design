/**
 * [engine] Export output (file formats, sizes, page ranges). The Download dialog is reusable in any chrome; only the button that opens it is layout specific.
 * [engine] specs must keep passing in any chrome; [layout] specs target the current UI and are to be rewritten with it.
 */
import { type Download, type Page, expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { openDownloadDialog, openEditor } from './helpers'

async function download(page: Page, format: string, configure?: () => Promise<void>): Promise<{ file: Download; bytes: Buffer }> {
  await openDownloadDialog(page)
  const dialog = page.getByRole('dialog', { name: 'Download' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('radio', { name: new RegExp(`^${format}`) }).check()
  if (configure) await configure()
  const pending = page.waitForEvent('download', { timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Download', exact: true }).click()
  const file = await pending
  const path = await file.path()
  return { file, bytes: await readFile(path) }
}

test.describe('[engine] export', () => {
  test('PNG at 2x has the right pixel size and real content', async ({ page }) => {
    await openEditor(page, 'doc=demo')
    const { file, bytes } = await download(page, 'PNG', async () => {
      await page.getByRole('dialog', { name: 'Download' }).getByRole('radio', { name: '2×' }).check()
      await page.getByRole('dialog', { name: 'Download' }).getByRole('radio', { name: 'Current page' }).check()
    })
    expect(file.suggestedFilename()).toMatch(/\.png$/)
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const doc = await page.evaluate(() => ({ w: window.__doory!.getDocument().width, h: window.__doory!.getDocument().height }))
    expect(bytes.readUInt32BE(16)).toBe(doc.w * 2)
    expect(bytes.readUInt32BE(20)).toBe(doc.h * 2)
    expect(bytes.length).toBeGreaterThan(20_000)
  })

  test('JPG, SVG and PDF are produced and look like their formats', async ({ page }) => {
    await openEditor(page, 'doc=demo')
    const jpg = await download(page, 'JPG', async () => {
      await page.getByRole('dialog', { name: 'Download' }).getByRole('radio', { name: 'Current page' }).check()
    })
    expect([...jpg.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])

    const svg = await download(page, 'SVG', async () => {
      await page.getByRole('dialog', { name: 'Download' }).getByRole('radio', { name: 'Current page' }).check()
    })
    const text = svg.bytes.toString('utf8')
    expect(text).toMatch(/^<\?xml|^<svg/)
    expect(text).toContain('<svg')
    expect(text.toLowerCase()).not.toContain('<script')
    expect(text).not.toMatch(/href="(?:blob|idb):/)

    const pdf = await download(page, 'PDF', async () => {
      await page.getByRole('dialog', { name: 'Download' }).getByRole('radio', { name: 'Current page' }).check()
    })
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.bytes.length).toBeGreaterThan(5_000)
  })

  test('multi-page selection downloads one ZIP with a file per page and validates page ranges', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Add page', exact: true }).last().click()
    await expect(page.locator('[data-artboard]')).toHaveCount(3)
    await openDownloadDialog(page)
    const dialog = page.getByRole('dialog', { name: 'Download' })
    await dialog.getByRole('radio', { name: /^PNG/ }).check()
    await dialog.getByRole('radio', { name: 'Select pages' }).check()
    await dialog.getByRole('textbox', { name: 'Select pages' }).fill('9')
    await expect(dialog.getByRole('alert')).toContainText('Enter page numbers')
    await expect(dialog.getByRole('button', { name: 'Download', exact: true })).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Select pages' }).fill('1, 3')
    const names: string[] = []
    page.on('download', (d) => names.push(d.suggestedFilename()))
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()
    await expect.poll(() => names.length, { timeout: 15_000 }).toBe(1)
    expect(names[0]).toMatch(/\.zip$/)
  })

  test('the server PDF option only appears when the adapter provides it', async ({ page }) => {
    await openEditor(page, 'doc=blank')
    await openDownloadDialog(page)
    const dialog = page.getByRole('dialog', { name: 'Download' })
    await expect(dialog.getByRole('radio', { name: /^PNG/ })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: /Print-quality PDF/ })).toHaveCount(0)
  })
})
