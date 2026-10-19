import { type Browser, type Page, expect, test } from '@playwright/test'
import { RawSocket, converged } from './chaos-support'
import { type Account, type Client, createAccounts, createDesign, createLink, documentOf, objectById, open, rect, status, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy', 'Di'])
})

test('twenty-five people fit in a design; the twenty-sixth is told it is full, and gets in when somebody leaves', async ({ browser }) => {
  test.setTimeout(240_000)
  const ada = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(ada, documentOf([[rect({ id: 'one' })]]), 'Crowded')
  const edit = await createLink(ada, designId, 'edit')
  await ada.page.goto(`/design/${designId}`)
  await whenLive(ada.page)
  const hosts: Client[] = [ada]
  for (const name of ['Bo', 'Cy']) hosts.push(await open(browser, accounts[name], '/dashboard'))
  const sockets: RawSocket[] = []
  const join = async (host: Client, count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      const socket = await RawSocket.open(host.page, designId)
      if (host !== ada) await socket.send(JSON.stringify({ type: 'auth', token: edit }))
      await socket.ready()
      sockets.push(socket)
    }
  }
  // One account may hold ten sockets: Ada's editor and nine more, Bo ten, Cy five.
  await join(ada, 9)
  await join(hosts[1], 10)
  await join(hosts[2], 5)
  expect(sockets).toHaveLength(24)

  const di = await open(browser, accounts.Di, `/s/${edit}`)
  await di.page.waitForSelector('[data-editor-root]')
  await expect.poll(() => status(di.page), { timeout: 30_000 }).toBe('busy')
  await expect(di.page.getByTestId('collab-banner')).toContainText('This design is full')
  await expect(di.page.getByTestId('collab-status')).toContainText('Server busy')

  // The design carries on for the twenty-five, and the twenty-sixth joins by itself when there is room.
  await sockets[sockets.length - 1].close()
  await expect.poll(() => status(di.page), { timeout: 60_000 }).toBe('live')
  await expect(di.page.getByTestId('collab-banner')).toHaveCount(0)
  await converged([ada, di], 30_000)
  for (const client of [...hosts, di]) await client.context.close()
})

async function heap(page: Page): Promise<number> {
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.enable')
  await session.send('HeapProfiler.collectGarbage')
  const { usedSize } = (await session.send('Runtime.getHeapUsage')) as { usedSize: number }
  await session.detach()
  return usedSize
}

function bigDocument() {
  const pages = Array.from({ length: 30 }, (_, p) =>
    Array.from({ length: 200 }, (_, i) => rect({ id: `p${p}-o${i}`, left: 40 + (i % 20) * 36, top: 40 + Math.floor(i / 20) * 52, width: 28, height: 40, fill: i % 2 ? '#2563eb' : '#7c3aed' })),
  )
  return documentOf(pages)
}

test('a long editing session on a big design does not leak: the heap and the shared state stop growing', async ({ browser }) => {
  test.setTimeout(420_000)
  const ada = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(ada, bigDocument(), 'Long session')
  const token = await createLink(ada, designId, 'edit')
  await ada.page.goto(`/design/${designId}`)
  const bo = await open(browser, accounts.Bo, `/s/${token}`)
  await Promise.all([whenLive(ada.page), whenLive(bo.page)])

  const work = (edits: number) =>
    ada.page.evaluate(async (count) => {
      const e = (window as unknown as { __doory_collab: { engine: { select(ids: string[], page?: string): void; arrange: { nudge(dx: number, dy: number): void }; style: { setOpacity(v: number): void }; sealHistory(): void } } }).__doory_collab.engine
      for (let i = 0; i < count; i++) {
        e.select([`p0-o${i % 40}`], 'page-1')
        e.arrange.nudge(i % 2 === 0 ? 1 : -1, 0)
        if (i % 7 === 0) e.style.setOpacity(0.5 + (i % 50) / 100)
        if (i % 10 === 0) e.sealHistory()
        if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }, edits)
  await work(300)
  const earlyAda = await heap(ada.page)
  const earlyBo = await heap(bo.page)
  const started = Date.now()
  for (let round = 0; round < 6; round++) await work(500)
  const seconds = (Date.now() - started) / 1000
  await converged([ada, bo], 60_000)
  const lateAda = await heap(ada.page)
  const lateBo = await heap(bo.page)
  const MB = 1024 * 1024
  console.log(`3000 edits in ${seconds.toFixed(0)} s: editing window heap ${(earlyAda / MB).toFixed(1)} -> ${(lateAda / MB).toFixed(1)} MB, watching window ${(earlyBo / MB).toFixed(1)} -> ${(lateBo / MB).toFixed(1)} MB`)
  expect(lateAda - earlyAda).toBeLessThan(40 * MB)
  expect(lateBo - earlyBo).toBeLessThan(40 * MB)
  expect((await objectById(bo.page, 'p0-o0'))?.id).toBe('p0-o0')
  await ada.context.close()
  await bo.context.close()
})
