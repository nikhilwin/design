import type { Locator, Page } from '@playwright/test'
import { expect, test, Api, createAccount, openContext, shot, type Account } from './support/stack'
import { seedDesigns } from './support/seed'

const card = (page: Page, title: string): Locator => page.locator('article').filter({ has: page.getByRole('link', { name: title, exact: true }) })
const cardTitles = async (page: Page): Promise<string[]> => page.locator('article a[title]').evaluateAll((links) => links.map((link) => link.getAttribute('title') ?? ''))
const menuOf = async (page: Page, title: string, item: string): Promise<void> => {
  await page.getByRole('button', { name: `More actions for ${title}` }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

async function signedInPage(browser: Parameters<typeof openContext>[0], account: Account, path: string, options: Parameters<typeof openContext>[2] = {}) {
  const opened = await openContext(browser, account, options)
  await opened.page.goto(path)
  return opened
}

test.describe('designs', () => {
  test('a new account sees guidance, not an empty page', async ({ browser }) => {
    const account = await createAccount('Fresh Start')
    const { page, problems } = await signedInPage(browser, account, '/dashboard')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Fresh')
    await expect(page.getByRole('heading', { name: 'Make your first design' })).toBeVisible()
    await shot(page, 'dashboard-empty')
    await page.getByRole('link', { name: 'Designs', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'No designs yet' })).toBeVisible()
    await page.getByRole('link', { name: 'Trash', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Empty trash' })).toBeDisabled()
    problems.assertNone()
  })

  test('150 designs load page by page as the list is scrolled, each exactly once', async ({ browser }) => {
    test.setTimeout(240_000)
    const account = await createAccount('Many Designs')
    const api = await Api.create(account.state)
    await seedDesigns(api, 150, { prefix: 'Series', thumbnails: false })
    const { page, problems } = await signedInPage(browser, account, '/dashboard/designs?sort=title')
    await expect(page.getByRole('heading', { name: 'Your designs' })).toBeVisible()
    await expect.poll(async () => (await cardTitles(page)).length).toBeGreaterThan(0)
    const first = (await cardTitles(page)).length
    expect(first).toBeLessThan(150)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 20_000)
          return (await cardTitles(page)).length
        },
        { timeout: 60_000, intervals: [300] },
      )
      .toBe(150)
    const titles = await cardTitles(page)
    expect(new Set(titles).size).toBe(150)
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'en', { numeric: false })))
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
    problems.assertNone()
  })

  test('searches, sorts and remembers the layout', async ({ browser }) => {
    const account = await createAccount('Searcher')
    const api = await Api.create(account.state)
    for (const title of ['Summer sale banner', 'Winter sale banner', 'Birthday card', 'Annual report']) await api.call('post', '/designs/', { title }, 201)
    const { page, problems } = await signedInPage(browser, account, '/dashboard/designs')
    await expect.poll(() => cardTitles(page)).toEqual(['Annual report', 'Birthday card', 'Winter sale banner', 'Summer sale banner'])

    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('title')
    await expect(page).toHaveURL(/sort=title/)
    await expect.poll(() => cardTitles(page)).toEqual(['Annual report', 'Birthday card', 'Summer sale banner', 'Winter sale banner'])
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('-title')
    await expect.poll(() => cardTitles(page)).toEqual(['Winter sale banner', 'Summer sale banner', 'Birthday card', 'Annual report'])

    await page.getByRole('searchbox', { name: 'Search your designs' }).fill('SALE')
    await page.getByRole('searchbox', { name: 'Search your designs' }).press('Enter')
    await expect(page).toHaveURL(/q=SALE/)
    await expect(page.getByRole('heading', { name: 'Results for “SALE”' })).toBeVisible()
    await expect.poll(() => cardTitles(page)).toEqual(['Winter sale banner', 'Summer sale banner'])
    await page.getByRole('searchbox', { name: 'Search your designs' }).fill('zzz nothing')
    await page.getByRole('searchbox', { name: 'Search your designs' }).press('Enter')
    await expect(page.getByRole('heading', { name: 'No designs match “zzz nothing”' })).toBeVisible()
    await page.getByRole('button', { name: 'Clear search' }).first().click()
    await expect(page.getByRole('heading', { name: 'Your designs' })).toBeVisible()

    await page.getByRole('radio', { name: 'List view' }).click()
    await expect(page.locator('article[data-layout="list"]').first()).toBeVisible()
    await shot(page, 'designs-list-view')
    await page.reload()
    await expect(page.locator('article[data-layout="list"]').first()).toBeVisible()
    problems.assertNone()
  })

  test('rename, star, duplicate, trash with undo, restore and delete forever', async ({ browser }) => {
    const account = await createAccount('Housekeeper')
    const api = await Api.create(account.state)
    await api.call('post', '/designs/', { title: 'Poster' }, 201)
    const { page, problems } = await signedInPage(browser, account, '/dashboard/designs')

    await menuOf(page, 'Poster', 'Rename')
    const rename = page.getByRole('textbox', { name: 'Rename Poster' })
    await rename.fill('Poster v2')
    await rename.press('Enter')
    await expect(card(page, 'Poster v2')).toBeVisible()
    await menuOf(page, 'Poster v2', 'Rename')
    await page.getByRole('textbox', { name: 'Rename Poster v2' }).fill('discarded')
    await page.keyboard.press('Escape')
    await expect(card(page, 'Poster v2')).toBeVisible()

    await page.getByRole('button', { name: 'Star Poster v2' }).click()
    await expect(page.getByRole('button', { name: 'Remove Poster v2 from starred' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Remove Poster v2 from starred' })).toBeVisible()

    await menuOf(page, 'Poster v2', 'Duplicate')
    await expect(page.getByText('Design duplicated')).toBeVisible()
    await expect(card(page, 'Copy of Poster v2')).toBeVisible()

    await menuOf(page, 'Copy of Poster v2', 'Move to trash')
    const toast = page.getByRole('status').filter({ hasText: 'Moved to trash' })
    await expect(toast).toBeVisible()
    await expect(card(page, 'Copy of Poster v2')).toHaveCount(0)
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(card(page, 'Copy of Poster v2')).toBeVisible()

    await menuOf(page, 'Copy of Poster v2', 'Move to trash')
    await page.getByRole('link', { name: 'Trash', exact: true }).first().click()
    await expect(page.getByRole('main').getByText('Copy of Poster v2')).toBeVisible()
    await page.getByRole('button', { name: 'Restore' }).click()
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
    await page.getByRole('link', { name: 'Designs', exact: true }).first().click()
    await menuOf(page, 'Copy of Poster v2', 'Move to trash')
    await page.getByRole('link', { name: 'Trash', exact: true }).first().click()
    await page.getByRole('button', { name: 'Delete Copy of Poster v2 forever' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('can’t be undone')
    await confirm.getByRole('button', { name: 'Delete forever' }).click()
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
    const remaining = await api.call<{ results: { title: string }[] }>('get', '/designs/')
    expect(remaining.results.map((design) => design.title)).toEqual(['Poster v2'])
    problems.assertNone()
  })

  test('selects several designs and stars, moves or trashes them together', async ({ browser }) => {
    const account = await createAccount('Bulk Barbara')
    const api = await Api.create(account.state)
    for (const title of ['One', 'Two', 'Three', 'Four']) await api.call('post', '/designs/', { title }, 201)
    const folder = await api.call<{ id: string }>('post', '/folders/', { name: 'Keepers' }, 201)
    const { page, problems } = await signedInPage(browser, account, '/dashboard/designs')
    await page.getByRole('checkbox', { name: 'Select One' }).check()
    await page.getByRole('checkbox', { name: 'Select Two' }).check()
    const bar = page.getByRole('region', { name: 'Selected designs' })
    await expect(bar).toContainText('2 selected')
    await shot(page, 'designs-bulk-bar')
    await bar.getByRole('button', { name: 'Star', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove One from starred' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove Two from starred' })).toBeVisible()

    await bar.getByRole('button', { name: 'Move' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /Keepers/ }).click()
    await expect(page.getByText('2 designs moved to Keepers')).toBeVisible()
    await expect(card(page, 'One')).toHaveCount(0)
    await expect.poll(async () => (await api.call<{ results: { folder: string }[] }>('get', `/designs/?folder=${folder.id}`)).results.length).toBe(2)

    await page.getByRole('checkbox', { name: 'Select Three' }).check()
    await page.getByRole('checkbox', { name: 'Select Four' }).check()
    await page.keyboard.press('Escape')
    await expect(bar).toHaveCount(0)
    await page.getByRole('checkbox', { name: 'Select Three' }).check()
    await page.getByRole('checkbox', { name: 'Select Four' }).check()
    await page.getByRole('region', { name: 'Selected designs' }).getByRole('button', { name: 'Trash' }).click()
    await expect(page.getByText('2 designs moved to trash')).toBeVisible()
    await page.getByRole('status').filter({ hasText: '2 designs moved to trash' }).getByRole('button', { name: 'Undo' }).click()
    await expect(card(page, 'Three')).toBeVisible()
    problems.assertNone()
  })
})

test.describe('folders', () => {
  test('creates, fills, renames and deletes a folder; the new-folder dialog starts empty each time', async ({ browser }) => {
    const account = await createAccount('Folder Fan')
    const api = await Api.create(account.state)
    await api.call('post', '/designs/', { title: 'Loose design' }, 201)
    const { page, problems } = await signedInPage(browser, account, '/dashboard/designs')

    await page.getByRole('button', { name: 'New folder' }).click()
    const name = page.getByRole('textbox', { name: 'Folder name' })
    await name.fill('Clients')
    await page.getByRole('button', { name: 'Create folder' }).click()
    await expect(page.getByText('Folder created')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'New folder' }).click()
    await expect(page.getByRole('textbox', { name: 'Folder name' })).toHaveValue('')
    await page.keyboard.press('Escape')

    await menuOf(page, 'Loose design', 'Move to folder…')
    await page.getByRole('dialog').getByRole('button', { name: /Clients/ }).click()
    await expect(card(page, 'Loose design')).toHaveCount(0)
    await page.getByRole('link', { name: /Clients/ }).first().click()
    await expect(page).toHaveURL(/\/dashboard\/designs\/folder\//)
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible()
    await expect(card(page, 'Loose design')).toBeVisible()
    await shot(page, 'designs-folder')
    await page.getByRole('link', { name: 'All designs' }).click()
    await page.getByRole('button', { name: 'More actions for folder Clients' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete folder' }).click()
    await expect(page.getByText('Folder deleted')).toBeVisible()
    await expect(card(page, 'Loose design')).toBeVisible()
    problems.assertNone()
  })
})

test.describe('loading, empty and error states', () => {
  test('a failing list says so and recovers when retried', async ({ browser }) => {
    const account = await createAccount('Flaky Network')
    const api = await Api.create(account.state)
    await api.call('post', '/designs/', { title: 'Still here' }, 201)
    let fail = true
    const { page, problems } = await openContext(browser, account, {
      before: async (target) => {
        await target.route('**/api/v1/designs/?*', (route) => (fail ? route.fulfill({ status: 500, json: { error: { code: 'server_error', message: 'boom' } } }) : route.continue()))
      },
    })
    await page.goto('/dashboard/designs')
    await expect(page.getByRole('heading', { name: 'Your designs didn’t load' })).toBeVisible()
    await shot(page, 'designs-error')
    fail = false
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(card(page, 'Still here')).toBeVisible()
    problems.allow(/HTTP 500/)
    problems.allow(/status of 500/)
    problems.assertNone()
  })

  test('shows placeholders while a slow list loads', async ({ browser }) => {
    const account = await createAccount('Slow Network')
    const { page } = await openContext(browser, account, {
      before: async (target) => {
        await target.route('**/api/v1/designs/?*', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          await route.continue()
        })
      },
    })
    await page.goto('/dashboard/designs')
    await expect(page.getByRole('list', { name: 'Loading designs' })).toBeVisible()
    await shot(page, 'designs-loading')
    await expect(page.getByRole('heading', { name: 'No designs yet' })).toBeVisible()
  })

  test('going offline shows the banner, and the page recovers when the connection returns', async ({ browser }) => {
    const account = await createAccount('Offline Olive')
    const { page, context } = await signedInPage(browser, account, '/dashboard/designs')
    await expect(page.getByRole('heading', { name: 'No designs yet' })).toBeVisible()
    await context.setOffline(true)
    const banner = page.getByRole('status').filter({ hasText: 'You’re offline.' })
    await expect(banner).toBeVisible()
    await shot(page, 'offline-banner')
    await context.setOffline(false)
    await expect(banner).toHaveCount(0)
  })
})
