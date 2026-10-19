import { type Browser, type Page, expect, test } from '@playwright/test'
import { type Action, type ActionResult, Rng, SEED, Wire, act, allIds, api, canonical, converged, randomAction, stored, watch } from './chaos-support'
import { type Account, type Client, call, createAccounts, createDesign, createLink, document_, documentOf, nudge, objectById, objects, open, rect, saveNow, select, status, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy', 'Di'])
})

/** Zoomed out so that every page is on screen (and therefore has a live canvas the actions can work on). */
async function zoomOut(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __doory_collab: { engine: { view: { setZoom(zoom: number): void } } } }).__doory_collab.engine.view.setZoom(0.28))
  await page.waitForTimeout(300)
}

function threePages() {
  return documentOf(
    [0, 1, 2].map((p) =>
      Array.from({ length: 4 }, (_, i) => rect({ id: `p${p}-r${i}`, left: 120 + i * 150, top: 120 + (i % 2) * 160, width: 110, height: 90, fill: ['#2563eb', '#7c3aed', '#059669', '#d97706'][i] })),
    ),
    { width: 800, height: 600 },
  )
}

interface Room {
  designId: string
  clients: Client[]
  wires: Wire[]
  watchers: ReturnType<typeof watch>[]
}

/** Ada owns the design and has it open in two windows (two sessions of one user); Bo, Cy and Di edit through a link. */
async function fiveBrowsers(browser: Browser): Promise<Room> {
  const owner = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(owner, threePages(), 'Chaos')
  const token = await createLink(owner, designId, 'edit')
  const wires = [new Wire(), new Wire(), new Wire(), new Wire(), new Wire()]
  const second = await open(browser, accounts.Ada, `/design/${designId}`, { before: (page) => wires[1].install(page) })
  await wires[0].install(owner.page)
  await owner.page.goto(`/design/${designId}`)
  const people = await Promise.all(['Bo', 'Cy', 'Di'].map((name, i) => open(browser, accounts[name], `/s/${token}`, { before: (page) => wires[i + 2].install(page) })))
  const clients = [owner, second, ...people]
  const watchers = clients.map((c, i) => watch(c.page, `window ${i}`))
  await Promise.all(clients.map((c) => whenLive(c.page)))
  await Promise.all(clients.map((c) => zoomOut(c.page)))
  return { designId, clients, wires, watchers }
}

async function closeAll(clients: Client[]): Promise<void> {
  for (const client of clients) await client.context.close()
}

interface Plan {
  net: 'none' | 'down' | 'up' | 'drop' | 'reload' | 'lag'
  lag: number
  actions: Action[]
}

test('five windows edit at random through dropped sockets, reloads, slow links and undo, and end identical to each other and to the server', async ({ browser }) => {
  test.setTimeout(420_000)
  const rounds = Number(process.env.CHAOS_ROUNDS ?? 22)
  const rng = new Rng(SEED)
  const { designId, clients, wires, watchers } = await fiveBrowsers(browser)
  const log: string[] = []
  const cut = new Set<number>()
  try {
    for (let round = 0; round < rounds; round++) {
      // The whole round is decided first, so the seed alone repeats it.
      const plans: Plan[] = clients.map((_, i) => {
        const roll = rng.next()
        let net: Plan['net'] = 'none'
        if (cut.has(i)) net = rng.chance(0.5) ? 'up' : 'none'
        else if (roll < 0.08) net = 'down'
        else if (roll < 0.14) net = 'drop'
        else if (roll < 0.17) net = 'reload'
        else if (roll < 0.25) net = 'lag'
        return { net, lag: rng.pick([0, 120, 350]), actions: Array.from({ length: 1 + rng.int(3) }, () => randomAction(rng)) }
      })
      await Promise.all(
        clients.map(async (client, i) => {
          const plan = plans[i]
          const wire = wires[i]
          if (plan.net === 'down') {
            cut.add(i)
            await wire.down(client.page)
          } else if (plan.net === 'up') {
            cut.delete(i)
            await wire.up(client.page)
          } else if (plan.net === 'drop') wire.drop()
          else if (plan.net === 'lag') wire.lag = plan.lag
          else if (plan.net === 'reload' && !cut.has(i)) {
            await client.page.reload()
            await whenLive(client.page)
            await zoomOut(client.page)
          }
          for (const action of plan.actions) {
            const result: ActionResult = await act(client.page, action)
            log.push(`round ${round} window ${i}: ${result.did}`)
          }
        }),
      )
      await clients[0].page.waitForTimeout(rng.int(250))
      const states = await Promise.all(clients.map((c) => status(c.page).catch(() => 'gone')))
      log.push(`round ${round} ends: ${states.join(' ')} | plans ${plans.map((p) => p.net).join(' ')} | REST saves ${watchers.map((w) => w.saves.length).join(' ')}`)
    }

    // Everything comes back.
    for (const [i, wire] of wires.entries()) {
      wire.lag = 0
      cut.delete(i)
      await wire.up(clients[i].page)
    }
    await Promise.all(clients.map((c) => expect.poll(() => status(c.page), { timeout: 60_000 }).toMatch(/live|read-only/)))
    const shared = await converged(clients, 60_000)
    expect(shared.pages.length).toBeGreaterThanOrEqual(1)
    const persisted = await stored(clients[0], designId)
    expect(canonical(persisted)).toBe(canonical(shared))
    for (const watcher of watchers) {
      expect(watcher.errors).toEqual([])
      expect(watcher.saves, 'nothing is saved over REST while the room is live').toEqual([])
    }
  } catch (error) {
    console.log(`seed ${SEED}, what the windows did:\n${log.join('\n')}\nhow each window's connections ended:\n${wires.map((w, i) => `window ${i}: ${w.closes.join(', ')}`).join('\n')}`)
    throw error
  } finally {
    await closeAll(clients)
  }
})

