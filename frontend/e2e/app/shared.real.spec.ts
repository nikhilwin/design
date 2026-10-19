import type { Page } from '@playwright/test'
import { expect, test, Api, createAccount, openContext, PASSWORD, shot, uniqueEmail, type Account } from './support/stack'
import { addHeading } from './support/editor'
import { simpleDocument } from './support/seed'

interface Link {
  id: string
  token: string
  url: string
}

interface Shared {
  owner: Account
  api: Api
  designId: string
  link(role: 'view' | 'comment' | 'edit', extra?: Record<string, unknown>): Promise<Link>
}

async function owned(title: string): Promise<Shared> {
  const owner = await createAccount(`Owner of ${title}`)
  const api = await Api.create(owner.state)
  const design = await api.call<{ id: string }>('post', '/designs/', { title, width: 800, height: 600, document: simpleDocument(title) }, 201)
  return { owner, api, designId: design.id, link: (role, extra = {}) => api.call<Link>('post', `/designs/${design.id}/share-links/`, { role, ...extra }, 201) }
}

const canvas = (page: Page) => page.locator('[data-artboard] .doory-canvas').first()

async function expectBrokenLink(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Design something of your own' })).toHaveAttribute('href', '/create')
}

test.describe('share links', () => {
  test('a view link opens read-only for anybody, with the owner named and nothing to sign in for', async ({ browser }) => {
    const shared = await owned('Menu board')
    const link = await shared.link('view')
    const { page, problems } = await openContext(browser, null)
    const writes: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    })
    await page.goto(`/s/${link.token}`)
    await expect(canvas(page)).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveTitle(/Menu board/)
    await expect(page.getByText(`Shared by ${shared.owner.name}`)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Design your own' })).toHaveAttribute('href', '/create')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await shot(page, 'shared-view')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.waitForTimeout(1500)
    expect(writes.filter((entry) => !entry.includes('/auth/csrf'))).toEqual([])
    problems.assertNone()
  })

  test('a comment link asks a visitor to sign in before commenting, then the comment reaches the owner', async ({ browser }) => {
    const shared = await owned('Review me')
    const link = await shared.link('comment')
    const visitor = await createAccount('Reviewer Rae')
    const { page } = await openContext(browser, null)
    await page.goto(`/s/${link.token}`)
    await expect(canvas(page)).toBeVisible({ timeout: 30_000 })
    // Anybody may read the comments; writing one asks for an account.
    await page.getByTestId('ed-end-comments').click()
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    const box = await page.locator('[data-artboard]').first().boundingBox()
    if (!box) throw new Error('no artboard')
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4)
    const dialog = page.getByRole('dialog', { name: 'Sign in to comment' })
    await expect(dialog).toBeVisible()
    await shot(page, 'shared-comment-signin')
    await dialog.getByRole('tab', { name: 'Log in' }).click()
    await dialog.getByRole('textbox', { name: 'Email' }).fill(visitor.email)
    await dialog.getByRole('textbox', { name: 'Password' }).fill(visitor.password)
    await dialog.getByRole('button', { name: 'Log in', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // Signing in joins the live room, which rebuilds the editor: open the comments again (that starts comment mode) and place the comment.
    await expect(page.getByRole('status', { name: /Watching live/ })).toBeVisible()
    await page.getByTestId('ed-end-comments').click()
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4)
    await page.getByTestId('pin-compose-text').fill('Please make the logo bigger')
    await page.getByTestId('pin-compose-send').click()
    await expect(page.getByTestId('comment-pin')).toHaveCount(1)
    // The pin shows at once (optimistic); the owner's side of the story is whatever the server has stored.
    await expect
      .poll(async () => {
        const rows = await shared.api.call<{ results: { body: string; author: { name: string } }[] }>('get', `/designs/${shared.designId}/comments/`)
        return rows.results.map((row) => [row.body, row.author.name])
      })
      .toEqual([['Please make the logo bigger', 'Reviewer Rae']])
  })

  test('an edit link needs an account: the page says so, signing up lets the visitor in, and their change reaches the owner', async ({ browser }) => {
    const shared = await owned('Co-authored')
    const link = await shared.link('edit')
    const { page } = await openContext(browser, null)
    await page.goto(`/s/${link.token}`)
    await expect(page.getByRole('heading', { name: 'Sign in to edit “Co-authored”' })).toBeVisible()
    await shot(page, 'shared-edit-gate')
    await page.getByRole('button', { name: 'Sign in to edit' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Sign up' }).click()
    await dialog.getByRole('textbox', { name: 'Email' }).fill(uniqueEmail('editor eve'))
    await dialog.getByRole('textbox', { name: 'Password' }).fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Create free account' }).click()
    await expect(canvas(page)).toBeVisible({ timeout: 30_000 })
    await addHeading(page, 'Added by a guest editor')
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => JSON.stringify((await shared.api.call<{ document: unknown }>('get', `/designs/${shared.designId}/`)).document), { timeout: 30_000 })
      .toContain('Added by a guest editor')
  })

  test('a password-protected link asks for the password, says when it is wrong and opens with the right one', async ({ browser }) => {
    const shared = await owned('Private preview')
    const link = await shared.link('view', { password: 'open-sesame' })
    const { page, problems } = await openContext(browser, null)
    await page.goto(`/s/${link.token}`)
    await expect(page.getByRole('heading', { name: 'This design is protected' })).toBeVisible()
    await expect(page).toHaveTitle(/Password required/)
    await page.getByLabel('Password').fill('not-it')
    await page.getByRole('button', { name: 'Open design' }).click()
    await expect(page.getByText('That password isn’t right. Try again.')).toBeVisible()
    await shot(page, 'shared-password-wrong')
    await page.getByLabel('Password').fill('open-sesame')
    await page.getByRole('button', { name: 'Open design' }).click()
    await expect(canvas(page)).toBeVisible({ timeout: 30_000 })
    problems.assertNone()
  })

  test('guessing the password too often is stopped and the page says to wait, not that the link is broken', async ({ browser }) => {
    const shared = await owned('Guess limit')
    const link = await shared.link('view', { password: 'open-sesame' })
    const { page } = await openContext(browser, null)
    await page.goto(`/s/${link.token}`)
    for (let attempt = 0; attempt < 11; attempt++) {
      await page.getByLabel('Password').fill(`wrong-${attempt}`)
      await page.getByRole('button', { name: 'Open design' }).click()
      await page.waitForTimeout(150)
    }
    await expect(page.getByText(/Too many attempts/)).toBeVisible()
    await shot(page, 'shared-password-throttled')
  })

  test('revoked, expired, unknown and trashed links all look the same', async ({ browser }) => {
    const shared = await owned('Going away')
    const revoked = await shared.link('view')
    const expiring = await shared.link('view', { expires_at: new Date(Date.now() + 4000).toISOString() })
    const trashedDesign = await owned('Trashed one')
    const trashedLink = await trashedDesign.link('view')
    await shared.api.call('delete', `/designs/${shared.designId}/share-links/${revoked.id}/`, undefined, 204)
    await trashedDesign.api.call('delete', `/designs/${trashedDesign.designId}/`, undefined, 204)
    await new Promise((resolve) => setTimeout(resolve, 4500))
    const { page, problems } = await openContext(browser, null)
    for (const token of [revoked.token, expiring.token, trashedLink.token, 'definitely-not-a-token', 'x'.repeat(32)]) {
      await page.goto(`/s/${token}`)
      await expectBrokenLink(page)
    }
    await shot(page, 'shared-broken')
    problems.assertNone()
  })

  test('the owner can open their own link, and turning the link off takes effect at once', async ({ browser }) => {
    const shared = await owned('Mine')
    const link = await shared.link('view')
    const { page } = await openContext(browser, shared.owner)
    await page.goto(`/s/${link.token}`)
    await expect(canvas(page)).toBeVisible({ timeout: 30_000 })
    await shared.api.call('patch', `/designs/${shared.designId}/share-links/${link.id}/`, { is_active: false })
    await page.reload()
    await expectBrokenLink(page)
  })
})
