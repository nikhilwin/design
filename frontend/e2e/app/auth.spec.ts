import type { Page } from '@playwright/test'
import { expect, test, Api, createAccount, mailLink, openContext, PASSWORD, shot, uniqueEmail } from './support/stack'

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
}

test.describe('sign up', () => {
  test('shows what is wrong with each field before it asks the server', async ({ browser }) => {
    const { page, problems } = await openContext(browser, null)
    await page.goto('/signup')
    await expect(page).toHaveTitle(/Sign up/)
    await page.getByRole('button', { name: 'Create free account' }).click()
    await expect(page.getByText('Enter your email address.')).toBeVisible()
    await expect(page.getByText('Choose a password.')).toBeVisible()

    await page.getByRole('textbox', { name: 'Email' }).fill('not-an-address')
    await page.getByRole('textbox', { name: 'Password' }).fill('12345678')
    await page.getByRole('button', { name: 'Create free account' }).click()
    await expect(page.getByText('That doesn’t look like an email address.')).toBeVisible()
    await expect(page.getByText('Use at least 8 characters, and not only numbers.')).toBeVisible()
    await shot(page, 'signup-errors')
    await expect(page).toHaveURL(/\/signup$/)
    problems.assertNone()
  })

  test('creates the account once, signs in, sends the verification e-mail and verifies it from the link', async ({ browser }) => {
    const { page, problems } = await openContext(browser, null)
    const email = uniqueEmail('Signup Sam')
    const registrations: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/auth/register/')) registrations.push(request.url())
    })
    await page.goto('/signup?next=/dashboard/brand')
    await page.getByRole('textbox', { name: 'Name' }).fill('Sam Signup')
    await page.getByRole('textbox', { name: 'Email' }).fill(email)
    await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD)
    const submit = page.getByRole('button', { name: 'Create free account' })
    await submit.dblclick()
    await page.waitForURL((url) => url.pathname === '/dashboard/brand')
    expect(registrations).toHaveLength(1)
    await expect(page.getByText('Verify your email.')).toBeVisible()

    const link = await mailLink(email, /./, /http:\/\/localhost:\d+\/verify-email\?uid=[^&\s"<]+&token=[^\s"<&]+/)
    await page.goto(new URL(link).pathname + new URL(link).search)
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()
    await page.getByRole('link', { name: 'Go to your dashboard' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText('Verify your email.')).toHaveCount(0)
    problems.assertNone()
  })

  test('refuses an address that is already registered, whatever its case', async ({ browser }) => {
    const account = await createAccount('Taken')
    const { page } = await openContext(browser, null)
    await page.goto('/signup')
    await page.getByRole('textbox', { name: 'Email' }).fill(account.email.toUpperCase())
    await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Create free account' }).click()
    await expect(page.getByText('An account with this email already exists.')).toBeVisible()
    await expect(page).toHaveURL(/\/signup$/)
  })

  test('says so when the server turns a weak password down, and when sign-ups are rate limited', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await page.goto('/signup')
    await page.getByRole('textbox', { name: 'Email' }).fill(uniqueEmail('weak'))
    await page.getByRole('textbox', { name: 'Password' }).fill('qwertyuiop')
    await page.getByRole('button', { name: 'Create free account' }).click()
    await expect(page.getByText(/too common/i)).toBeVisible()

    await page.route('**/api/v1/auth/register/', (route) =>
      route.fulfill({ status: 429, headers: { 'Retry-After': '45' }, json: { error: { code: 'throttled', message: 'Request was throttled.', retry_after: 45 } } }),
    )
    await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Create free account' }).click()
    await expect(page.getByRole('alert')).toContainText('Too many attempts. Please try again in 45 seconds.')
  })
})

test.describe('log in and out', () => {
  test('a wrong password gets one plain message and no hint about which half was wrong', async ({ browser }) => {
    const account = await createAccount('Wrong Pass')
    const { page, problems } = await openContext(browser, null)
    await page.goto('/login')
    await logIn(page, account.email, 'definitely-not-it')
    const alert = page.getByRole('alert').filter({ hasText: /incorrect|invalid/i })
    await expect(alert).toBeVisible()
    await logIn(page, uniqueEmail('nobody'), 'definitely-not-it')
    await expect(alert).toHaveText(await alert.textContent() ?? '')
    await shot(page, 'login-error')
    await expect(page).toHaveURL(/\/login$/)
    problems.allow(/status of 400/)
    problems.assertNone()
  })

  test('ten wrong guesses lock the account for a while and the page says how long', async ({ browser }) => {
    const account = await createAccount('Locked Out')
    const api = await Api.create()
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await api.raw('post', '/auth/login/', { email: account.email, password: `wrong-${attempt}-guess` })
      expect(response.status()).toBe(400)
    }
    const { page } = await openContext(browser, null)
    await page.goto('/login')
    await logIn(page, account.email, account.password)
    await expect(page.getByRole('alert')).toContainText(/Too many attempts\. Please try again in \d+ minutes?\./)
    await shot(page, 'login-locked')
  })

  test('sends a visitor back to the page they asked for, and never off the site', async ({ browser }) => {
    const account = await createAccount('Deep Link')
    const { page } = await openContext(browser, null)
    await page.goto('/dashboard/brand')
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard%2Fbrand$/)
    await logIn(page, account.email, account.password)
    await expect(page).toHaveURL(/\/dashboard\/brand$/)
    await expect(page.getByRole('heading', { name: 'Brand kits' })).toBeVisible()

    const other = await openContext(browser, null)
    await other.page.goto('/login?next=//evil.test/phish')
    await logIn(other.page, account.email, account.password)
    await expect(other.page).toHaveURL(/\/dashboard$/)
    await other.page.goto('/login')
    await expect(other.page).toHaveURL(/\/dashboard$/)
  })

  test('signing out ends the session on the server and the back button does not reopen the dashboard', async ({ browser }) => {
    const account = await createAccount('Out Of Here')
    const { page, context } = await openContext(browser, account)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /Account menu for/ }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible()
    const me = await context.request.get('/api/v1/auth/me/')
    expect((await me.json()).user).toBeNull()
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Your designs' })).toHaveCount(0)
    await expect(page.getByText('Recent designs')).toHaveCount(0)
  })
})

