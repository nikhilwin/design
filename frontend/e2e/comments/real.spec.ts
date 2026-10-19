/**
 * Comments against the real backend: what is stored survives a reload at the same place of the same page, the roles of the
 * server and the editor agree (owner, somebody commenting through a link, a visitor who is not signed in, a view-only link),
 * moving a pin is saved, and a design with more than one page of comments (100 per page) shows them all.
 */
import { type Browser, type Page, expect, test } from '@playwright/test'
import { type Account, type Client, call, createAccounts, createDesign, createLink, documentOf, open, rect } from '../collab/helpers'

interface Row {
  id: string
  body: string
  page_id: string | null
  x: number | null
  y: number | null
  parent: string | null
  resolved: boolean
  author: { name: string }
}

const PAGE = { width: 800, height: 600 }
let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Olive', 'Sam', 'Vic'])
})

async function design(browser: Browser) {
  const owner = await open(browser, accounts.Olive, '/dashboard')
  const designId = await createDesign(owner, documentOf([[rect()], [rect({ fill: '#e11d48' })]]), 'Review me')
  const comment = await createLink(owner, designId, 'comment')
  const view = await createLink(owner, designId, 'view')
  return { owner, designId, comment, view }
}

async function stored(owner: Client, designId: string): Promise<Row[]> {
  const rows: Row[] = []
  for (let page = 1; ; page += 1) {
    const data = (await call(owner.context, 'get', `/designs/${designId}/comments/?page=${page}&page_size=100`)) as { next: string | null; results: Row[] }
    rows.push(...data.results)
    if (!data.next) return rows
  }
}

async function ready(page: Page): Promise<void> {
  await page.waitForSelector('[data-editor-root]')
  await page.waitForSelector('[data-artboard] .doory-canvas', { timeout: 30_000 })
}

/** Client coordinates of a point of the n-th page (the pages of these designs are all 800 x 600). */
async function clientOf(page: Page, x: number, y: number, index = 0): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-artboard]').nth(index).boundingBox()
  if (!box) throw new Error('no artboard')
  const scale = box.width / PAGE.width
  return { x: box.x + x * scale, y: box.y + y * scale }
}

const pinNamed = (page: Page, text: string) => page.getByRole('button', { name: new RegExp(`: ${text}`) })

async function tipOf(page: Page, text: string): Promise<{ x: number; y: number }> {
  const box = await pinNamed(page, text).boundingBox()
  if (!box) throw new Error(`no pin "${text}"`)
  return { x: box.x, y: box.y + box.height }
}

async function expectPinAt(page: Page, text: string, x: number, y: number, index = 0): Promise<void> {
  await expect
    .poll(async () => {
      const tip = await tipOf(page, text)
      const want = await clientOf(page, x, y, index)
      return Math.max(Math.abs(tip.x - want.x), Math.abs(tip.y - want.y))
    })
    .toBeLessThan(1.5)
}

async function openComments(page: Page): Promise<void> {
  await page.getByTestId('ed-end-comments').click()
  await expect(page.getByTestId('comments-panel')).toBeVisible()
}

test('the owner leaves a comment on a spot, and after a reload it is on the same spot of the same page', async ({ browser }) => {
  const { owner, designId } = await design(browser)
  await owner.page.goto(`/design/${designId}`)
  await ready(owner.page)
  await openComments(owner.page)

  const at = await clientOf(owner.page, 320, 210)
  await owner.page.mouse.click(at.x, at.y)
  await owner.page.getByTestId('pin-compose-text').fill('Move the logo up')
  await owner.page.getByTestId('pin-compose-send').click()
  await expect(pinNamed(owner.page, 'Move the logo up')).toBeVisible()

  await expect.poll(async () => (await stored(owner, designId)).length).toBe(1)
  const [row] = await stored(owner, designId)
  expect(row).toMatchObject({ body: 'Move the logo up', page_id: 'page-1', resolved: false, parent: null })
  expect(Math.abs((row.x ?? 0) - 320)).toBeLessThan(2.5)
  expect(Math.abs((row.y ?? 0) - 210)).toBeLessThan(2.5)

  await owner.page.reload()
  await ready(owner.page)
  await expect(owner.page.getByTestId('comments-badge')).toHaveText('1')
  await openComments(owner.page)
  await expectPinAt(owner.page, 'Move the logo up', row.x ?? 0, row.y ?? 0)

  // Zoomed in, the pin is still on the spot.
  await owner.page.keyboard.press('Shift+0')
  await expectPinAt(owner.page, 'Move the logo up', row.x ?? 0, row.y ?? 0)
  await owner.context.close()
})

