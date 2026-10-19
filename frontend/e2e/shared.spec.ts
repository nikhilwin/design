import { expect, test } from '@playwright/test'
import { installMockApi } from './support/mockApi'

test('a view link opens for anyone', async ({ page }) => {
  const state = await installMockApi(page)
  state.shared.open = { role: 'view', title: 'Shared poster' }
  await page.goto('/s/open')
  await expect(page.locator('[data-editor-root]')).toBeVisible()
})

test('password-protected links prompt, reject a wrong password and then open', async ({ page }) => {
  const state = await installMockApi(page)
  state.shared.locked = { role: 'view', title: 'Secret deck', password: 'open-sesame' }
  await page.goto('/s/locked')
  await expect(page.getByRole('heading', { name: 'This design is protected' })).toBeVisible()
  await page.getByLabel('Password').fill('wrong')
  await page.getByRole('button', { name: 'Open design' }).click()
  await expect(page.getByText('That password isn’t right. Try again.')).toBeVisible()
  await page.getByLabel('Password').fill('open-sesame')
  await page.getByRole('button', { name: 'Open design' }).click()
  await expect(page.locator('[data-editor-root]')).toBeVisible()
})

test('unknown links explain themselves', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/s/nope')
  await expect(page.getByText('This link doesn’t work')).toBeVisible()
})

test('edit links ask guests to sign in first', async ({ page }) => {
  const state = await installMockApi(page)
  state.shared.edit = { role: 'edit', title: 'Team board' }
  await page.goto('/s/edit')
  await expect(page.getByText('Sign in to edit “Team board”')).toBeVisible()
  await page.getByRole('button', { name: 'Sign in to edit' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})
