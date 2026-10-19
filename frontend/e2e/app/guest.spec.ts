import type { Page } from '@playwright/test'
import { expect, test, Api, openContext, PASSWORD, shot, uniqueEmail } from './support/stack'
import { addHeading, editorReady } from './support/editor'
import { localAssetCount, localDesignsJson, localTitles, seedLocalDesign } from './support/guest'

interface ServerDesign {
  id: string
  title: string
  document: { pages: { objects: { type: string; src?: string; text?: string }[] }[] }
}

async function signUpInDialog(page: Page, email: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Create a free account to keep this design' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Email' }).fill(email)
  await dialog.getByRole('textbox', { name: 'Password' }).fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Create free account' }).click()
}

/** The designs of the account the page is signed in as, newest first, each with its document. */
async function accountDesigns(page: Page): Promise<ServerDesign[]> {
  const list = await page.evaluate(async () => (await fetch('/api/v1/designs/')).json() as Promise<{ results: { id: string }[] }>)
  return Promise.all(list.results.map((entry) => page.evaluate(async (id) => (await fetch(`/api/v1/designs/${id}/`)).json() as Promise<ServerDesign>, entry.id)))
}

async function openGuestDesign(page: Page, seed: Parameters<typeof seedLocalDesign>[1]): Promise<string> {
  await page.goto('/')
  const { designId } = await seedLocalDesign(page, seed)
  await page.goto(`/local/${designId}`)
  await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
  return designId
}

test.describe('a guest designs, then signs up', () => {
  test('starting from the landing page, the work survives a reload and Sign up moves it, images included, into the account', async ({ browser }) => {
    const { page, problems } = await openContext(browser, null)
    await page.goto('/')
    await page.getByRole('link', { name: 'Create a design', exact: true }).click()
    await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/)
    await editorReady(page)
    await addHeading(page, 'Made as a guest')
    await expect.poll(() => localDesignsJson(page), { message: 'the text reaches IndexedDB' }).toContain('Made as a guest')
    await page.reload()
    await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Saved in this browser')).toBeVisible()
    await shot(page, 'guest-editor-banner')

    await page.getByRole('button', { name: 'Sign up' }).click()
    await signUpInDialog(page, uniqueEmail('guest to account'))
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    await expect(page.getByText('Saved to your account')).toBeVisible()
    expect(await localTitles(page)).toEqual([])
    const designs = await accountDesigns(page)
    expect(designs).toHaveLength(1)
    expect(JSON.stringify(designs[0]?.document)).toContain('Made as a guest')
    problems.allow(/WebSocket connection/)
    problems.assertNone()
  })

  test('three images and a large page all arrive, rewritten to account URLs, and the local copies are cleaned up', async ({ browser }) => {
    test.setTimeout(150_000)
    const { page } = await openContext(browser, null)
    await openGuestDesign(page, { title: 'Photo wall', images: 3, rects: 400 })
    expect(await localAssetCount(page)).toBe(3)
    await page.getByRole('button', { name: 'Sign up' }).click()
    await signUpInDialog(page, uniqueEmail('photo wall'))
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 60_000 })
    const [design] = await accountDesigns(page)
    const objects = design?.document.pages[0]?.objects ?? []
    expect(objects.filter((object) => object.type === 'image').map((object) => object.src)).toEqual([expect.stringMatching(/^\/media\/assets\//), expect.stringMatching(/^\/media\/assets\//), expect.stringMatching(/^\/media\/assets\//)])
    expect(objects.filter((object) => object.type === 'rect')).toHaveLength(400)
    expect(JSON.stringify(design)).not.toContain('idb://')
    expect(await localAssetCount(page)).toBe(0)
    const usage = await page.evaluate(async () => (await fetch('/api/v1/assets/')).json() as Promise<{ count: number }>)
    expect(usage.count).toBe(3)
  })

  test('a design response lost on the way does not create the design twice', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await openGuestDesign(page, { title: 'Sent once' })
    let posts = 0
    await page.route('**/api/v1/designs/', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      posts += 1
      if (posts === 1) {
        await route.fetch()
        return route.abort('connectionreset')
      }
      return route.fallback()
    })
    await page.getByRole('button', { name: 'Sign up' }).click()
    await signUpInDialog(page, uniqueEmail('lost response'))
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    expect(await accountDesigns(page).then((designs) => designs.map((design) => design.title))).toEqual(['Sent once'])
  })

  test('with the network down the local copy stays, and Try again finishes the job exactly once', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await openGuestDesign(page, { title: 'Retry me', images: 2 })
    let down = true
    await page.route('**/api/v1/assets/', async (route) => {
      if (route.request().method() === 'POST' && down) return route.abort('internetdisconnected')
      return route.fallback()
    })
    await page.route('**/api/v1/designs/', async (route) => {
      if (route.request().method() === 'POST' && down) return route.abort('internetdisconnected')
      return route.fallback()
    })
    await page.getByRole('button', { name: 'Sign up' }).click()
    await signUpInDialog(page, uniqueEmail('network down'))
    await expect(page.getByText('We couldn’t save to your account')).toBeVisible({ timeout: 30_000 })
    await shot(page, 'guest-migration-failed')
    await expect(page).toHaveURL(/\/local\//)
    expect(await localTitles(page)).toEqual(['Retry me'])
    expect(await localAssetCount(page)).toBe(2)
    expect(await accountDesigns(page)).toHaveLength(0)
    const assets = await page.evaluate(async () => (await fetch('/api/v1/assets/')).json() as Promise<{ count: number }>)
    expect(assets.count).toBe(0)

    down = false
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    const designs = await accountDesigns(page)
    expect(designs.map((design) => design.title)).toEqual(['Retry me'])
    const after = await page.evaluate(async () => (await fetch('/api/v1/assets/')).json() as Promise<{ count: number }>)
    expect(after.count).toBe(2)
    expect(await localTitles(page)).toEqual([])
  })

  test('an account that is already signed in saves a guest design with "Save to account"', async ({ browser }) => {
    const owner = await Api.create()
    const email = uniqueEmail('already in')
    await owner.call('post', '/auth/register/', { email, password: PASSWORD }, 201)
    const { page, context } = await openContext(browser, { name: 'x', email, password: PASSWORD, state: await owner.state() })
    void context
    await openGuestDesign(page, { title: 'Second home' })
    await page.getByRole('button', { name: 'Save to account' }).click()
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    expect((await accountDesigns(page)).map((design) => design.title)).toEqual(['Second home'])
  })
})

