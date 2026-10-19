import { expect, test } from '@playwright/test'
import { installMockApi, makeUser } from './support/mockApi'

test('protected pages send visitors to /login and back after signing in', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/dashboard/trash')
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard%2Ftrash/)
  await page.getByLabel(/Email/).fill('ada@example.com')
  await page.getByLabel(/Password/, { exact: false }).first().fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/dashboard\/trash$/)
  await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible()
})

test('wrong credentials show an error and keep the form', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/login')
  await page.getByLabel(/Email/).fill('ada@example.com')
  await page.locator('input[name="password"]').fill('nope')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('alert')).toContainText('don’t match')
  await expect(page.getByLabel(/Email/)).toHaveValue('ada@example.com')
})

test('sign up creates an account and lands on the dashboard; logout returns home', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/signup')
  await page.getByLabel('Name').fill('Grace Hopper')
  await page.getByLabel(/Email/).fill('grace@example.com')
  await page.locator('input[name="new-password"]').fill('compilers-rule-1')
  await expect(page.getByRole('meter', { name: 'Password strength' })).toHaveAttribute('aria-valuenow', '4')
  await page.getByRole('button', { name: 'Create free account' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Grace')
  await expect(page.getByText('Verify your email.')).toBeVisible()
  await page.getByRole('button', { name: /Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
})

test('duplicate email is reported on the field', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/signup')
  await page.getByLabel(/Email/).fill('taken@example.com')
  await page.locator('input[name="new-password"]').fill('compilers-rule-1')
  await page.getByRole('button', { name: 'Create free account' }).click()
  await expect(page.getByText('An account with this email already exists.')).toBeVisible()
})

test('forgot password never reveals whether an account exists', async ({ page }) => {
  await installMockApi(page)
  await page.goto('/forgot-password')
  await page.getByLabel(/Email/).fill('who@example.com')
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
})

test('a signed-in visitor on /login is sent to the dashboard', async ({ page }) => {
  await installMockApi(page, { user: makeUser() })
  await page.goto('/login')
  await expect(page).toHaveURL(/\/dashboard$/)
})
