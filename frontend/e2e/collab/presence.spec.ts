import { type Browser, expect, test } from '@playwright/test'
import { type Account, type Client, createAccounts, createDesign, createLink, documentOf, isEditingText, open, rect, select, selectedIds, textbox, toClient, whenLive } from './helpers'

const SHOTS = process.env.SCREENSHOT_DIR

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy'])
})

async function room(browser: Browser, theme: 'light' | 'dark' = 'light') {
  const card = rect({ left: 220, top: 330, width: 220, height: 160 })
  const badge = rect({ left: 560, top: 400, width: 140, height: 140, fill: '#7c3aed', angle: 12 })
  const title = textbox({ left: 400, top: 120 })
  const owner = await open(browser, accounts.Ada, '/dashboard', { theme })
  const designId = await createDesign(owner, documentOf([[card, badge, title]]), 'Summer sale poster')
  const token = await createLink(owner, designId, 'edit')
  await owner.page.goto(`/design/${designId}`)
  const bo = await open(browser, accounts.Bo, `/s/${token}`, { theme })
  await Promise.all([whenLive(owner.page), whenLive(bo.page)])
  return { ada: owner, bo, card, badge, title, designId, token }
}

async function close(...clients: Client[]): Promise<void> {
  for (const client of clients) await client.context.close()
}

test('shows who is here: avatar stack, live status, pointer, selection', async ({ browser }) => {
  const { ada, bo, card } = await room(browser)

  // The stack lists the other person, and the status pill counts both.
  await expect(bo.page.locator('[data-testid="presence-avatar"][data-user="Ada"]')).toBeVisible()
  await expect(ada.page.locator('[data-testid="presence-avatar"][data-user="Bo"]')).toBeVisible()
  await expect(bo.page.getByTestId('collab-status')).toContainText('Live · 2 people')

  // Ada's pointer is drawn on Bo's page where she holds it.
  const at = await toClient(ada.page, 300, 250)
  await ada.page.mouse.move(at.x - 40, at.y - 40)
  await ada.page.mouse.move(at.x, at.y, { steps: 6 })
  const cursor = bo.page.locator('[data-testid="remote-cursor"][data-user="Ada"]')
  await expect(cursor).toBeVisible()
  const expected = await toClient(bo.page, 300, 250)
  await expect
    .poll(async () => {
      const shown = await cursor.boundingBox()
      return Math.max(Math.abs((shown?.x ?? 0) - expected.x), Math.abs((shown?.y ?? 0) - expected.y))
    })
    .toBeLessThan(6)

  // Her selection is outlined on Bo's page, with her name.
  const target = await toClient(ada.page, 220, 330)
  await ada.page.mouse.click(target.x, target.y)
  await expect(bo.page.locator('[data-testid="remote-selection"][data-user="Ada"]')).toBeVisible()
  expect(await selectedIds(ada.page)).toEqual([card.id])
  if (SHOTS) {
    await bo.page.screenshot({ path: `${SHOTS}/presence-selection-light.png` })
  }
  await close(ada, bo)
})

test('a text somebody is typing in cannot be edited by others, but can be moved', async ({ browser }) => {
  const { ada, bo, title } = await room(browser)
  const where = await toClient(ada.page, 400, 120)
  await ada.page.mouse.dblclick(where.x, where.y)
  await expect.poll(() => isEditingText(ada.page)).toBe(true)
  await expect(bo.page.getByTestId('text-lock-badge')).toContainText('Ada is editing this text')
  if (SHOTS) await bo.page.screenshot({ path: `${SHOTS}/presence-text-lock-light.png` })

  const same = await toClient(bo.page, 400, 120)
  await bo.page.mouse.dblclick(same.x, same.y)
  await expect(bo.page.getByText('Ada is editing this text. You can move or style it')).toBeVisible()
  expect(await isEditingText(bo.page)).toBe(false)

  // Leaving edit mode frees the text.
  await ada.page.keyboard.press('Escape')
  await expect.poll(() => isEditingText(ada.page)).toBe(false)
  await expect(bo.page.getByTestId('text-lock-badge')).toHaveCount(0)
  await select(bo.page, [title.id])
  await bo.page.mouse.dblclick(same.x, same.y)
  await expect.poll(() => isEditingText(bo.page)).toBe(true)
  await close(ada, bo)
})

test('clicking an avatar follows that person; scrolling yourself stops it', async ({ browser }) => {
  const { ada, bo } = await room(browser)
  const avatar = bo.page.locator('[data-testid="presence-avatar"][data-user="Ada"]')
  await avatar.click()
  await expect(avatar).toHaveAttribute('aria-pressed', 'true')
  await expect(bo.page.getByTestId('follow-badge')).toContainText('Following Ada')
  await bo.page.mouse.move(700, 500)
  await bo.page.mouse.wheel(0, 200)
  await expect(bo.page.getByTestId('follow-badge')).toHaveCount(0)
  await expect(avatar).toHaveAttribute('aria-pressed', 'false')
  await close(ada, bo)
})
