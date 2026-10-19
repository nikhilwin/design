import { type Browser, expect, test } from '@playwright/test'
import { type Account, createAccounts, createDesign, createLink, createLinkWithId, call, documentOf, open, readOnly, rect, select, nudge, objectById, status, toClient, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy'])
})

async function ownedDesign(browser: Browser) {
  const shape = rect()
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, documentOf([[shape]]))
  return { owner, designId, shape }
}

test('somebody who is not signed in never connects, and the server refuses a socket without a session', async ({ browser }) => {
  const { owner, designId } = await ownedDesign(browser)
  const edit = await createLink(owner, designId, 'edit')
  const view = await createLink(owner, designId, 'view')

  const visitor = await open(browser, null, `/s/${edit}`)
  await expect(visitor.page.getByRole('heading', { name: /Sign in to edit/ })).toBeVisible()
  await expect(visitor.page.locator('[data-editor-root]')).toHaveCount(0)

  // A view link keeps the static page for visitors: no room, no live status.
  const reader = await open(browser, null, `/s/${view}`)
  await reader.page.waitForSelector('[data-editor-root]')
  await reader.page.waitForSelector('[data-artboard] .doory-canvas')
  await expect(reader.page.getByTestId('collab-status')).toHaveCount(0)
  expect(await status(reader.page)).toBeNull()

  // The server itself closes a socket that has no session: 4401, not a failed upgrade.
  const closed = await reader.page.evaluate(
    (id) =>
      new Promise<{ code: number; reason: string }>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws/designs/${id}/`)
        socket.onclose = (event) => resolve({ code: event.code, reason: event.reason })
      }),
    designId,
  )
  expect(closed).toEqual({ code: 4401, reason: 'not_authenticated' })
  for (const client of [owner, visitor, reader]) await client.context.close()
})

test('a signed-in visitor of a view link watches the design live and cannot change it', async ({ browser }) => {
  const { owner, designId, shape } = await ownedDesign(browser)
  const token = await createLink(owner, designId, 'view')
  await owner.page.goto(`/design/${designId}`)
  const cy = await open(browser, accounts.Cy, `/s/${token}`)
  await Promise.all([whenLive(owner.page), whenLive(cy.page)])
  expect(await status(cy.page)).toBe('read-only')
  expect(await readOnly(cy.page)).toBe(true)
  await expect(cy.page.getByTestId('collab-status')).toContainText('Watching live · 2 people')

  // Watching: the owner's edit and pointer arrive.
  await select(owner.page, [shape.id])
  await nudge(owner.page, 50)
  await expect.poll(async () => (await objectById(cy.page, shape.id))?.left).toBe(250)
  const at = await toClient(owner.page, 300, 300)
  await owner.page.mouse.move(at.x - 30, at.y - 30)
  await owner.page.mouse.move(at.x, at.y, { steps: 5 })
  await expect(cy.page.locator('[data-testid="remote-cursor"][data-user="Ada"]')).toBeVisible()
  // And the owner sees that Cy is watching.
  await expect(owner.page.locator('[data-testid="presence-avatar"][data-user="Cy"]')).toBeVisible()
  await expect(cy.page.getByTestId('ed-share')).toHaveCount(0)
  await owner.context.close()
  await cy.context.close()
})

test('turning a link off while somebody is editing through it ends their editing', async ({ browser }) => {
  const { owner, designId } = await ownedDesign(browser)
  const link = await createLinkWithId(owner, designId, 'edit')
  await owner.page.goto(`/design/${designId}`)
  const bo = await open(browser, accounts.Bo, `/s/${link.token}`)
  await Promise.all([whenLive(owner.page), whenLive(bo.page)])
  expect(await readOnly(bo.page)).toBe(false)
  await call(owner.context, 'delete', `/designs/${designId}/share-links/${link.id}/`)
  await expect(bo.page.getByTestId('collab-banner')).toContainText('The share link for this design was turned off.', { timeout: 20_000 })
  await expect(bo.page.getByTestId('collab-status')).toContainText('No access')
  expect(await readOnly(bo.page)).toBe(true)
  await expect(owner.page.locator('[data-testid="presence-avatar"][data-user="Bo"]')).toHaveCount(0)
  await owner.context.close()
  await bo.context.close()
})

test('downgrading a link to view-only makes the open editor view-only', async ({ browser }) => {
  const { owner, designId } = await ownedDesign(browser)
  const link = await createLinkWithId(owner, designId, 'edit')
  await owner.page.goto(`/design/${designId}`)
  const bo = await open(browser, accounts.Bo, `/s/${link.token}`)
  await Promise.all([whenLive(owner.page), whenLive(bo.page)])
  await call(owner.context, 'patch', `/designs/${designId}/share-links/${link.id}/`, { role: 'view' })
  await expect.poll(() => status(bo.page), { timeout: 20_000 }).toBe('read-only')
  expect(await readOnly(bo.page)).toBe(true)
  await owner.context.close()
  await bo.context.close()
})

test('a design in the trash closes the room with a clear message', async ({ browser }) => {
  const { owner, designId } = await ownedDesign(browser)
  await owner.page.goto(`/design/${designId}`)
  await whenLive(owner.page)
  await call(owner.context, 'delete', `/designs/${designId}/`)
  await expect(owner.page.getByTestId('collab-banner')).toContainText('This design is gone', { timeout: 20_000 })
  await owner.context.close()
})
