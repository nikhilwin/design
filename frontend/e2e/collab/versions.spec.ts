import { type Browser, expect, test } from '@playwright/test'
import { type Account, call, createAccounts, createDesign, createLink, documentOf, nudge, objectById, objects, open, rect, removeSelected, saveNow, select, addShape, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo'])
})

test('restoring a version while two people are editing puts everybody on it, once', async ({ browser }) => {
  const first = rect({ left: 200 })
  const second = rect({ left: 500, fill: '#7c3aed' })
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, documentOf([[first, second]]))
  const token = await createLink(owner, designId, 'edit')
  await owner.page.goto(`/design/${designId}`)
  const bo = await open(browser, accounts.Bo, `/s/${token}`)
  await Promise.all([whenLive(owner.page), whenLive(bo.page)])

  // A named version of how it is now (the room saves first, as the version dialog does).
  await saveNow(owner.page)
  await call(owner.context, 'post', `/designs/${designId}/versions/`, { label: 'Before the changes' })

  // Both change the design.
  await select(owner.page, [first.id])
  await removeSelected(owner.page)
  await select(owner.page, [second.id])
  await nudge(owner.page, 100)
  await addShape(bo.page, 'ellipse')
  await expect.poll(async () => (await objects(owner.page)).length).toBe(2)
  await expect.poll(async () => (await objects(bo.page)).length).toBe(2)
  await expect.poll(async () => (await objectById(bo.page, second.id))?.left).toBe(600)

  // Ada restores through the dialog.
  await owner.page.getByTestId('ed-more').click()
  await owner.page.getByRole('menuitem', { name: /Version history/ }).click()
  const row = owner.page.getByTestId('version-row').filter({ hasText: 'Before the changes' })
  await row.getByTestId('version-restore').click()
  await owner.page.getByTestId('version-restore-confirm').click()

  for (const client of [owner, bo]) {
    await expect.poll(async () => (await objects(client.page)).map((o) => o.id).sort(), { timeout: 20_000 }).toEqual([first.id, second.id].sort())
    await expect.poll(async () => (await objectById(client.page, second.id))?.left).toBe(500)
  }
  await expect(bo.page.getByText('The design was restored to an earlier version.')).toBeVisible()
  // Nothing doubled: the saved design has the two objects, once each.
  await saveNow(owner.page)
  const stored = (await call(owner.context, 'get', `/designs/${designId}/`)) as { document: { pages: { objects: { id: string }[] }[] } }
  expect(stored.document.pages[0].objects.map((o) => o.id).sort()).toEqual([first.id, second.id].sort())
  await owner.context.close()
  await bo.context.close()
})
