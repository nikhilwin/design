import { readFileSync } from 'node:fs'
import { type Browser, expect, test } from '@playwright/test'
import { Wire, canonical, converged, engineOf } from './chaos-support'
import { type Account, type Client, call, createAccounts, createDesign, createLink, document_, documentOf, isEditingText, nudge, objectById, open, rect, saveNow, select, status, textbox, toClient, undo, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy'])
})

interface Pair {
  ada: Client
  bo: Client
  boWire: Wire
  designId: string
  token: string
}

/** Ada and Bo have the design open; Bo's connection can be cut, so that the two act without knowing about each other. */
async function pair(browser: Browser, objects: ReturnType<typeof rect>[][], size?: { width: number; height: number }): Promise<Pair> {
  const ada = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(ada, documentOf(objects, size), 'Conflicts')
  const token = await createLink(ada, designId, 'edit')
  await ada.page.goto(`/design/${designId}`)
  const boWire = new Wire()
  const bo = await open(browser, accounts.Bo, `/s/${token}`, { before: (page) => boWire.install(page) })
  await Promise.all([whenLive(ada.page), whenLive(bo.page)])
  return { ada, bo, boWire, designId, token }
}

/** Bo works offline while Ada works online; then Bo comes back. */
async function apart(p: Pair, adaDoes: () => Promise<void>, boDoes: () => Promise<void>): Promise<void> {
  await p.boWire.down(p.bo.page)
  await expect.poll(() => status(p.bo.page)).toMatch(/offline|connecting/)
  await Promise.all([adaDoes(), boDoes()])
  await p.boWire.up(p.bo.page)
  await expect.poll(() => status(p.bo.page), { timeout: 40_000 }).toBe('live')
}

test('adding a page while somebody resizes the first one: both happen, and everybody ends with the same sizes', async ({ browser }) => {
  const p = await pair(browser, [[rect({ id: 'a' })], [rect({ id: 'b' })]], { width: 800, height: 600 })
  const pages = (await document_(p.ada.page)).pages.map((page) => page.id)
  await apart(
    p,
    async () => {
      await (await engineOf(p.ada.page)).evaluate((e, pageId) => e.pages.resize(1000, 800, 'scale', { scope: 'page', pageId }), pages[0])
    },
    async () => {
      await (await engineOf(p.bo.page)).evaluate((e) => e.pages.add(1))
    },
  )
  const shared = await converged([p.ada, p.bo], 30_000)
  const sizes = shared.pages.map((page) => ({ w: page.width ?? shared.width, h: page.height ?? shared.height }))
  console.log(`sizes after a page was added while the first was resized: ${JSON.stringify({ document: [shared.width, shared.height], pages: sizes })}`)
  // The first page has the size Ada gave it, the page Bo added exists, and the pages Ada did not touch kept their size.
  expect(shared.pages).toHaveLength(3)
  expect(sizes[0]).toEqual({ w: 1000, h: 800 })
  expect(sizes.filter((s) => s.w === 800 && s.h === 600).length).toBeGreaterThanOrEqual(1)
  await p.ada.context.close()
  await p.bo.context.close()
})

test('two people restyle the same group at once: one whole style wins, the same everywhere, and a move made meanwhile survives', async ({ browser }) => {
  const a = rect({ id: 'c1', left: 100, top: 100 })
  const b = rect({ id: 'c2', left: 300, top: 100 })
  const group = { id: 'grp', type: 'group', left: 300, top: 200, width: 400, height: 150, scaleX: 1, scaleY: 1, originX: 'center', originY: 'center', angle: 0, objects: [a, b] }
  const p = await pair(browser, [[group as never]])
  await select(p.ada.page, ['grp'])
  await select(p.bo.page, ['grp'])
  await apart(
    p,
    async () => {
      await (await engineOf(p.ada.page)).evaluate((e) => {
        e.style.setFill({ type: 'solid', color: '#e11d48' })
        e.arrange.nudge(30, 0)
      })
    },
    async () => {
      await (await engineOf(p.bo.page)).evaluate((e) => e.style.setFill({ type: 'solid', color: '#2563eb' }))
    },
  )
  const shared = await converged([p.ada, p.bo], 30_000)
  const merged = shared.pages[0].objects[0] as unknown as { left: number; objects: { fill: string }[] }
  // Children are one value of the group: the colours of both children come from one person.
  expect(new Set(merged.objects.map((child) => child.fill)).size).toBe(1)
  expect(['#e11d48', '#2563eb']).toContain(merged.objects[0].fill)
  // The move is another property: it is not lost whoever won the colour.
  expect(merged.left).toBe(330)
  await p.ada.context.close()
  await p.bo.context.close()
})