test('reply, resolve, reopen and delete go to the server and are there after a reload', async ({ browser }) => {
  const { owner, designId } = await design(browser)
  await call(owner.context, 'post', `/designs/${designId}/comments/`, { body: 'Needs a second look', page_id: 'page-2', x: 400, y: 300 })
  await owner.page.goto(`/design/${designId}`)
  await ready(owner.page)
  await openComments(owner.page)
  await owner.page.locator('[data-artboard]').nth(1).scrollIntoViewIfNeeded()
  await pinNamed(owner.page, 'Needs a second look').click()
  const card = owner.page.getByTestId('pin-card')
  await card.getByTestId('pin-reply-text').fill('Looked again, fine')
  await card.getByTestId('pin-reply-send').click()
  await expect(card).toContainText('Looked again, fine')
  await card.getByTestId('pin-resolve').click()
  await expect(pinNamed(owner.page, 'Needs a second look')).toHaveAttribute('data-resolved', 'true')

  await expect.poll(async () => (await stored(owner, designId)).map((c) => [c.body, c.resolved, c.parent === null])).toEqual([
    ['Needs a second look', true, true],
    ['Looked again, fine', false, false],
  ])
  await owner.page.reload()
  await ready(owner.page)
  await openComments(owner.page)
  await expect(owner.page.getByRole('heading', { name: 'Resolved (1)' })).toBeVisible()
  await owner.page.getByTestId('comment-thread').getByTestId('comment-resolve').click()
  await expect.poll(async () => (await stored(owner, designId))[0].resolved).toBe(false)
  await owner.page.getByTestId('comment-thread').getByRole('button', { name: 'Delete thread' }).click()
  await owner.page.getByTestId('comment-delete-confirm').click()
  await expect.poll(async () => (await stored(owner, designId)).length).toBe(0)
  await owner.context.close()
})

test('a pin dragged to a new place stays there after a reload', async ({ browser }) => {
  const { owner, designId } = await design(browser)
  await call(owner.context, 'post', `/designs/${designId}/comments/`, { body: 'Drag me', page_id: 'page-1', x: 200, y: 200 })
  await owner.page.goto(`/design/${designId}`)
  await ready(owner.page)
  await openComments(owner.page)
  const tip = await tipOf(owner.page, 'Drag me')
  await owner.page.mouse.move(tip.x + 12, tip.y - 12)
  await owner.page.mouse.down()
  await owner.page.mouse.move(tip.x + 12 + 90, tip.y - 12 + 45, { steps: 8 })
  await owner.page.mouse.up()
  await expect.poll(async () => (await stored(owner, designId))[0].x).not.toBe(200)
  const [row] = await stored(owner, designId)
  const box = await owner.page.locator('[data-artboard]').first().boundingBox()
  const scale = (box?.width ?? PAGE.width) / PAGE.width
  expect(Math.abs((row.x ?? 0) - (200 + 90 / scale))).toBeLessThan(2.5)
  expect(Math.abs((row.y ?? 0) - (200 + 45 / scale))).toBeLessThan(2.5)
  await owner.page.reload()
  await ready(owner.page)
  await openComments(owner.page)
  await expectPinAt(owner.page, 'Drag me', row.x ?? 0, row.y ?? 0)
  await owner.context.close()
})

test('somebody commenting through a link: sees the pins, comments, moves and deletes only their own, and cannot resolve', async ({ browser }) => {
  const { owner, designId, comment } = await design(browser)
  await call(owner.context, 'post', `/designs/${designId}/comments/`, { body: 'From the owner', page_id: 'page-1', x: 150, y: 120 })
  const sam = await open(browser, accounts.Sam, `/s/${comment}`)
  await ready(sam.page)
  await call(sam.context, 'post', `/shared/${comment}/comments/`, { body: 'From Sam', page_id: 'page-1', x: 450, y: 250 })
  await sam.page.reload()
  await ready(sam.page)
  await openComments(sam.page)
  await expect(sam.page.getByTestId('comment-pin')).toHaveCount(2)
  await expect(sam.page.getByTestId('comment-resolve')).toHaveCount(0)
  await expect(pinNamed(sam.page, 'From the owner')).not.toHaveAttribute('data-movable', 'true')
  await expect(pinNamed(sam.page, 'From Sam')).toHaveAttribute('data-movable', 'true')
  await expect(sam.page.getByRole('button', { name: 'Delete thread' })).toHaveCount(1)

  // A new comment of his own.
  const at = await clientOf(sam.page, 600, 450)
  await sam.page.mouse.click(at.x, at.y)
  await sam.page.getByTestId('pin-compose-text').fill('A second note')
  await sam.page.getByTestId('pin-compose-send').click()
  await expect(pinNamed(sam.page, 'A second note')).toBeVisible()
  await expect.poll(async () => (await stored(owner, designId)).map((c) => c.author.name).sort()).toEqual(['Olive', 'Sam', 'Sam'])

  // His own pin moves through the link, saved by the server; the owner's does not.
  const tip = await tipOf(sam.page, 'From Sam')
  await sam.page.mouse.move(tip.x + 12, tip.y - 12)
  await sam.page.mouse.down()
  await sam.page.mouse.move(tip.x + 12 + 60, tip.y - 12 + 30, { steps: 8 })
  await sam.page.mouse.up()
  await expect.poll(async () => (await stored(owner, designId)).find((c) => c.body === 'From Sam')?.x).not.toBe(450)
  const ownerTip = await tipOf(sam.page, 'From the owner')
  await sam.page.mouse.move(ownerTip.x + 12, ownerTip.y - 12)
  await sam.page.mouse.down()
  await sam.page.mouse.move(ownerTip.x + 90, ownerTip.y + 40, { steps: 8 })
  await sam.page.mouse.up()
  expect((await stored(owner, designId)).find((c) => c.body === 'From the owner')).toMatchObject({ x: 150, y: 120 })

  // The server says the same when asked directly.
  const owners = (await stored(owner, designId)).find((c) => c.body === 'From the owner')
  const refused = await sam.context.request.patch(`/api/v1/shared/${comment}/comments/${owners?.id}/`, { data: { x: 1, y: 1 }, headers: { 'X-CSRFToken': (await sam.context.cookies()).find((c) => c.name === 'csrftoken')?.value ?? '' } })
  expect(refused.status()).toBe(404)

  // Deleting his own note.
  await pinNamed(sam.page, 'A second note').click()
  await sam.page.getByTestId('pin-card').getByRole('button', { name: 'Delete thread' }).click()
  await sam.page.getByTestId('pin-delete-confirm').click()
  await expect.poll(async () => (await stored(owner, designId)).length).toBe(2)
  await sam.context.close()

  // The owner sees both and may resolve and delete Sam's.
  await owner.page.goto(`/design/${designId}`)
  await ready(owner.page)
  await openComments(owner.page)
  await expect(owner.page.getByTestId('comment-pin')).toHaveCount(2)
  await expect(pinNamed(owner.page, 'From Sam')).toHaveAttribute('data-movable', 'true')
  await owner.page.getByTestId('comment-thread').filter({ hasText: 'From Sam' }).getByTestId('comment-resolve').click()
  await expect.poll(async () => (await stored(owner, designId)).find((c) => c.body === 'From Sam')?.resolved).toBe(true)
  await owner.context.close()
})

