import type { Page } from '@playwright/test'
import { expect, test, Api, createAccount, openContext, shot } from './support/stack'
import { addHeading, editorReady } from './support/editor'
import { seedDesigns } from './support/seed'

interface DesignDoc {
  document: { pages: { objects: { type: string; text?: string }[] }[] }
}

async function typeHeading(page: Page, text: string): Promise<void> {
  await editorReady(page)
  await addHeading(page, text)
}

async function savedTexts(accountApi: Api, id: string): Promise<string[]> {
  const design = await accountApi.call<DesignDoc>('get', `/designs/${id}/`)
  return design.document.pages.flatMap((entry) => entry.objects.map((object) => object.text ?? ''))
}

test.describe('session ends while a design is open', () => {
  test('the editor stays, a sign-in prompt appears, and signing in again keeps saving', async ({ browser }) => {
    const account = await createAccount('Expiry Eve')
    const api = await Api.create(account.state)
    const [design] = await seedDesigns(api, 1, { thumbnails: false })
    const { page, problems } = await openContext(browser, account)
    await page.goto(`/design/${design!.id}`)
    await typeHeading(page, 'Written before')

    // The session dies on the server (signed out on another device).
    await api.call('post', '/auth/logout/', undefined, 204)
    await page.keyboard.type(' and after')

    const dialog = page.getByRole('dialog', { name: 'Your session ended' })
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(page).toHaveURL(new RegExp(`/design/${design!.id}$`))
    await expect(dialog.getByLabel('Email')).toHaveValue(account.email)
    await expect(dialog.getByLabel('Email')).toHaveAttribute('readonly', '')
    await shot(page, 'session-expired-dialog')

    // The live connection reports the ended session a moment after the first request does; its request joins the open dialog,
    // so the dialog is dismissed only once the editor's own banner is up (dismissing earlier lets the late request open it again).
    const bar = page.getByTestId('collab-banner')
    await expect(bar).toContainText('Your session ended')
    // Dismissing the dialog leaves the editor, whose banner brings the prompt back.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible()
    await shot(page, 'session-expired-banner')
    await bar.getByRole('button', { name: 'Sign in' }).click()
    await expect(dialog).toBeVisible()

    // A wrong password is explained; the right one restores the session without leaving the page.
    await dialog.getByRole('textbox', { name: 'Password' }).fill('not the password')
    await dialog.getByRole('button', { name: 'Log in' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Incorrect email or password')
    await dialog.getByRole('textbox', { name: 'Password' }).fill(account.password)
    await dialog.getByRole('button', { name: 'Log in' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/design/${design!.id}$`))

    // What was typed before and after the session ended reaches the account.
    const fresh = await Api.signedIn(account)
    await expect.poll(async () => (await savedTexts(fresh, design!.id)).join('|'), { timeout: 30_000 }).toContain('Written before and after')
    problems.allow(/WebSocket connection/)
    problems.assertNone()
  })

  test('without live co-editing a bar over the editor offers the sign-in, and the next save goes through', async ({ browser }) => {
    const account = await createAccount('Rest Only')
    const api = await Api.create(account.state)
    const [design] = await seedDesigns(api, 1, { thumbnails: false })
    const { page } = await openContext(browser, account, {
      before: async (target) => {
        await target.route('**/api/v1/config/', async (route) => {
          const response = await route.fetch()
          const config = (await response.json()) as { features: Record<string, boolean> }
          await route.fulfill({ response, json: { ...config, features: { ...config.features, realtime: false } } })
        })
      },
    })
    await page.goto(`/design/${design!.id}`)
    await typeHeading(page, 'Saved over REST')
    await expect.poll(async () => (await savedTexts(api, design!.id)).join('|'), { timeout: 20_000 }).toContain('Saved over REST')

    await api.call('post', '/auth/logout/', undefined, 204)
    await page.keyboard.type(' again')
    const dialog = page.getByRole('dialog', { name: 'Your session ended' })
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await page.keyboard.press('Escape')
    const bar = page.getByRole('alert').filter({ hasText: 'Your session ended' })
    await expect(bar).toContainText(account.email)
    await shot(page, 'session-expired-bar')
    await bar.getByRole('button', { name: 'Sign in' }).click()
    await dialog.getByRole('textbox', { name: 'Password' }).fill(account.password)
    await dialog.getByRole('button', { name: 'Log in' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(bar).toHaveCount(0)
    const fresh = await Api.signedIn(account)
    await expect.poll(async () => (await savedTexts(fresh, design!.id)).join('|'), { timeout: 30_000 }).toContain('Saved over REST again')
  })
})
