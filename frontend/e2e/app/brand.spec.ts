import { fileURLToPath } from 'node:url'
import { expect, test, Api, createAccount, openContext, shot } from './support/stack'
import { seedAssets } from './support/seed'

const FONT_FILE = fileURLToPath(new URL('../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', import.meta.url))

interface Kit {
  id: string
  name: string
  is_default: boolean
  colors: { id: string; name: string; hex: string }[]
  fonts: { role: string; family: string }[]
  logos: { id: string }[]
}

test.describe('brand kits', () => {
  test('creates a kit with colours, fonts per role and a logo, and the card says so', async ({ browser }) => {
    const account = await createAccount('Brand Bea')
    const api = await Api.create(account.state)
    const [logo] = await seedAssets(api, 2, { prefix: 'logo' })
    const { page, problems } = await openContext(browser, account)
    await page.goto('/dashboard/brand')
    await expect(page.getByRole('heading', { name: 'Create your first brand kit' })).toBeVisible()
    await shot(page, 'brand-empty')
    await page.getByRole('button', { name: 'New brand kit' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New brand kit' })
    await dialog.getByLabel('Kit name').fill('Doory identity')
    await dialog.getByLabel('Colour 1 hex').fill('#E11D48')
    await dialog.getByRole('button', { name: 'Add colour' }).click()
    await dialog.getByLabel('Colour 2 hex').fill('#1c1517')
    await dialog.getByLabel('Colour 2 name').fill('Ink')
    await dialog.getByRole('button', { name: 'Add colour' }).click()
    await dialog.getByLabel('Colour 3 hex').fill('nope')
    await expect(dialog.getByText('Use a hex colour like #e11d48.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create kit' })).toBeDisabled()
    await dialog.getByLabel('Colour 3 hex').fill('#fecdd3')
    await dialog.getByLabel('Heading font', { exact: true }).selectOption('Plus Jakarta Sans')
    await dialog.getByLabel('Body font', { exact: true }).selectOption('Inter')
    await dialog.getByRole('checkbox', { name: logo!.name }).check()
    await dialog.getByRole('switch', { name: 'Use as my default kit' }).check()
    await shot(page, 'brand-editor')
    await dialog.getByRole('button', { name: 'Create kit' }).click()
    await expect(page.getByText('Brand kit created')).toBeVisible()

    const card = page.locator('li').filter({ has: page.getByRole('heading', { name: 'Doory identity' }) })
    await expect(card.getByText('Default', { exact: true })).toBeVisible()
    await expect(card.getByRole('img')).toHaveCount(3)
    await expect(card).toContainText('Plus Jakarta Sans · Inter · 1 logo')
    const [stored] = await api.list<Kit>('/brand-kits/')
    expect(stored!.colors.map((color) => color.hex)).toEqual(['#e11d48', '#1c1517', '#fecdd3'])
    expect(stored!.fonts).toEqual(expect.arrayContaining([{ role: 'heading', family: 'Plus Jakarta Sans' }, { role: 'body', family: 'Inter' }]))
    expect(stored!.logos.map((item) => item.id)).toEqual([logo!.id])
    problems.assertNone()
  })

  test('edits a kit, makes another one the default, and deletes after a confirmation', async ({ browser }) => {
    const account = await createAccount('Brand Ben')
    const api = await Api.create(account.state)
    const color = [{ id: 'c1', name: 'Brand', hex: '#e11d48' }]
    await api.call('post', '/brand-kits/', { name: 'First kit', is_default: true, colors: color, fonts: [] }, 201)
    await api.call('post', '/brand-kits/', { name: 'Second kit', colors: color, fonts: [] }, 201)
    const { page } = await openContext(browser, account)
    await page.goto('/dashboard/brand')
    const first = page.locator('li').filter({ has: page.getByRole('heading', { name: 'First kit' }) })
    const second = page.locator('li').filter({ has: page.getByRole('heading', { name: 'Second kit' }) })

    await second.getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit brand kit' })
    await dialog.getByLabel('Kit name').fill('')
    await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await dialog.getByLabel('Kit name').fill('Renamed kit')
    await dialog.getByRole('button', { name: 'Remove colour 1' }).click()
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Brand kit saved')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Renamed kit' })).toBeVisible()
    await expect(page.locator('li').filter({ has: page.getByRole('heading', { name: 'Renamed kit' }) })).toContainText('No colours yet')

    await page.locator('li').filter({ has: page.getByRole('heading', { name: 'Renamed kit' }) }).getByRole('button', { name: 'Make default' }).click()
    await expect(page.getByText('“Renamed kit” is now your default kit')).toBeVisible()
    await expect(first.getByText('Default', { exact: true })).toHaveCount(0)
    const kits = await api.list<Kit>('/brand-kits/')
    expect(kits.filter((kit) => kit.is_default).map((kit) => kit.name)).toEqual(['Renamed kit'])

    await first.getByRole('button', { name: 'Delete' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: /Delete/ }).last().click()
    await expect(page.getByRole('heading', { name: 'First kit' })).toHaveCount(0)
    expect(await api.list<Kit>('/brand-kits/')).toHaveLength(1)
  })

  test('at twenty kits the page says the limit is reached', async ({ browser }) => {
    test.setTimeout(150_000)
    const account = await createAccount('Brand Max')
    const api = await Api.create(account.state)
    for (let index = 1; index <= 20; index++) await api.call('post', '/brand-kits/', { name: `Kit ${index}`, colors: [], fonts: [] }, 201)
    const { page } = await openContext(browser, account)
    await page.goto('/dashboard/brand')
    await expect(page.getByText('You’ve reached the limit of 20 brand kits.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'New brand kit' })).toBeDisabled()
    await shot(page, 'brand-limit')
  })

  test('uploads a font file, lists it by name and removes it again', async ({ browser }) => {
    const account = await createAccount('Font Fay')
    const { page, problems } = await openContext(browser, account)
    await page.goto('/dashboard/brand')
    await expect(page.getByRole('heading', { name: 'Bring your own fonts' })).toBeVisible()
    await page.getByRole('button', { name: 'Upload fonts' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Upload fonts' })
    await dialog.locator('input[type="file"]').setInputFiles(FONT_FILE)
    await dialog.getByLabel('Family name').fill('My Test Sans')
    await dialog.getByRole('button', { name: 'Upload font' }).click()
    await expect(dialog.getByText(/1 font uploaded/)).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText('My Test Sans').first()).toBeVisible()
    await shot(page, 'brand-fonts')
    await page.getByRole('button', { name: 'Delete My Test Sans' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete font' }).click()
    await expect(page.getByText('My Test Sans')).toHaveCount(0)
    problems.assertNone()
  })
})