test('a visitor who is not signed in reads the pins and is sent to sign up when they try to comment; a view link has no comments', async ({ browser }) => {
  const { owner, designId, comment, view } = await design(browser)
  await call(owner.context, 'post', `/designs/${designId}/comments/`, { body: 'Public note', page_id: 'page-1', x: 300, y: 200 })
  const vic = await open(browser, null, `/s/${comment}`)
  await ready(vic.page)
  await openComments(vic.page)
  await expect(pinNamed(vic.page, 'Public note')).toBeVisible()
  await expect(vic.page.getByTestId('comment-resolve')).toHaveCount(0)
  await expect(vic.page.getByRole('button', { name: 'Delete thread' })).toHaveCount(0)
  await expect(pinNamed(vic.page, 'Public note')).not.toHaveAttribute('data-movable', 'true')
  const at = await clientOf(vic.page, 500, 400)
  await vic.page.mouse.click(at.x, at.y)
  await expect(vic.page.getByRole('dialog')).toBeVisible()
  expect((await stored(owner, designId)).length).toBe(1)
  await vic.context.close()

  const viewer = await open(browser, null, `/s/${view}`)
  await ready(viewer.page)
  await expect(viewer.page.getByTestId('ed-end-comments')).toHaveCount(0)
  const refused = await viewer.page.request.get(`/api/v1/shared/${view}/comments/`)
  expect(refused.status()).toBe(404)
  expect((await refused.json()).error.code).toBe('comments_disabled')
  await viewer.context.close()
  await owner.context.close()
})

test('more than a page of comments (the server sends 100 at a time) are all there', async ({ browser }) => {
  test.setTimeout(240_000)
  const { owner, designId, comment } = await design(browser)
  const sam = await open(browser, accounts.Sam, `/s/${comment}`)
  const vic = await open(browser, accounts.Vic, `/s/${comment}`)
  // The server lets one person make 60 comments a minute: three people make 40 each.
  const make = async (client: Client, path: string, who: string, from: number): Promise<void> => {
    for (let i = from; i < from + 40; i += 1) {
      const page = i % 2 === 0 ? 'page-1' : 'page-2'
      await call(client.context, 'post', path, { body: `${who} ${i}`, page_id: page, x: 20 + (i % 20) * 36, y: 30 + Math.floor(i / 20) * 40 })
    }
  }
  await make(owner, `/designs/${designId}/comments/`, 'Olive', 0)
  await make(sam, `/shared/${comment}/comments/`, 'Sam', 40)
  await make(vic, `/shared/${comment}/comments/`, 'Vic', 80)
  expect((await stored(owner, designId)).length).toBe(120)

  await owner.page.goto(`/design/${designId}`)
  await ready(owner.page)
  await expect(owner.page.getByTestId('comments-badge')).toHaveText('99+')
  await openComments(owner.page)
  await expect(owner.page.getByTestId('comment-thread')).toHaveCount(120)
  await expect(owner.page.getByTestId('comment-pin').first()).toBeVisible()
  await sam.context.close()
  await vic.context.close()
  await owner.context.close()
})
