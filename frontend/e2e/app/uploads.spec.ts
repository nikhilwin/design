import { expect, test, Api, createAccount, openContext, shot } from './support/stack'
import { makePng } from './support/png'

const upload = async (page: import('@playwright/test').Page, files: { name: string; mimeType: string; buffer: Buffer }[]) => {
  await page.locator('input[type="file"]').first().setInputFiles(files)
}

test.describe('uploads', () => {
  test('uploads images, shows them in the library, deletes one and keeps the storage meter honest', async ({ browser }) => {
    const account = await createAccount('Uploader Una')
    const { page, problems } = await openContext(browser, account)
    await page.goto('/dashboard/uploads')
    await expect(page.getByRole('heading', { name: 'Uploads', exact: true })).toBeVisible()
    await expect(page.getByText('0 B of 2 GB used')).toBeVisible()
    await upload(page, [
      { name: 'sunset.png', mimeType: 'image/png', buffer: makePng(640, 480, 1) },
      { name: 'dawn.png', mimeType: 'image/png', buffer: makePng(800, 600, 2) },
    ])
    await expect(page.getByText('sunset.png').first()).toBeVisible()
    await expect(page.getByText('dawn.png').first()).toBeVisible()
    await shot(page, 'uploads-library')
    await expect(page.getByText('0 B of 2 GB used')).toHaveCount(0)

    await page.getByRole('button', { name: /Delete dawn\.png|More actions for dawn\.png|Actions for dawn\.png/ }).first().click()
    const menuDelete = page.getByRole('menuitem', { name: 'Delete' })
    if (await menuDelete.count()) await menuDelete.click()
    await page.getByRole('alertdialog').getByRole('button', { name: /Delete/ }).click()
    // The queue above the library keeps its finished rows until they are cleared; the library itself no longer has the file.
    await page.getByRole('button', { name: 'Clear finished' }).click()
    await expect(page.getByText('dawn.png')).toHaveCount(0)
    await expect(page.getByText('sunset.png').first()).toBeVisible()
    problems.assertNone()
  })

  test('says why a file cannot be uploaded instead of failing quietly: wrong type, empty, too large, not really an image', async ({ browser }) => {
    const account = await createAccount('Bad Files')
    const { page, problems } = await openContext(browser, account)
    await page.goto('/dashboard/uploads')
    await upload(page, [
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
      { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) },
      { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(26 * 1024 * 1024, 1) },
      { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not a png at all, only text pretending to be one') },
    ])
    await expect(page.getByText('Only PNG, JPG, WebP, GIF, AVIF and SVG images can be uploaded.')).toBeVisible()
    await expect(page.getByText('This file is empty.')).toBeVisible()
    await expect(page.getByText(/This file is 26 MB\. The limit is 25 MB\./)).toBeVisible()
    await expect(page.getByText(/valid image|not an image|invalid|decode|corrupt/i).first()).toBeVisible({ timeout: 15_000 })
    await shot(page, 'uploads-bad-files')
    problems.allow(/status of 400/)
    problems.assertNone()
  })

  test('an SVG with a script is stored without it', async () => {
    const account = await createAccount('Svg Sam')
    const api = await Api.create(account.state)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="alert(1)"><script>alert(2)</script><rect width="40" height="40" fill="#e11d48"/></svg>')
    const asset = (await api.upload('/assets/', 'bad.svg', 'image/svg+xml', svg)) as { url: string }
    const stored = await (await api.request.get(asset.url)).text()
    expect(stored).not.toContain('<script')
    expect(stored).not.toContain('onload')
    expect(stored).toContain('<rect')
  })

  test('a full account says the storage is full in plain words', async ({ browser }) => {
    const account = await createAccount('Quota Quinn')
    const { page } = await openContext(browser, account, {
      before: async (target) => {
        await target.route('**/api/v1/assets/', async (route) => {
          if (route.request().method() === 'POST') return route.fulfill({ status: 413, json: { error: { code: 'quota_exceeded', message: 'Your storage is full.' } } })
          return route.fallback()
        })
      },
    })
    await page.goto('/dashboard/uploads')
    await upload(page, [{ name: 'one-too-many.png', mimeType: 'image/png', buffer: makePng(300, 200, 5) }])
    await expect(page.getByText('Your storage is full.')).toBeVisible()
    await shot(page, 'uploads-quota')
  })
})
