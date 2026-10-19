import { type Browser, expect, test } from '@playwright/test'
import { Wire, canonical, converged } from './chaos-support'
import { type Account, type Client, call, createAccounts, createDesign, createLinkWithId, document_, documentOf, isEditingText, nudge, objectById, open, readOnly, rect, select, status, textbox, toClient, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy'])
})

interface Room {
  ada: Client
  bo: Client
  boWire: Wire
  designId: string
  link: { id: string; token: string }
}

async function room(browser: Browser, objects = [rect({ id: 'one', left: 200 }), rect({ id: 'two', left: 500, fill: '#7c3aed' })]): Promise<Room> {
  const ada = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(ada, documentOf([objects]), 'Access')
  const link = await createLinkWithId(ada, designId, 'edit')
  await ada.page.goto(`/design/${designId}`)
  const boWire = new Wire()
  const bo = await open(browser, accounts.Bo, `/s/${link.token}`, { before: (page) => boWire.install(page) })
  await Promise.all([whenLive(ada.page), whenLive(bo.page)])
  return { ada, bo, boWire, designId, link }
}

async function close(...clients: Client[]): Promise<void> {
  for (const client of clients) await client.context.close()
}

test('demoted to view while offline with unsent edits: the window says so, and a reload shows the design as it is', async ({ browser }) => {
  const r = await room(browser)
  await r.boWire.down(r.bo.page)
  await expect.poll(() => status(r.bo.page)).toMatch(/offline|connecting/)
  await select(r.bo.page, ['one'])
  await nudge(r.bo.page, 77)
  expect((await objectById(r.bo.page, 'one'))?.left).toBe(277)
  await call(r.ada.context, 'patch', `/designs/${r.designId}/share-links/${r.link.id}/`, { role: 'view' })
  await select(r.ada.page, ['two'])
  await nudge(r.ada.page, 10)
  await r.boWire.up(r.bo.page)
  await expect.poll(() => status(r.bo.page), { timeout: 40_000 }).toBe('read-only')
  expect(await readOnly(r.bo.page)).toBe(true)
  // The edit the server refused is not saved, and the window does not pretend it is.
  await expect(r.bo.page.getByTestId('collab-banner')).toContainText('Some of your changes were not saved')
  expect((await objectById(r.ada.page, 'one'))?.left).toBe(200)
  await expect.poll(async () => (await objectById(r.bo.page, 'two'))?.left, { timeout: 20_000 }).toBe(510)
  await r.bo.page.reload()
  await whenLive(r.bo.page)
  expect(await status(r.bo.page)).toBe('read-only')
  await expect(r.bo.page.getByTestId('collab-banner')).toHaveCount(0)
  expect(canonical(await document_(r.bo.page))).toBe(canonical(await document_(r.ada.page)))
  await close(r.ada, r.bo)
})

test('promoted again after being demoted: edits the server once refused do not reach the design behind anybody\'s back', async ({ browser }) => {
  const r = await room(browser)
  await r.boWire.down(r.bo.page)
  await select(r.bo.page, ['one'])
  await nudge(r.bo.page, 77)
  await call(r.ada.context, 'patch', `/designs/${r.designId}/share-links/${r.link.id}/`, { role: 'view' })
  await r.boWire.up(r.bo.page)
  await expect.poll(() => status(r.bo.page), { timeout: 40_000 }).toBe('read-only')
  await call(r.ada.context, 'patch', `/designs/${r.designId}/share-links/${r.link.id}/`, { role: 'edit' })
  // The window refuses to join as an editor with changes nobody has seen; it asks for a reload.
  await expect.poll(() => status(r.bo.page), { timeout: 40_000 }).toBe('forbidden')
  await expect(r.bo.page.getByTestId('collab-banner')).toContainText('Some of your changes were not saved')
  await r.ada.page.waitForTimeout(1500)
  expect((await objectById(r.ada.page, 'one'))?.left).toBe(200)
  await r.bo.page.reload()
  await whenLive(r.bo.page)
  expect(await readOnly(r.bo.page)).toBe(false)
  await select(r.bo.page, ['two'])
  await nudge(r.bo.page, 20)
  await expect.poll(async () => (await objectById(r.ada.page, 'two'))?.left).toBe(520)
  expect((await objectById(r.ada.page, 'one'))?.left).toBe(200)
  await close(r.ada, r.bo)
})

test('a comment-only link is read-only for the design, and a viewer who is promoted can edit without reloading', async ({ browser }) => {
  const r = await room(browser)
  await call(r.ada.context, 'patch', `/designs/${r.designId}/share-links/${r.link.id}/`, { role: 'comment' })
  await expect.poll(() => status(r.bo.page), { timeout: 30_000 }).toBe('read-only')
  await select(r.bo.page, ['one'])
  await nudge(r.bo.page, 50)
  await r.ada.page.waitForTimeout(1000)
  expect((await objectById(r.ada.page, 'one'))?.left).toBe(200)
  await call(r.ada.context, 'patch', `/designs/${r.designId}/share-links/${r.link.id}/`, { role: 'edit' })
  await expect.poll(() => status(r.bo.page), { timeout: 30_000 }).toBe('live')
  await converged([r.ada, r.bo], 30_000)
  await select(r.bo.page, ['two'])
  await nudge(r.bo.page, 20)
  await expect.poll(async () => (await objectById(r.ada.page, 'two'))?.left).toBe(520)
  await close(r.ada, r.bo)
})

test('a window that closes suddenly leaves the list of people within seconds', async ({ browser }) => {
  const r = await room(browser)
  await expect(r.ada.page.locator('[data-testid="presence-avatar"][data-user="Bo"]')).toBeVisible()
  await r.bo.context.close()
  await expect(r.ada.page.locator('[data-testid="presence-avatar"][data-user="Bo"]')).toHaveCount(0, { timeout: 10_000 })
  await expect(r.ada.page.getByTestId('collab-status')).toContainText('Live')
  await close(r.ada)
})

test('a window whose network vanishes without a goodbye is dropped from the list, with its text lock, in about half a minute', async ({ browser }) => {
  test.setTimeout(150_000)
  const r = await room(browser, [textbox({ id: 'title', left: 400, top: 120 })])
  const where = await toClient(r.bo.page, 400, 120)
  await r.bo.page.mouse.dblclick(where.x, where.y)
  await expect.poll(() => isEditingText(r.bo.page)).toBe(true)
  await expect(r.ada.page.getByTestId('text-lock-badge')).toContainText('Bo is editing this text')
  r.boWire.blackhole = true
  const gone = Date.now()
  await expect(r.ada.page.locator('[data-testid="presence-avatar"][data-user="Bo"]')).toHaveCount(0, { timeout: 60_000 })
  await expect(r.ada.page.getByTestId('text-lock-badge')).toHaveCount(0)
  const took = Date.now() - gone
  console.log(`a silent window left the list after ${Math.round(took / 1000)} s`)
  expect(took).toBeLessThan(50_000)
  // The text can be edited by somebody else now.
  const same = await toClient(r.ada.page, 400, 120)
  await r.ada.page.mouse.dblclick(same.x, same.y)
  await expect.poll(() => isEditingText(r.ada.page)).toBe(true)
  await close(r.ada, r.bo)
})
