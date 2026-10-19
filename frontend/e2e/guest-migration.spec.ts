import { expect, test } from '@playwright/test'
import { e2eHook, readLocalDesigns, seedLocalDesignWithImage } from './support/helpers'
import { installMockApi } from './support/mockApi'

test('guest → account: signing up uploads the images, creates the design and removes the local copy', async ({ page }) => {
  const state = await installMockApi(page)
  await page.goto('/')
  const { designId } = await seedLocalDesignWithImage(page)
  await page.goto(`/local/${designId}`)
  await expect(page.locator('[data-editor-root]')).toBeVisible()

  await e2eHook(page, 'saveToAccount')
  const dialog = page.getByRole('dialog', { name: 'Create a free account to keep this design' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(/Email/).fill('new@example.com')
  await dialog.locator('input[name="new-password"]').fill('compilers-rule-1')
  await dialog.getByRole('button', { name: 'Create free account' }).click()

  await expect(page).toHaveURL(/\/design\/design-\d+$/)
  expect(await readLocalDesigns(page)).toEqual([])

  const uploads = state.requests.filter((request) => request.method === 'POST' && request.path === '/assets/')
  expect(uploads).toHaveLength(1)
  const created = state.requests.find((request) => request.method === 'POST' && request.path === '/designs/')
  expect(created).toBeDefined()
  const serialized = JSON.stringify(created?.body)
  expect(serialized).not.toContain('idb://')
  expect(serialized).toContain('"title":"Seeded with a photo"')
  expect(state.designs[0].title).toBe('Seeded with a photo')
})

test('guest → account: a server failure keeps the local design and the retry succeeds', async ({ page }) => {
  const state = await installMockApi(page)
  await page.goto('/')
  const { designId } = await seedLocalDesignWithImage(page)
  let failing = true
  await page.route('**/api/v1/designs/', async (route) => {
    if (route.request().method() === 'POST' && failing) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'validation_error', message: 'The design was rejected.' } }) })
      return
    }
    await route.fallback()
  })
  await page.goto(`/local/${designId}`)
  await expect(page.locator('[data-editor-root]')).toBeVisible()
  await e2eHook(page, 'saveToAccount')
  const dialog = page.getByRole('dialog', { name: 'Create a free account to keep this design' })
  await dialog.getByLabel(/Email/).fill('retry@example.com')
  await dialog.locator('input[name="new-password"]').fill('compilers-rule-1')
  await dialog.getByRole('button', { name: 'Create free account' }).click()

  await expect(page.getByText('We couldn’t save to your account')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/local/${designId}$`))
  expect(await readLocalDesigns(page)).toHaveLength(1)
  expect(state.assets).toHaveLength(0)

  failing = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page).toHaveURL(/\/design\/design-\d+$/)
  expect(await readLocalDesigns(page)).toEqual([])
})

test('a missing local design explains itself', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/local/00000000-0000-4000-8000-000000000000')
  await expect(page.getByText('This design isn’t in this browser')).toBeVisible()
})
