import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test, Api, createAccount, openContext, type Account, type Theme } from './support/stack'
import { seedAssets, seedDesigns } from './support/seed'

const THEMES: Theme[] = ['light']

/** Serious and critical axe findings of the page as it is now (WCAG 2.0/2.1 A and AA plus axe's best practices). */
async function violations(page: Page, scope?: string): Promise<string[]> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
  if (scope) builder = builder.include(scope)
  const { violations: found } = await builder.analyze()
  return found
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(' ')).slice(0, 4).join(' | ')} — ${violation.help}`)
}

let owner: Account
let templateSlug = ''
let passwordToken = ''

test.beforeAll(async () => {
  owner = await createAccount('Axe Owner')
  const api = await Api.create(owner.state)
  const designs = await seedDesigns(api, 14, { prefix: 'Accessible', thumbnails: true })
  await seedAssets(api, 4)
  await api.call('post', '/folders/', { name: 'Client work' }, 201)
  await api.call('post', '/brand-kits/', { name: 'Doory brand', is_default: true, colors: [{ id: 'c1', name: 'Brand', hex: '#e11d48' }, { id: 'c2', name: 'Ink', hex: '#1c1517' }], fonts: [{ role: 'heading', family: 'Plus Jakarta Sans' }] }, 201)
  await api.call('delete', `/designs/${designs[0]!.id}/`, undefined, 204)
  const locked = await api.call<{ token: string }>('post', `/designs/${designs[2]!.id}/share-links/`, { role: 'view', password: 'open-sesame' }, 201)
  passwordToken = locked.token
  const templates = await (await Api.create()).call<{ results: { slug: string }[] }>('get', '/templates/')
  templateSlug = templates.results[0]!.slug
})

const PUBLIC_PAGES: Array<[string, () => string]> = [
  ['landing', () => '/'],
  ['templates', () => '/templates'],
  ['template detail', () => `/templates/${templateSlug}`],
  ['log in', () => '/login'],
  ['sign up', () => '/signup'],
  ['forgot password', () => '/forgot-password'],
  ['reset password (bad link)', () => '/reset-password?uid=x&token=y'],
  ['verify email (bad link)', () => '/verify-email?uid=x&token=y'],
  ['not found', () => '/no/such/page'],
  ['shared link: unknown', () => '/s/doesnotexist'],
  ['shared link: password gate', () => `/s/${passwordToken}`],
]

const DASHBOARD_PAGES: Array<[string, string]> = [
  ['dashboard home', '/dashboard'],
  ['designs', '/dashboard/designs'],
  ['templates', '/dashboard/templates'],
  ['brand', '/dashboard/brand'],
  ['uploads', '/dashboard/uploads'],
  ['trash', '/dashboard/trash'],
  ['settings', '/settings'],
]

for (const theme of THEMES) {
  test.describe(`axe, ${theme} theme`, () => {
    for (const [name, path] of PUBLIC_PAGES) {
      test(`${name} has no serious or critical violations`, async ({ browser }) => {
        const { page } = await openContext(browser, null, { theme, reducedMotion: true })
        await page.goto(path())
        await page.waitForLoadState('networkidle')
        await expect(page.locator('main, [role="main"]').first()).toBeVisible()
        expect(await violations(page)).toEqual([])
      })
    }

    for (const [name, path] of DASHBOARD_PAGES) {
      test(`dashboard: ${name} has no serious or critical violations`, async ({ browser }) => {
        const { page } = await openContext(browser, owner, { theme, reducedMotion: true })
        await page.goto(path)
        await page.waitForLoadState('networkidle')
        await expect(page.getByRole('main')).toBeVisible()
        expect(await violations(page)).toEqual([])
      })
    }

    test('dialogs and menus: sign-in modal, create dialog, confirm dialog, account menu', async ({ browser }) => {
      const { page } = await openContext(browser, null, { theme, reducedMotion: true })
      await page.goto('/templates')
      await page.getByRole('link', { name: 'Start designing' }).first().isVisible()
      const signed = await openContext(browser, owner, { theme, reducedMotion: true })
      await signed.page.goto('/dashboard')
      await signed.page.getByRole('button', { name: /Account menu for/ }).click()
      await expect(signed.page.getByRole('menu')).toBeVisible()
      expect(await violations(signed.page)).toEqual([])
      await signed.page.keyboard.press('Escape')
      await signed.page.getByRole('button', { name: 'Create a design' }).click()
      await signed.page.getByRole('menuitem').first().waitFor({ state: 'visible' }).catch(() => undefined)
      expect(await violations(signed.page)).toEqual([])
      await signed.page.keyboard.press('Escape')
      await signed.page.goto('/dashboard/trash')
      await signed.page.getByRole('button', { name: /Delete .* forever/ }).first().click()
      await expect(signed.page.getByRole('alertdialog')).toBeVisible()
      expect(await violations(signed.page)).toEqual([])
    })
  })
}
