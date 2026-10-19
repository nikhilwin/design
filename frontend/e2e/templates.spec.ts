import { expect, test } from '@playwright/test'
import { installMockApi, makeUser } from './support/mockApi'

test('browse, filter by category and open a template (guest)', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/templates')
  await expect(page.getByRole('link', { name: /Bold sale announcement/ })).toBeVisible()
  await page.getByRole('button', { name: /Presentations/ }).click()
  await expect(page).toHaveURL(/category=presentations/)
  await expect(page.getByRole('link', { name: /Pitch deck cover/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Bold sale announcement/ })).toBeHidden()
  await page.getByRole('link', { name: /Pitch deck cover/ }).click()
  await expect(page.getByRole('heading', { name: 'Pitch deck cover' })).toBeVisible()
  await page.getByRole('button', { name: 'Use this template' }).click()
  await expect(page).toHaveURL(/\/local\//)
})

test('search narrows the grid', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/templates')
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('wedding')
  await expect(page.getByRole('link', { name: /Wedding invitation/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Podcast episode/ })).toBeHidden()
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('zzzz')
  await expect(page.getByText('No templates match')).toBeVisible()
})

test('signed-in users get an account copy of the template', async ({ page }) => {
  const state = await installMockApi(page, { user: makeUser() })
  await page.goto('/templates/pitch-deck-cover')
  await page.getByRole('button', { name: 'Use this template' }).click()
  await expect(page).toHaveURL(/\/design\/design-\d+$/)
  expect(state.designs[0].title).toBe('Pitch deck cover')
})