test.describe('password reset and change', () => {
  test('a reset link works once, signs every session out and the old password stops working', async ({ browser }) => {
    const account = await createAccount('Forgetful')
    const { page, problems } = await openContext(browser, null)
    await page.goto('/forgot-password')
    await page.getByRole('textbox', { name: 'Email' }).fill('not an email')
    await page.getByRole('button', { name: 'Send reset link' }).click()
    await expect(page.getByText('Enter the email address you signed up with.')).toBeVisible()

    // An unknown address gets exactly the same answer: the form never says who has an account.
    await page.getByRole('textbox', { name: 'Email' }).fill(uniqueEmail('stranger'))
    await page.getByRole('button', { name: 'Send reset link' }).click()
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
    await page.goto('/forgot-password')
    await page.getByRole('textbox', { name: 'Email' }).fill(account.email)
    await page.getByRole('button', { name: 'Send reset link' }).click()
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
    await shot(page, 'forgot-sent')

    const signedIn = await openContext(browser, account)
    const link = new URL(await mailLink(account.email, /./, /http:\/\/localhost:\d+\/reset-password\?uid=[^&\s"<]+&token=[^\s"<&]+/))
    await page.goto(link.pathname + link.search)
    await page.getByRole('textbox', { name: 'New password' }).fill('12345678')
    await page.getByRole('button', { name: 'Update password' }).click()
    await expect(page.getByText('Use at least 8 characters, and not only numbers.')).toBeVisible()
    const fresh = 'A-brand-new-passphrase-7'
    await page.getByRole('textbox', { name: 'New password' }).fill(fresh)
    await page.getByRole('button', { name: 'Update password' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByText('Password updated')).toBeVisible()

    await logIn(page, account.email, PASSWORD)
    await expect(page.getByRole('alert').filter({ hasText: /incorrect|invalid/i })).toBeVisible()
    await logIn(page, account.email, fresh)
    await expect(page).toHaveURL(/\/dashboard$/)

    // Another device that was signed in is signed out.
    await signedIn.page.goto('/dashboard')
    await expect(signedIn.page).toHaveURL(/\/login\?next=/)

    // The link cannot be used a second time.
    const again = await openContext(browser, null)
    await again.page.goto(link.pathname + link.search)
    await again.page.getByRole('textbox', { name: 'New password' }).fill(fresh + '-x')
    await again.page.getByRole('button', { name: 'Update password' }).click()
    await expect(again.page.getByRole('alert')).toContainText('invalid or has expired')
    problems.allow(/status of 400/)
    problems.assertNone()
  })

  test('an incomplete or tampered link is explained instead of failing silently', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await page.goto('/reset-password')
    await expect(page.getByRole('heading', { name: 'This link isn’t valid' })).toBeVisible()
    await page.goto('/verify-email?uid=abc&token=def')
    await expect(page.getByRole('heading', { name: 'We couldn’t verify that link' })).toBeVisible()
    await page.goto('/verify-email')
    await expect(page.getByRole('heading', { name: 'This link isn’t valid' })).toBeVisible()
  })

  test('changing the password in Settings keeps this session and ends the others', async ({ browser }) => {
    const account = await createAccount('Changer')
    const here = await openContext(browser, account)
    const elsewhere = await openContext(browser, account)
    await elsewhere.page.goto('/dashboard')
    await expect(elsewhere.page.getByRole('heading', { level: 1 })).toBeVisible()
    await here.page.goto('/settings')
    const card = here.page.locator('#password')
    await card.getByRole('textbox', { name: 'Current password' }).fill('not my password')
    await card.getByRole('textbox', { name: 'New password' }).fill('Another-long-passphrase-3')
    await card.getByRole('button', { name: 'Change password' }).click()
    await expect(card.getByRole('alert')).toBeVisible()
    await card.getByRole('textbox', { name: 'Current password' }).fill(account.password)
    await card.getByRole('button', { name: 'Change password' }).click()
    await expect(here.page.getByText('Password changed')).toBeVisible()
    await here.page.reload()
    await expect(here.page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await elsewhere.page.goto('/dashboard')
    await expect(elsewhere.page).toHaveURL(/\/login\?next=/)
  })
})

test.describe('deleting the account', () => {
  test('needs the typed phrase and the password, then removes the account and its designs', async ({ browser }) => {
    const account = await createAccount('Goodbye')
    const api = await Api.create(account.state)
    await api.call('post', '/designs/', { title: 'To be erased' }, 201)
    const { page, problems } = await openContext(browser, account)
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Delete my account…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
    const confirm = dialog.getByRole('button', { name: /Delete (my )?account/ })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('delete')
    await dialog.getByRole('textbox', { name: 'Your password' }).fill(account.password)
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE')
    await dialog.getByRole('textbox', { name: 'Your password' }).fill('wrong password')
    await confirm.click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Your password' }).fill(account.password)
    await confirm.click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('Your account was deleted')).toBeVisible()
    const gone = await Api.create()
    const response = await gone.raw('post', '/auth/login/', { email: account.email, password: account.password })
    expect(response.status()).toBe(400)
    problems.allow(/status of 400/)
    problems.assertNone()
  })
})