async function createShape(page: Page, kind: 'rect' | 'ellipse' | 'triangle' | 'star' = 'rect'): Promise<string> {
  return page.evaluate(async (shape) => {
    const e = (window as unknown as { __doory_collab: { engine: { state: { doc: { pages: { id: string; objects: { id: string }[] }[] }; activePageId: string }; insert: { shape(kind: string): Promise<void> } } } }).__doory_collab.engine
    const before = new Set(e.state.doc.pages.flatMap((p) => p.objects.map((o) => o.id)))
    await e.insert.shape(shape)
    const added = e.state.doc.pages.flatMap((p) => p.objects.map((o) => o.id)).filter((id) => !before.has(id))
    return added[0]
  }, kind)
}

test('what the windows did survives a crash and a restart of the server, and so does what they did while it was down', async ({ browser }) => {
  test.setTimeout(300_000)
  const { designId, clients, watchers } = await fiveBrowsers(browser)
  const made: string[] = []
  try {
    for (const [cycle, mode] of (['crash', 'graceful', 'crash'] as const).entries()) {
      // Every window makes a shape; the others see it (so the server has stored it) ...
      for (const client of clients) {
        const id = await createShape(client.page, (['rect', 'ellipse', 'triangle', 'star'] as const)[cycle % 4])
        made.push(id)
      }
      await converged(clients, 30_000)
      // ... and some more are still on their way when the server dies.
      const late = await Promise.all(clients.slice(0, 3).map((c) => createShape(c.page)))
      made.push(...late)
      await api('restart', mode)
      // During the outage-and-return the windows keep editing.
      const during = await Promise.all(clients.slice(2).map((c) => createShape(c.page, 'ellipse')))
      made.push(...during)
      await Promise.all(clients.map((c) => expect.poll(() => status(c.page), { timeout: 60_000 }).toMatch(/live/)))
    }
    const shared = await converged(clients, 60_000)
    const ids = new Set(allIds(shared))
    for (const id of made) expect(ids.has(id), `shape ${id} should have survived`).toBe(true)
    const persisted = await stored(clients[0], designId)
    expect(canonical(persisted)).toBe(canonical(shared))
    for (const watcher of watchers) expect(watcher.errors).toEqual([])
  } finally {
    await closeAll(clients)
  }
})

test('an outage of several seconds: windows keep working, say so, and merge everything when the server is back', async ({ browser }) => {
  test.setTimeout(300_000)
  const { designId, clients } = await fiveBrowsers(browser)
  try {
    await api('halt', 'crash')
    await expect(clients[2].page.getByTestId('collab-status')).toContainText(/Reconnecting|Offline/, { timeout: 30_000 })
    const made: string[] = []
    for (const client of clients) made.push(await createShape(client.page))
    for (const client of clients) expect(await objects(client.page)).toBeTruthy()
    await clients[0].page.waitForTimeout(6000)
    await api('start')
    await Promise.all(clients.map((c) => expect.poll(() => status(c.page), { timeout: 90_000 }).toBe('live')))
    const shared = await converged(clients, 60_000)
    const ids = new Set(allIds(shared))
    for (const id of made) expect(ids.has(id)).toBe(true)
    expect(canonical(await stored(clients[0], designId))).toBe(canonical(shared))
    expect((await document_(clients[1].page)).pages.length).toBe(3)
  } finally {
    await closeAll(clients)
  }
})

for (const mode of ['graceful', 'crash'] as const) {
  test(`after a ${mode === 'graceful' ? 'SIGTERM the stored design has the last edit' : 'SIGKILL the stored design may trail, and the next connection brings it up to date'}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const owner = await open(browser, accounts.Ada, '/dashboard')
    const shape = rect({ id: 'one', left: 200 })
    const designId = await createDesign(owner, documentOf([[shape]]), 'Last save')
    await owner.page.goto(`/design/${designId}`)
    await whenLive(owner.page)
    await select(owner.page, ['one'])
    await nudge(owner.page, 55)
    await owner.page.waitForTimeout(1000)
    await api('halt', mode)
    await api('start')
    const left = async () => ((await call(owner.context, 'get', `/designs/${designId}/`)) as { document: { pages: { objects: { left: number }[] }[] } }).document.pages[0].objects[0].left
    // Nobody is connected: this is what the design says on its own.
    if (mode === 'graceful') expect(await left()).toBe(255)
    else expect(await left()).toBe(200)
    await whenLive(owner.page)
    await expect.poll(async () => (await objectById(owner.page, 'one'))?.left).toBe(255)
    await saveNow(owner.page)
    expect(await left()).toBe(255)
    await owner.context.close()
  })
}
