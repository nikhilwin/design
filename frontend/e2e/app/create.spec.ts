import { expect, test, Api, createAccount, openContext, shot } from './support/stack'
import { localDesignsJson } from './support/guest'

interface Size {
  width: number
  height: number
  unit?: string
  meta?: { presetId?: string }
}

const sizeOf = (document: Size): string => `${document.width}x${document.height}${document.unit ? ` ${document.unit}` : ''}`

async function newestDesign(api: Api): Promise<{ id: string; width: number; height: number; document: Size }> {
  const list = await api.call<{ results: { id: string }[] }>('get', '/designs/?ordering=-created_at&page_size=1')
  return api.call('get', `/designs/${list.results[0]!.id}/`)
}

test.describe('create', () => {
  test('a guest picks a size chip on the landing page and gets that canvas in the browser', async ({ browser }) => {
    const { page, problems } = await openContext(browser, null)
    await page.goto('/')
    await page.getByRole('link', { name: 'Poster (18 × 24 in)' }).click()
    await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/)
    await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
    const stored = JSON.parse(await localDesignsJson(page)) as { document: Size }[]
    expect(stored).toHaveLength(1)
    expect(sizeOf(stored[0]!.document)).toBe('1728x2304 in')
    expect(stored[0]!.document.meta?.presetId).toBe('poster')
    problems.assertNone()
  })

  test('a signed-in user gets a real design of the chosen size, once, and Back does not make another', async ({ browser }) => {
    const account = await createAccount('Creator Cleo')
    const api = await Api.create(account.state)
    const { page } = await openContext(browser, account)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Create a design' }).click()
    await page.getByRole('menuitem', { name: 'A4 Document' }).click()
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    const design = await newestDesign(api)
    expect(sizeOf(design.document)).toBe('794x1123 mm')
    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
    expect((await api.call<{ count: number }>('get', '/designs/')).count).toBe(1)
  })

  test('the custom size form converts units, locks the aspect ratio and explains bad numbers', async ({ browser }) => {
    const account = await createAccount('Custom Cy')
    const api = await Api.create(account.state)
    const { page } = await openContext(browser, account)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Create a design' }).click()
    await page.getByRole('menuitem', { name: 'Custom size…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a design' })
    await expect(dialog.getByRole('tab', { name: 'Custom size' })).toHaveAttribute('aria-selected', 'true')
    const form = dialog.getByRole('form', { name: 'Custom size' })

    await form.getByLabel('Unit').selectOption('cm')
    await expect(form.getByLabel('Width')).toHaveValue('28.58')
    await form.getByLabel('Width').fill('0')
    await form.getByRole('button', { name: 'Create design' }).click()
    await expect(form.getByText(/at least|greater|too small|between/i).first()).toBeVisible()
    await form.getByLabel('Width').fill('99999')
    await form.getByRole('button', { name: 'Create design' }).click()
    await expect(form.getByText(/up to|at most|too large|between|20/i).first()).toBeVisible()
    await shot(page, 'create-custom-error')

    await form.getByLabel('Width').fill('21,5')
    await form.getByLabel('Height').fill('30')
    await page.getByRole('button', { name: 'Lock aspect ratio' }).click()
    await form.getByLabel('Width').fill('10')
    await expect(form.getByLabel('Height')).toHaveValue('13.95')
    await page.getByRole('button', { name: 'Unlock aspect ratio' }).click()
    await form.getByLabel('Width').fill('21')
    await form.getByLabel('Height').fill('29.7')
    await form.getByRole('button', { name: 'Create design' }).click()
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    const design = await newestDesign(api)
    expect(design.width).toBe(794)
    expect(design.height).toBe(1123)
  })

  test('the full size picker searches and says when nothing matches', async ({ browser }) => {
    const account = await createAccount('Picker Pat')
    const { page } = await openContext(browser, account)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Create a design' }).click()
    await page.getByRole('menuitem', { name: 'More sizes…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a design' })
    await shot(page, 'create-sizes-dialog')
    await dialog.getByRole('searchbox', { name: 'Search sizes' }).fill('story')
    await expect(dialog.getByRole('button', { name: /Instagram Story/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Instagram Post/ })).toHaveCount(0)
    await dialog.getByRole('searchbox', { name: 'Search sizes' }).fill('zzzz')
    await expect(dialog.getByText('No matching size')).toBeVisible()
    await dialog.getByRole('searchbox', { name: 'Search sizes' }).fill('business')
    await dialog.getByRole('button', { name: /Business Card/ }).click()
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  })

  test('nonsense in the address never breaks it: bad sizes fall back, an unknown template is explained', async ({ browser }) => {
    const { page, problems } = await openContext(browser, null)
    for (const query of ['w=abc&h=-4', 'w=0&h=0', 'w=9999999&h=10', 'preset=does-not-exist', 'unit=parsec&w=10&h=10', 'w=<script>alert(1)</script>']) {
      await page.goto(`/create?${query}`)
      await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/, { timeout: 30_000 })
      await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
      const designs = JSON.parse(await localDesignsJson(page)) as { document: Size }[]
      const last = designs.sort((a, b) => 0 - (a as unknown as { updatedAt: number }).updatedAt + (b as unknown as { updatedAt: number }).updatedAt)[0]!
      expect(last.document.width, query).toBeGreaterThanOrEqual(1)
      expect(last.document.width, query).toBeLessThanOrEqual(20_000)
      expect(last.document.height, query).toBeGreaterThanOrEqual(1)
      expect(last.document.height, query).toBeLessThanOrEqual(20_000)
    }
    await page.goto('/create?template=../../etc/passwd')
    await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    await page.goto('/create?template=no-such-template')
    await expect(page.getByText('We can’t find that design')).toBeVisible()
    problems.allow(/WebSocket connection/)
    problems.allow(/HTTP 4\d\d/)
    problems.assertNone()
  })
})
