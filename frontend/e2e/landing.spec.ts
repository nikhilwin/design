import { expect, test } from '@playwright/test'
import { installMockApi } from './support/mockApi'
import { readLocalDesigns } from './support/helpers'

test.beforeEach(async ({ page }) => {
  await installMockApi(page)
})

test('"Create a design" opens a guest design without any account', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Make something lovely today.')
  await page.getByRole('link', { name: 'Create a design', exact: true }).click()
  await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/)
  await expect(page.locator('[data-editor-root]')).toBeVisible()
  const designs = await readLocalDesigns(page)
  expect(designs).toHaveLength(1)
  expect(designs[0]).toMatchObject({ width: 1080, height: 1080 })
})

test('a size chip creates a design of that size', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Presentation (16:9)' }).click()
  await expect(page).toHaveURL(/\/local\//)
  const [design] = await readLocalDesigns(page)
  expect(design).toMatchObject({ width: 1920, height: 1080 })
})

test('guests can come back to their local designs from the landing page', async ({ page }) => {
  await page.goto('/create?preset=poster')
  await expect(page).toHaveURL(/\/local\//)
  await page.goto('/')
  const strip = page.getByRole('region', { name: 'Pick up where you left off' })
  await expect(strip).toBeVisible()
  await strip.getByRole('link', { name: /Untitled design/ }).click()
  await expect(page).toHaveURL(/\/local\//)
})

test('custom size dialog traps focus and closes with Escape', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Custom size…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a design' })
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Custom size…' })).toBeFocused()
})

test('the skip link is the first tab stop and reaches the main landmark', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main')).toBeVisible()
})

test('the page works at phone width without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('shows an offline banner when the connection drops', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByText(/You’re offline/)).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText(/You’re offline/)).toBeHidden()
})
