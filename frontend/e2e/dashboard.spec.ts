import { expect, test } from '@playwright/test'
import { installMockApi, makeUser } from './support/mockApi'

test.beforeEach(async ({ page }) => {
  await installMockApi(page, { user: makeUser() })
})

test('create menu starts an account design from a preset', async ({ page }) => {
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Create a design' }).click()
  await page.getByRole('menuitem', { name: 'Poster (18 × 24 in)' }).click()
  await expect(page).toHaveURL(/\/design\/design-\d+$/)
  await expect(page.locator('[data-editor-root]')).toBeVisible()
})

test('rename, star and trash with undo', async ({ page }) => {
  await page.goto('/dashboard/designs')
  await expect(page.getByRole('link', { name: 'Summer launch post' })).toBeVisible()

  await page.getByRole('button', { name: 'More actions for Podcast cover' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = page.getByRole('textbox', { name: 'Rename Podcast cover' })
  await input.fill('Podcast cover v2')
  await input.press('Enter')
  await expect(page.getByRole('link', { name: 'Podcast cover v2' })).toBeVisible()

  await page.getByRole('button', { name: 'Star Team offsite slides' }).click()
  await expect(page.getByRole('button', { name: 'Remove Team offsite slides from starred' })).toBeVisible()

  await page.getByRole('button', { name: 'More actions for Logo concepts' }).click()
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(page.getByRole('link', { name: 'Logo concepts' })).toBeHidden()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('link', { name: 'Logo concepts' })).toBeVisible()
})

test('trash lists deleted designs and restores them', async ({ page }) => {
  await page.goto('/dashboard/designs')
  await page.getByRole('button', { name: 'More actions for Birthday invitation' }).click()
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await page.getByRole('link', { name: 'Trash' }).first().click()
  await expect(page).toHaveURL(/\/dashboard\/trash$/)
  const row = page.getByRole('listitem').filter({ hasText: 'Birthday invitation' })
  await expect(row).toContainText('30 days left')
  await row.getByRole('button', { name: 'Restore' }).click()
  await expect(row).toBeHidden()
  await page.getByRole('link', { name: 'Designs' }).first().click()
  await expect(page.getByRole('link', { name: 'Birthday invitation' })).toBeVisible()
})

test('folders: create one and move a design into it', async ({ page }) => {
  await page.goto('/dashboard/designs')
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill('Client work')
  await page.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('link', { name: 'Client work' })).toBeVisible()

  await page.getByRole('button', { name: 'More actions for Quarterly report' }).click()
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Client work/ }).click()
  await expect(page.getByRole('link', { name: 'Quarterly report' })).toBeHidden()
  await page.getByRole('link', { name: 'Client work' }).click()
  await expect(page.getByRole('link', { name: 'Quarterly report' })).toBeVisible()
})

test('multi-select shows the bulk bar', async ({ page }) => {
  await page.goto('/dashboard/designs')
  await page.getByRole('checkbox', { name: 'Select Summer launch post' }).check()
  await page.getByRole('checkbox', { name: 'Select Podcast cover' }).check()
  const bar = page.getByRole('region', { name: 'Selected designs' })
  await expect(bar).toContainText('2 selected')
  await bar.getByRole('button', { name: 'Trash' }).click()
  await expect(page.getByRole('link', { name: 'Summer launch post' })).toBeHidden()
})

test('search from the top bar filters the designs page', async ({ page }) => {
  await page.goto('/dashboard')
  await page.getByRole('searchbox', { name: 'Search your designs' }).fill('logo')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/q=logo/)
  await expect(page.getByRole('heading', { name: 'Results for “logo”' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Logo concepts' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Summer launch post' })).toBeHidden()
})

test('the dashboard works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/dashboard')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(page.getByRole('navigation', { name: 'Dashboard sections' })).toBeVisible()
})
