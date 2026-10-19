import { type Browser, expect, test } from '@playwright/test'
import { type Account, Network, createAccounts, createDesign, createLink, documentOf, nudge, objectById, open, rect, select, status, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo'])
})

test('after a lost connection the editor keeps working, shows it, and merges with what happened meanwhile', async ({ browser }) => {
  const first = rect({ left: 200 })
  const second = rect({ left: 500, fill: '#7c3aed' })
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, documentOf([[first, second]]))
  const token = await createLink(owner, designId, 'edit')
  await owner.page.goto(`/design/${designId}`)
  const network = new Network()
  const bo = await open(browser, accounts.Bo, `/s/${token}`, { before: (page) => network.install(page) })
  await Promise.all([whenLive(owner.page), whenLive(bo.page)])

  await network.down(bo.page)
  await expect(bo.page.getByTestId('collab-status')).toContainText('Offline. Changes will sync')
  expect(['offline', 'connecting']).toContain(await status(bo.page))

  // Bo keeps editing; Ada edits something else at the same time.
  await select(bo.page, [first.id])
  await nudge(bo.page, 25)
  expect((await objectById(bo.page, first.id))?.left).toBe(225)
  await select(owner.page, [second.id])
  await nudge(owner.page, -35)
  await expect.poll(async () => (await objectById(owner.page, second.id))?.left).toBe(465)
  expect((await objectById(bo.page, second.id))?.left).toBe(500)

  await network.up(bo.page)
  await expect(bo.page.getByTestId('collab-status')).toContainText('Live · 2 people', { timeout: 30_000 })
  for (const client of [owner, bo]) {
    await expect.poll(async () => (await objectById(client.page, first.id))?.left).toBe(225)
    await expect.poll(async () => (await objectById(client.page, second.id))?.left).toBe(465)
  }
  await owner.context.close()
  await bo.context.close()
})

test('a connection that keeps failing falls back to the normal autosave', async ({ browser }) => {
  const shape = rect()
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, documentOf([[shape]]))
  const network = new Network()
  const saved: string[] = []
  const editor = await open(browser, accounts.Ada, `/design/${designId}`, {
    before: async (page) => {
      await network.install(page)
      network.block()
      page.on('request', (request) => {
        if (request.method() === 'PATCH' && request.url().includes(`/designs/${designId}/`) && request.postData()?.includes('"document"')) saved.push(request.url())
      })
    },
  })
  await editor.page.waitForSelector('[data-editor-root]')
  await editor.page.waitForSelector('[data-artboard] .doory-canvas')
  // Three failed attempts (about 1 s, 2 s and 4 s apart) and the editor stops waiting for the room.
  await expect.poll(() => status(editor.page), { timeout: 30_000 }).toBe('fallback')
  await select(editor.page, [shape.id])
  await nudge(editor.page, 10)
  await expect.poll(() => saved.length, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(editor.page.getByTestId('collab-status')).toHaveCount(0)
  await owner.context.close()
  await editor.context.close()
})

test('an editor that gave up on the room joins it when the server says one is open, and its edits come along', async ({ browser }) => {
  const first = rect({ left: 200 })
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, documentOf([[first]]))
  const token = await createLink(owner, designId, 'edit')
  await owner.page.goto(`/design/${designId}`)
  await whenLive(owner.page)

  const network = new Network()
  network.block()
  const bo = await open(browser, accounts.Bo, `/s/${token}`, { before: (page) => network.install(page) })
  await bo.page.waitForSelector('[data-editor-root]')
  await bo.page.waitForSelector('[data-artboard] .doory-canvas')
  await expect.poll(() => status(bo.page), { timeout: 30_000 }).toBe('fallback')

  // The room works again, and the next autosave is refused with 409 use_realtime: Bo joins, with his edit.
  await network.up(bo.page)
  await select(bo.page, [first.id])
  await nudge(bo.page, 35)
  await expect.poll(() => status(bo.page), { timeout: 30_000 }).toBe('live')
  await expect.poll(async () => (await objectById(owner.page, first.id))?.left, { timeout: 15_000 }).toBe(235)
  expect((await objectById(bo.page, first.id))?.left).toBe(235)
  await owner.context.close()
  await bo.context.close()
})