test.describe('guest storage problems', () => {
  test('when the browser denies storage the editor says so and warns before the tab is closed', async ({ browser }) => {
    const { page } = await openContext(browser, null, {
      before: async (target) => {
        await target.addInitScript(() => {
          const refuse = () => {
            throw new DOMException('The user denied permission to access the database.', 'SecurityError')
          }
          Object.defineProperty(window.indexedDB, 'open', { value: refuse })
        })
      },
    })
    await page.goto('/create?preset=poster')
    await expect(page.locator('[data-artboard] .doory-canvas').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Won’t be kept')).toBeVisible()
    await shot(page, 'guest-memory-only')
    // Browsers only ask when the visitor has interacted with the page.
    await page.mouse.click(700, 500)
    const dialogs: string[] = []
    page.on('dialog', (dialog) => dialogs.push(dialog.type()))
    await page.close({ runBeforeUnload: true })
    await expect.poll(() => dialogs).toEqual(['beforeunload'])
  })

  test('the editor warns before leaving while a change is not yet stored', async ({ browser }) => {
    const { page } = await openContext(browser, null)
    await openGuestDesign(page, { title: 'Unsaved warning' })
    await page.route('**/*', (route) => route.continue())
    // Make the browser-side write fail, as a full disk does.
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function put(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if (this.name === 'designs') throw new DOMException('quota', 'QuotaExceededError')
        return original.apply(this, args)
      }
    })
    await addHeading(page, 'Cannot be stored')
    await expect(page.getByText('Couldn’t save in this browser')).toBeVisible({ timeout: 15_000 })
    await shot(page, 'guest-save-failed')
    const dialogs: string[] = []
    page.on('dialog', (dialog) => dialogs.push(dialog.type()))
    await page.close({ runBeforeUnload: true })
    await expect.poll(() => dialogs).toEqual(['beforeunload'])
  })
})
