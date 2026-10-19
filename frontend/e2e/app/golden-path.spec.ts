/**
 * The regression suite for the public release: one visitor's whole journey through the real stack.
 * Guest edit, Save and sign up, dashboard, reopen, share, a second user opens the link and comments, the owner sees it,
 * trash, restore, delete forever, and the link stops working.
 */
import { addHeading } from './support/editor'
import { expect, test, Api, createAccount, openContext, PASSWORD, shot, uniqueEmail } from './support/stack'

test('guest edit, save, dashboard, reopen, share, comment from another account, trash, restore, delete', async ({ browser }) => {
  test.setTimeout(240_000)
  const canvas = (page: import('@playwright/test').Page) => page.locator('[data-artboard] .doory-canvas').first()

  // 1. A guest starts from the landing page and writes something.
  const owner = await openContext(browser, null)
  await owner.page.goto('/')
  await owner.page.getByRole('link', { name: 'Create a design', exact: true }).click()
  await expect(owner.page).toHaveURL(/\/local\//)
  await expect(canvas(owner.page)).toBeVisible({ timeout: 30_000 })
  await addHeading(owner.page, 'Golden path')
  await owner.page.keyboard.press('Escape')
  await shot(owner.page, 'golden-1-guest')

  // 2. Sign up keeps the work: the design moves into the new account.
  await owner.page.getByRole('button', { name: 'Sign up' }).click()
  const dialog = owner.page.getByRole('dialog', { name: 'Create a free account to keep this design' })
  const email = uniqueEmail('golden owner')
  await dialog.getByRole('textbox', { name: 'Email' }).fill(email)
  await dialog.getByRole('textbox', { name: 'Password' }).fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Create free account' }).click()
  await expect(owner.page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  const designId = /\/design\/([0-9a-f-]{36})$/.exec(owner.page.url())?.[1] ?? ''
  await expect(canvas(owner.page)).toBeVisible({ timeout: 30_000 })
  const api = await Api.signedIn({ email, password: PASSWORD })

  // 3. It is on the dashboard and opens again with its content.
  await owner.page.getByRole('link', { name: 'Back to your dashboard' }).click()
  await expect(owner.page).toHaveURL(/\/dashboard$/)
  await owner.page.getByRole('link', { name: 'Designs', exact: true }).first().click()
  const cards = owner.page.locator('article')
  await expect(cards).toHaveCount(1)
  await shot(owner.page, 'golden-2-dashboard')
  await cards.first().getByRole('link').last().click()
  await expect(canvas(owner.page)).toBeVisible({ timeout: 30_000 })
  expect(JSON.stringify((await api.call<{ document: unknown }>('get', `/designs/${designId}/`)).document)).toContain('Golden path')

  // 4. The owner shares it with a link that allows comments.
  await owner.page.getByTestId('ed-share').click()
  const share = owner.page.getByRole('dialog', { name: 'Share design' })
  await share.getByTestId('share-role').selectOption('comment')
  await share.getByTestId('share-create').click()
  const link = await share.getByRole('textbox', { name: 'Link address' }).inputValue()
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{8,}$/)
  await shot(owner.page, 'golden-3-share')
  await owner.page.keyboard.press('Escape')

  // 5. Somebody else, signed in, opens the link and comments.
  const reviewer = await createAccount('Golden Reviewer')
  const guest = await openContext(browser, reviewer)
  await guest.page.goto(new URL(link).pathname)
  await expect(canvas(guest.page)).toBeVisible({ timeout: 30_000 })
  await expect(guest.page.getByText('Shared by')).toBeVisible()
  await guest.page.getByTestId('ed-end-comments').click()
  await expect(guest.page.getByTestId('comments-panel')).toBeVisible()
  const box = await guest.page.locator('[data-artboard]').first().boundingBox()
  if (!box) throw new Error('no artboard')
  await guest.page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await guest.page.getByTestId('pin-compose-text').fill('Love it. Can the title be bigger?')
  await guest.page.getByTestId('pin-compose-send').click()
  await expect(guest.page.getByTestId('comment-pin')).toHaveCount(1)
  await shot(guest.page, 'golden-4-reviewer')

  // 6. The owner sees the comment after a reload.
  await owner.page.reload()
  await expect(canvas(owner.page)).toBeVisible({ timeout: 30_000 })
  await owner.page.getByTestId('ed-end-comments').click()
  await expect(owner.page.getByTestId('comment-pin')).toHaveCount(1, { timeout: 15_000 })
  await expect(owner.page.getByTestId('comments-panel')).toContainText('Love it. Can the title be bigger?')
  await shot(owner.page, 'golden-5-owner-sees-comment')

  // 7. Trash, restore, trash again, delete for good.
  await owner.page.goto('/dashboard/designs')
  await owner.page.getByRole('button', { name: /More actions for/ }).click()
  await owner.page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(cards).toHaveCount(0)
  await owner.page.getByRole('link', { name: 'Trash', exact: true }).first().click()
  await owner.page.getByRole('button', { name: 'Restore' }).click()
  await expect(owner.page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
  await owner.page.getByRole('link', { name: 'Designs', exact: true }).first().click()
  await expect(cards).toHaveCount(1)
  await owner.page.getByRole('button', { name: /More actions for/ }).click()
  await owner.page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await owner.page.getByRole('link', { name: 'Trash', exact: true }).first().click()

  // A trashed design's link already stops working.
  await guest.page.reload()
  await expect(guest.page.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible()

  await owner.page.getByRole('button', { name: /Delete .* forever/ }).click()
  await owner.page.getByRole('alertdialog').getByRole('button', { name: 'Delete forever' }).click()
  await expect(owner.page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible()
  await expect.poll(async () => (await api.call<{ count: number }>('get', '/designs/?trashed=true')).count).toBe(0)
  owner.problems.allow(/WebSocket connection/)
  guest.problems.allow(/WebSocket connection/)
  owner.problems.assertNone()
  guest.problems.assertNone()
})