test('two people type into the same text at once: the lock sorts it out, and what remains is one person\'s whole text', async ({ browser }) => {
  const title = textbox({ id: 'title', left: 400, top: 120, text: 'Summer sale' })
  const p = await pair(browser, [[title]])
  p.boWire.lag = 600
  const at = await toClient(p.ada.page, 400, 120)
  const bo = await toClient(p.bo.page, 400, 120)
  // Both start editing before either knows about the other (Bo's frames take 600 ms each way).
  await Promise.all([p.ada.page.mouse.dblclick(at.x, at.y), p.bo.page.mouse.dblclick(bo.x, bo.y)])
  await expect.poll(() => isEditingText(p.ada.page)).toBe(true)
  await p.ada.page.keyboard.type(' AAA')
  await p.bo.page.keyboard.type(' BBB')
  await p.ada.page.waitForTimeout(2500)
  p.boWire.lag = 0
  await p.ada.page.keyboard.press('Escape')
  await p.bo.page.keyboard.press('Escape')
  await p.ada.page.mouse.click(5, 5)
  await p.bo.page.mouse.click(5, 5)
  const shared = await converged([p.ada, p.bo], 30_000)
  const text = (shared.pages[0].objects[0] as unknown as { text: string }).text
  console.log(`text after two people typed at once: ${JSON.stringify(text)}`)
  // The text is a single value, last writer wins: one person's typing remains, whole, and the other's is replaced. Never a mixture.
  expect(text.includes('AAA') !== text.includes('BBB')).toBe(true)
  expect(text).not.toMatch(/A.*B|B.*A/)
  expect(await isEditingText(p.ada.page)).toBe(false)
  expect(await isEditingText(p.bo.page)).toBe(false)
  await p.ada.context.close()
  await p.bo.context.close()
})

test('undo after a restored version has nothing to undo, and a change made before the restore does not come back', async ({ browser }) => {
  const first = rect({ id: 'one', left: 200 })
  const p = await pair(browser, [[first]])
  await select(p.ada.page, ['one'])
  await nudge(p.ada.page, 40)
  await saveNow(p.ada.page)
  await call(p.ada.context, 'post', `/designs/${p.designId}/versions/`, { label: 'Before' })
  await nudge(p.ada.page, 100)
  await expect.poll(async () => (await objectById(p.bo.page, 'one'))?.left).toBe(340)
  await saveNow(p.ada.page)
  const versions = (await call(p.ada.context, 'get', `/designs/${p.designId}/versions/`)) as { results?: { id: string; label: string }[] } | { id: string; label: string }[]
  const list = Array.isArray(versions) ? versions : (versions.results ?? [])
  const named = list.find((v) => v.label === 'Before')
  expect(named).toBeTruthy()
  await call(p.ada.context, 'post', `/designs/${p.designId}/versions/${named?.id}/restore/`)
  for (const client of [p.ada, p.bo]) await expect.poll(async () => (await objectById(client.page, 'one'))?.left, { timeout: 30_000 }).toBe(240)
  // Neither window can undo into the time before the restore.
  await undo(p.ada.page)
  await undo(p.bo.page)
  await p.ada.page.waitForTimeout(500)
  for (const client of [p.ada, p.bo]) expect((await objectById(client.page, 'one'))?.left).toBe(240)
  expect(canonical(await document_(p.ada.page))).toBe(canonical(await document_(p.bo.page)))
  await p.ada.context.close()
  await p.bo.context.close()
})

