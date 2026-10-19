import { type Browser, expect, test } from '@playwright/test'
import { type Account, type Client, addShape, call, createAccounts, createDesign, createLink, document_, documentOf, nudge, objectById, objects, open, rect, redo, saveNow, select, setOpacity, undo, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy'])
})

/** Ada owns a design with two rectangles; Bo edits it through a link. */
async function twoEditors(browser: Browser): Promise<{ ada: Client; bo: Client; designId: string; ids: string[] }> {
  const first = rect({ left: 200, top: 150 })
  const second = rect({ left: 500, top: 350, fill: '#7c3aed' })
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, documentOf([[first, second]]))
  const token = await createLink(owner, designId, 'edit')
  const ada = owner
  await ada.page.goto(`/design/${designId}`)
  const bo = await open(browser, accounts.Bo, `/s/${token}`)
  await Promise.all([whenLive(ada.page), whenLive(bo.page)])
  return { ada, bo, designId, ids: [first.id, second.id] }
}

test('an edit by one person appears for the other, in both directions', async ({ browser }) => {
  const { ada, bo, ids } = await twoEditors(browser)
  await select(ada.page, [ids[0]])
  await nudge(ada.page, 30)
  await expect.poll(async () => (await objectById(bo.page, ids[0]))?.left).toBe(230)
  await addShape(bo.page, 'ellipse')
  await expect.poll(async () => (await objects(ada.page)).length).toBe(3)
  expect((await objects(ada.page)).map((o) => o.id)).toEqual((await objects(bo.page)).map((o) => o.id))
  await ada.context.close()
  await bo.context.close()
})

test('edits of different objects and of different properties both survive', async ({ browser }) => {
  const { ada, bo, ids } = await twoEditors(browser)
  await select(ada.page, [ids[0]])
  await nudge(ada.page, 40)
  await select(bo.page, [ids[1]])
  await nudge(bo.page, -40)
  await select(bo.page, [ids[0]])
  await setOpacity(bo.page, 0.5)
  for (const client of [ada, bo]) {
    await expect.poll(async () => (await objectById(client.page, ids[0]))?.left).toBe(240)
    await expect.poll(async () => (await objectById(client.page, ids[0]))?.opacity).toBe(0.5)
    await expect.poll(async () => (await objectById(client.page, ids[1]))?.left).toBe(460)
  }
  expect(await document_(ada.page)).toEqual(await document_(bo.page))
  await ada.context.close()
  await bo.context.close()
})

test('undo only takes back your own change', async ({ browser }) => {
  const { ada, bo, ids } = await twoEditors(browser)
  await select(ada.page, [ids[0]])
  await nudge(ada.page, 60)
  await select(bo.page, [ids[1]])
  await nudge(bo.page, 60)
  await expect.poll(async () => (await objectById(ada.page, ids[1]))?.left).toBe(560)
  await undo(ada.page)
  for (const client of [ada, bo]) {
    await expect.poll(async () => (await objectById(client.page, ids[0]))?.left).toBe(200)
    expect((await objectById(client.page, ids[1]))?.left).toBe(560)
  }
  await redo(ada.page)
  await expect.poll(async () => (await objectById(bo.page, ids[0]))?.left).toBe(260)
  await ada.context.close()
  await bo.context.close()
})

test('the room stores the design, and nothing is saved over REST while it is live', async ({ browser }) => {
  const { ada, bo, designId, ids } = await twoEditors(browser)
  const saves: string[] = []
  for (const client of [ada, bo]) {
    client.page.on('request', (request) => {
      if (request.method() === 'PATCH' && /\/api\/v1\/(designs|shared)\//.test(request.url()) && request.postData()?.includes('"document"')) saves.push(request.url())
    })
  }
  await select(ada.page, [ids[0]])
  await nudge(ada.page, 15)
  await expect.poll(async () => (await objectById(bo.page, ids[0]))?.left).toBe(215)
  await ada.page.waitForTimeout(2500)
  expect(saves).toEqual([])
  await saveNow(ada.page)
  const stored = (await call(ada.context, 'get', `/designs/${designId}/`)) as { document: { pages: { objects: { id: string; left: number }[] }[] } }
  expect(stored.document.pages[0].objects.find((o) => o.id === ids[0])?.left).toBe(215)
  await expect(ada.page.getByTestId('collab-status')).toContainText('Live · 2 people')
  await ada.context.close()
  await bo.context.close()
})

test('a new title reaches everybody', async ({ browser }) => {
  const { ada, bo } = await twoEditors(browser)
  const title = ada.page.getByTestId('ed-topbar-title')
  await title.fill('Autumn sale')
  await title.press('Enter')
  await expect(bo.page.getByTestId('ed-topbar-title')).toHaveValue('Autumn sale')
  // A visitor with an edit link cannot rename the design.
  await expect(bo.page.getByTestId('ed-topbar-title')).toHaveJSProperty('readOnly', true)
  await ada.context.close()
  await bo.context.close()
})
