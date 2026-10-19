import { expect, test, Api, createAccount, openContext, shot } from './support/stack'
import { seedDesigns } from './support/seed'
import { localTitles, seedLocalDesign } from './support/guest'

test.describe('landing page and its chrome', () => {
  test('on a phone nothing scrolls sideways and the menu opens, navigates and closes', async ({ browser }) => {
    const account = await createAccount('Phone Pat')
    const api = await Api.create(account.state)
    await seedDesigns(api, 3, { prefix: 'Phone', thumbnails: true })
    const guest = await openContext(browser, null, { viewport: { width: 390, height: 844 } })
    for (const path of ['/', '/templates', '/login', '/signup', '/forgot-password']) {
      await guest.page.goto(path)
      await guest.page.getByRole('heading').first().waitFor()
      await guest.page.waitForLoadState('networkidle')
      expect(await guest.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${path} overflows sideways`).toBeLessThanOrEqual(0)
    }
    await guest.page.goto('/')
    await guest.page.getByRole('button', { name: 'Open menu' }).click()
    const panel = guest.page.locator('#mobile-nav')
    await expect(panel).toBeVisible()
    await shot(guest.page, 'landing-mobile-menu')
    await panel.getByRole('link', { name: 'Templates' }).click()
    await expect(guest.page).toHaveURL(/\/templates$/)
    await expect(panel).toHaveCount(0)

    const signed = await openContext(browser, account, { viewport: { width: 390, height: 844 } })
    for (const path of ['/dashboard', '/dashboard/designs', '/dashboard/brand', '/dashboard/uploads', '/dashboard/trash', '/settings']) {
      await signed.page.goto(path)
      await signed.page.getByRole('heading', { level: 1 }).waitFor()
      await signed.page.waitForLoadState('networkidle')
      expect(await signed.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${path} overflows sideways`).toBeLessThanOrEqual(0)
    }
  })

  test('external links open safely, and a guest finds the designs kept in this browser', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await page.goto('/')
    const external = page.getByRole('link', { name: /GitHub|Source on GitHub|Report an issue|Self-host Doory|Contribute|Star on GitHub/ })
    for (const link of await external.all()) {
      await expect(link, await link.innerText()).toHaveAttribute('rel', /noopener/)
      await expect(link).toHaveAttribute('target', '_blank')
    }
    await expect(page.getByRole('heading', { name: 'Pick up where you left off' })).toHaveCount(0)
    const { designId } = await seedLocalDesign(page, { title: 'Kept in the browser' })
    await page.reload()
    const strip = page.getByRole('heading', { name: 'Pick up where you left off' })
    await expect(strip).toBeVisible()
    await page.getByRole('link', { name: /Kept in the browser/ }).click()
    await expect(page).toHaveURL(new RegExp(`/local/${designId}$`))
    expect(await localTitles(page)).toEqual(['Kept in the browser'])
  })
})