test('a design moved to the trash while two people edit it ends their editing; restoring it from the trash lets them back in after a reload', async ({ browser }) => {
  const p = await pair(browser, [[rect({ id: 'x', left: 200 })]])
  await call(p.ada.context, 'delete', `/designs/${p.designId}/`)
  await expect(p.ada.page.getByTestId('collab-banner')).toContainText('This design is gone', { timeout: 20_000 })
  await expect(p.bo.page.getByTestId('collab-banner')).toBeVisible({ timeout: 20_000 })
  // The people who were editing keep what they have on screen but nothing more is shared.
  await call(p.ada.context, 'post', `/designs/${p.designId}/restore/`)
  await p.ada.page.reload()
  await whenLive(p.ada.page)
  await p.bo.page.reload()
  await whenLive(p.bo.page)
  await select(p.ada.page, ['x'])
  await nudge(p.ada.page, 10)
  await expect.poll(async () => (await objectById(p.bo.page, 'x'))?.left).toBe(210)
  await p.ada.context.close()
  await p.bo.context.close()
})

interface Uploaded {
  family: string
}

/** Uploads a real font file (the variable Inter the app ships) under the account of `client`, as a family called `name`. */
async function uploadFont(client: Client, name: string): Promise<Uploaded> {
  const csrf = (await client.context.cookies()).find((c) => c.name === 'csrftoken')?.value ?? ''
  const file = readFileSync(new URL('../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', import.meta.url))
  const response = await client.context.request.post('/api/v1/fonts/mine/', { multipart: { family: name, files: { name: 'Doory-Test.woff2', mimeType: 'font/woff2', buffer: file } }, headers: { 'X-CSRFToken': csrf } })
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()) as Uploaded
}

test('uploaded fonts of the owner reach people with an edit link when they open the design; a font used later reaches them after the design is saved and they reload', async ({ browser }) => {
  const ada = await open(browser, accounts.Ada, '/dashboard')
  const first = await uploadFont(ada, `Chaos Sans ${Date.now() % 100000}`)
  const second = await uploadFont(ada, `Chaos Serif ${Date.now() % 100000}`)
  const title = textbox({ id: 'title', left: 400, top: 120, fontFamily: `"${first.family}", sans-serif` })
  const designId = await createDesign(ada, documentOf([[title]]), 'Fonts')
  const token = await createLink(ada, designId, 'edit')
  await ada.page.goto(`/design/${designId}`)
  const families = (page: Parameters<typeof whenLive>[0]) =>
    page.evaluate(() => (window as unknown as { __doory_collab: { engine: { userFonts: { getSnapshot(): { source: string; families: { family: string }[] } } } } }).__doory_collab.engine.userFonts.getSnapshot())
  const bo = await open(browser, accounts.Bo, `/s/${token}`)
  await Promise.all([whenLive(ada.page), whenLive(bo.page)])
  // Bo gets the owner's uploaded family that the design names, and no other font of the owner's library.
  await expect.poll(async () => (await families(bo.page)).families.map((f) => f.family)).toEqual([first.family])
  expect((await families(bo.page)).source).toBe('shared')

  // Ada now uses the second family. Bo's window does not learn about it until it is opened again (known limitation).
  await (await engineOf(ada.page)).evaluate((e, family) => {
    const w = window as unknown as { __doory_collab: { engine: { state: { doc: { pages: { id: string; objects: { id: string }[] }[] } }; select(ids: string[], pageId?: string): void; style: { text(patch: { fontFamily: string }): void } } } }
    w.__doory_collab.engine.select(['title'], w.__doory_collab.engine.state.doc.pages[0].id)
    w.__doory_collab.engine.style.text({ fontFamily: family })
    void e
  }, `"${second.family}", sans-serif`)
  await expect.poll(async () => (await objectById(bo.page, 'title'))?.fontFamily).toContain(second.family)
  expect((await families(bo.page)).families.map((f) => f.family)).toEqual([first.family])
  // The fonts of a shared design are read from the saved design, which trails the room by up to ten seconds: save it first.
  await saveNow(ada.page)
  await bo.page.reload()
  await whenLive(bo.page)
  await expect.poll(async () => (await families(bo.page)).families.map((f) => f.family)).toEqual([second.family])
  await ada.context.close()
  await bo.context.close()
})
