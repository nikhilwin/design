import { expect, test, createAccount, openContext, shot } from './support/stack'
import { makePng } from './support/png'

test.describe('settings', () => {
  test('changes the display name everywhere it is shown, and refuses an empty one', async ({ browser }) => {
    const account = await createAccount('Rename Ren')
    const { page, problems } = await openContext(browser, account)
    await page.goto('/settings')
    const name = page.getByRole('textbox', { name: 'Display name' })
    await expect(page.getByRole('button', { name: 'Save name' })).toBeDisabled()
    await name.fill('   ')
    await page.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByText('Enter the name you’d like to use.')).toBeVisible()
    await name.fill('Renée Okafor')
    await page.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByText('Name updated')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Account menu for Renée Okafor' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('Renée Okafor')
    problems.assertNone()
  })

  test('uploads, shows and removes a profile photo, and explains a file that cannot be one', async ({ browser }) => {
    const account = await createAccount('Photo Pia')
    const { page, problems } = await openContext(browser, account)
    await page.goto('/settings')
    const picker = page.getByLabel('Choose a profile photo')
    await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.getByRole('alert').filter({ hasText: 'Choose a PNG, JPG or WebP image.' })).toBeVisible()
    await picker.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') })
    await page.getByRole('button', { name: 'Save photo' }).click()
    await expect(page.getByRole('alert').filter({ hasText: /image|valid|decode|corrupt/i })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await picker.setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: makePng(600, 400, 7) })
    await page.getByRole('button', { name: 'Save photo' }).click()
    await expect(page.getByText('Profile photo updated')).toBeVisible()
    const avatar = page.getByRole('main').locator('img[src*="/media/avatars/"]').first()
    await expect(avatar).toBeVisible()
    await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512)
    await shot(page, 'settings-avatar')
    await page.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('Profile photo removed')).toBeVisible()
    await expect(page.getByRole('main').locator('img[src*="/media/avatars/"]')).toHaveCount(0)
    problems.allow(/status of 400/)
    problems.assertNone()
  })

})
