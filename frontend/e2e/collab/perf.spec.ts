import { type Browser, expect, test } from '@playwright/test'
import { type Account, allowance, createAccounts, createDesign, createLink, documentOf, nudge, objectById, open, rect, select, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo'])
})

/** 30 pages of 200 rectangles spread over the page. */
function bigDocument() {
  const pages = Array.from({ length: 30 }, (_, p) =>
    Array.from({ length: 200 }, (_, i) => rect({ id: `p${p}-o${i}`, left: 40 + (i % 20) * 36, top: 40 + Math.floor(i / 20) * 52, width: 28, height: 40, fill: i % 2 ? '#2563eb' : '#7c3aed' })),
  )
  return documentOf(pages)
}

test('a design of 30 pages and 6000 objects is ready in the editor within four seconds, room included', async ({ browser }) => {
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, bigDocument(), 'Big deck')
  // Warm start, like a design that has been opened before: the dev server has compiled the editor and the room holds the design.
  const warm = await owner.context.newPage()
  await warm.goto(`/design/${designId}`)
  await whenLive(warm)
  await warm.close()
  await owner.page.waitForTimeout(1500)
  const editor = await owner.context.newPage()
  const started = Date.now()
  await editor.goto(`/design/${designId}`)
  await whenLive(editor)
  const took = Date.now() - started
  const budget = 4000 * allowance()
  test.info().annotations.push({ type: 'open 30 pages x 200 objects (ms)', description: `${took} of ${Math.round(budget)}` })
  expect(took).toBeLessThan(budget)
  const count = await editor.evaluate(() => (window as unknown as { __doory_collab: { engine: { state: { doc: { pages: { objects: unknown[] }[] } } } } }).__doory_collab.engine.state.doc.pages.reduce((n, p) => n + p.objects.length, 0))
  expect(count).toBe(6000)
  await owner.context.close()
})

test('twenty remote changes a second cost the other window a few milliseconds each', async ({ browser }) => {
  const shapes = Array.from({ length: 200 }, (_, i) => rect({ id: `o${i}`, left: 40 + (i % 20) * 36, top: 40 + Math.floor(i / 20) * 52, width: 28, height: 40 }))
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, documentOf([shapes]), 'Busy page')
  const token = await createLink(owner, designId, 'edit')
  await owner.page.goto(`/design/${designId}`)
  const bo = await open(browser, accounts.Bo, `/s/${token}`)
  await Promise.all([whenLive(owner.page), whenLive(bo.page)])
  await select(owner.page, ['o0'])

  // Time what Bo's editor spends on each change that arrives: reading it, patching the canvas, repainting.
  await bo.page.evaluate(() => {
    const handle = (window as unknown as { __doory_collab: { engine: { applyRemoteDocument(doc: unknown): Promise<void> } } }).__doory_collab
    const w = window as unknown as { __spent: number[] }
    w.__spent = []
    const original = handle.engine.applyRemoteDocument.bind(handle.engine)
    handle.engine.applyRemoteDocument = async (doc) => {
      const started = performance.now()
      await original(doc)
      w.__spent.push(performance.now() - started)
    }
  })
  for (let i = 0; i < 60; i++) {
    await nudge(owner.page, 1)
    await owner.page.waitForTimeout(50)
  }
  await expect.poll(async () => (await objectById(bo.page, 'o0'))?.left).toBe(100)
  const spent = await bo.page.evaluate(() => (window as unknown as { __spent: number[] }).__spent)
  const average = spent.reduce((sum, ms) => sum + ms, 0) / spent.length
  test.info().annotations.push({ type: 'remote change apply (ms)', description: `${spent.length} changes, average ${average.toFixed(1)}, worst ${Math.max(...spent).toFixed(1)}` })
  expect(spent.length).toBeGreaterThan(10)
  expect(average).toBeLessThan(20 * allowance())
  await owner.context.close()
  await bo.context.close()
})
