import { type Browser, type Page, test } from '@playwright/test'
import { type Account, type Client, Network, call, createAccounts, createDesign, createLinkWithId, documentOf, open, rect, textbox, toClient, whenLive } from './helpers'

/**
 * Visual QA of the presence UI in light and dark: writes PNGs to $SCREENSHOT_DIR (skipped without it). It is a review aid,
 * not an assertion suite.   SCREENSHOT_DIR=/tmp/shots npm run e2e:collab -- visual
 */
const OUT = process.env.SCREENSHOT_DIR
test.skip(!OUT, 'set SCREENSHOT_DIR to write screenshots')

const THEMES = ['light'] as const
const NAMES = ['Ada Lovelace', 'Bo Peep', 'Cy Young', 'Di Prince', 'Ed Norton', 'Flo Rida']
let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, NAMES)
})

async function scene(browser: Browser, theme: 'light' | 'dark', people = 2, role: 'edit' | 'view' = 'edit', viewport?: { width: number; height: number }) {
  const card = rect({ left: 220, top: 330, width: 220, height: 160 })
  const badge = rect({ left: 560, top: 400, width: 140, height: 140, fill: '#7c3aed', angle: 12 })
  const title = textbox({ left: 400, top: 120 })
  const owner = await open(browser, accounts[NAMES[0]], '/dashboard', { theme, viewport })
  const designId = await createDesign(owner, documentOf([[card, badge, title]]), 'Summer sale poster')
  const link = await createLinkWithId(owner, designId, role === 'view' ? 'view' : 'edit')
  await owner.page.goto(`/design/${designId}`)
  const others: Client[] = []
  const network = new Network()
  for (let i = 1; i < people; i++) {
    others.push(await open(browser, accounts[NAMES[i]], `/s/${link.token}`, { theme, viewport, before: i === 1 ? (page) => network.install(page) : undefined }))
  }
  await Promise.all([whenLive(owner.page), ...others.map((o) => whenLive(o.page))])
  return { owner, others, card, badge, title, designId, link, network }
}

for (const theme of THEMES) {
  test(`presence ${theme}`, async ({ browser }) => {
    const { owner, others } = await scene(browser, theme, 4)
    const [bo, cy, di] = others
    const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}-${theme}.png` })

    // Ada points at the card and selects it; Cy edits the title; Di looks elsewhere.
    const at = await toClient(owner.page, 330, 410)
    await owner.page.mouse.move(at.x - 60, at.y - 40)
    await owner.page.mouse.move(at.x, at.y, { steps: 6 })
    await owner.page.mouse.click(at.x, at.y)
    const cyAt = await toClient(cy.page, 400, 120)
    await cy.page.mouse.dblclick(cyAt.x, cyAt.y)
    const diAt = await toClient(di.page, 640, 520)
    await di.page.mouse.move(diAt.x - 30, diAt.y - 30)
    await di.page.mouse.move(diAt.x, diAt.y, { steps: 6 })
    await bo.page.waitForSelector('[data-testid="remote-cursor"][data-user="Di Prince"]')
    await bo.page.waitForSelector('[data-testid="text-lock-badge"]')
    await shot(bo.page, 'presence-room')
    await bo.page.locator('[data-testid="presence-avatar"][data-user="Ada Lovelace"]').hover()
    await bo.page.waitForSelector('[role="tooltip"]')
    await bo.page.screenshot({ path: `${OUT}/presence-avatar-tooltip-${theme}.png`, clip: { x: 600, y: 0, width: 840, height: 120 } })
    await bo.page.locator('[data-testid="presence-avatar"][data-user="Ada Lovelace"]').click()
    await bo.page.waitForSelector('[data-testid="follow-badge"]')
    await shot(bo.page, 'presence-following')
    for (const client of [owner, ...others]) await client.context.close()
  })

  test(`overflow and read-only ${theme}`, async ({ browser }) => {
    const { owner, others } = await scene(browser, theme, 6)
    await owner.page.waitForSelector('[data-testid="presence-more"]')
    await owner.page.screenshot({ path: `${OUT}/presence-overflow-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } })
    await owner.page.locator('[data-testid="presence-more"]').click()
    await owner.page.waitForSelector('[role="menu"]')
    await owner.page.screenshot({ path: `${OUT}/presence-overflow-menu-${theme}.png`, clip: { x: 700, y: 0, width: 740, height: 260 } })
    for (const client of [owner, ...others]) await client.context.close()
  })

  test(`narrow top bar ${theme}`, async ({ browser }) => {
    for (const width of [1100, 860, 800]) {
      const { owner, others, network } = await scene(browser, theme, 4, 'edit', { width, height: 800 })
      await owner.page.waitForSelector('[data-testid="presence-avatar"]')
      await owner.page.screenshot({ path: `${OUT}/topbar-${width}-${theme}.png`, clip: { x: 0, y: 0, width, height: 120 } })
      // The widest status text (offline) has to fit as well.
      await network.down(others[0].page)
      await others[0].page.waitForSelector('[data-testid="collab-status"][data-state="offline"]')
      await others[0].page.screenshot({ path: `${OUT}/topbar-${width}-offline-${theme}.png`, clip: { x: 0, y: 0, width, height: 120 } })
      for (const client of [owner, ...others]) await client.context.close()
    }
  })

  test(`connection states ${theme}`, async ({ browser }) => {
    const { owner, others, network, link, designId } = await scene(browser, theme, 2)
    const [bo] = others
    await network.down(bo.page)
    await bo.page.waitForSelector('[data-testid="collab-status"][data-state="offline"]')
    await bo.page.screenshot({ path: `${OUT}/status-offline-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } })
    await network.up(bo.page)
    await bo.page.waitForSelector('[data-testid="collab-status"][data-state="live"]', { timeout: 30_000 })
    await call(owner.context, 'delete', `/designs/${designId}/share-links/${link.id}/`)
    await bo.page.waitForSelector('[data-testid="collab-banner"]', { timeout: 20_000 })
    await bo.page.screenshot({ path: `${OUT}/notice-forbidden-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 200 } })
    for (const client of [owner, bo]) await client.context.close()
  })

  test(`watching ${theme}`, async ({ browser }) => {
    const { owner, others } = await scene(browser, theme, 2, 'view')
    const [cy] = others
    await cy.page.screenshot({ path: `${OUT}/status-watching-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } })
    for (const client of [owner, cy]) await client.context.close()
  })
}
