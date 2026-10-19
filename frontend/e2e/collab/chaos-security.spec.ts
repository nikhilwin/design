import { type Browser, expect, test } from '@playwright/test'
import { Forger, RawSocket, awarenessState, canonical, cookieHeader, engineOf, deepUpdate, foreignRootUpdate, frame, gapUpdate, metaUpdate, stored, upgrade } from './chaos-support'
import { type Account, type Client, type DocLike, call, createAccounts, createDesign, createLink, createLinkWithId, document_, documentOf, nudge, open, rect, saveNow, select, status, whenLive } from './helpers'

let accounts: Record<string, Account>

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  accounts = await createAccounts(browser, ['Ada', 'Bo', 'Cy', 'Di'])
})

interface Setup {
  designId: string
  ada: Client
  edit: string
  view: string
  comment: string
  shapes: string[]
}

/** Ada has the design open (live); links of every kind exist. */
async function design(browser: Browser): Promise<Setup> {
  const shapes = [rect({ left: 200 }), rect({ left: 500, fill: '#7c3aed' })]
  const ada = await open(browser, accounts.Ada, '/dashboard')
  const designId = await createDesign(ada, documentOf([shapes]), 'Under attack')
  const edit = await createLink(ada, designId, 'edit')
  const view = await createLink(ada, designId, 'view')
  const comment = await createLink(ada, designId, 'comment')
  await ada.page.goto(`/design/${designId}`)
  await whenLive(ada.page)
  return { designId, ada, edit, view, comment, shapes: shapes.map((s) => s.id) }
}

/** A page of `name`'s account that is not an editor: it only hosts raw sockets. */
async function host(browser: Browser, name: string): Promise<Client> {
  return open(browser, accounts[name], '/dashboard')
}

/** A raw socket that has logged in with the share token and has been told it is ready. */
async function login(client: Client, designId: string, token: string): Promise<{ socket: RawSocket; ready: Record<string, unknown> }> {
  const socket = await RawSocket.open(client.page, designId)
  await socket.send(JSON.stringify({ type: 'auth', token }))
  return { socket, ready: await socket.ready() }
}

/** The shared design is exactly what it was, in the room and in the database. */
async function untouched(setup: Setup, before: string): Promise<void> {
  expect(canonical(await document_(setup.ada.page))).toBe(before)
  expect(canonical(await stored(setup.ada, setup.designId))).toBe(before)
}

test('a viewer who forges update frames changes nothing, and the server tells them once', async ({ browser }) => {
  const setup = await design(browser)
  const cy = await host(browser, 'Cy')
  const before = canonical(await document_(setup.ada.page))
  const { socket, ready } = await login(cy, setup.designId, setup.view)
  expect(ready).toMatchObject({ role: 'view', canWrite: false })
  await socket.send(frame.step1(new Uint8Array([0])))
  for (let i = 0; i < 6; i++) await socket.send(frame.update(metaUpdate('width', 1 + i)))
  await socket.send(frame.update(foreignRootUpdate()))
  await socket.send(JSON.stringify({ type: 'flush' }))
  await socket.send(frame.awareness(31337, 1, { user: { color: '#000000' }, cursor: { pageId: 'p', x: 1, y: 2 } }))
  // The same answer as for the first forged frame, once; the socket stays open (a viewer's awareness still flows).
  await expect.poll(async () => (await socket.frames()).filter((f) => f.bytes && f.bytes[0] === 2).length).toBe(1)
  expect(await socket.isOpen()).toBe(true)
  await untouched(setup, before)
  await expect(setup.ada.page.locator('[data-testid="presence-avatar"][data-user="Cy"]')).toBeVisible()
  await socket.close()
  await cy.context.close()
  await setup.ada.context.close()
})

const HOSTILE: [string, (valid: Uint8Array) => string | Uint8Array, number, string][] = [
  ['a frame above the size limit', () => new Uint8Array(1_100_000).fill(7), 4413, 'frame_too_large'],
  ['bytes that are no frame at all', () => Uint8Array.from([7, 7, 7, 7]), 4400, 'bad_frame'],
  ['an unknown message type', () => Uint8Array.from([9, 0]), 4400, 'bad_frame'],
  ['a sync frame cut short', () => Uint8Array.from([0, 2, 200]), 4400, 'bad_frame'],
  ['an update that writes to a root type the design does not have', () => frame.update(foreignRootUpdate()), 4400, 'bad_frame'],
  ['an update that builds on history the server never saw', () => frame.update(gapUpdate()), 4400, 'bad_frame'],
  ['a value nested a thousand levels deep', () => frame.update(deepUpdate(1000)), 4400, 'bad_frame'],
  ['text that is not JSON', () => 'this is not json', 4400, 'bad_frame'],
  ['a text frame of an unknown type', () => '{"type":"hello"}', 4400, 'bad_frame'],
]

for (const [name, build, code, reason] of HOSTILE) {
  test(`a signed-in editor who sends ${name} is disconnected (${code} ${reason}) and the design is unharmed`, async ({ browser }) => {
    const setup = await design(browser)
    const bo = await host(browser, 'Bo')
    const before = canonical(await document_(setup.ada.page))
    const { socket } = await login(bo, setup.designId, setup.edit)
    await socket.send(frame.step1(new Uint8Array([0])))
    await socket.send(build(new Uint8Array()))
    expect(await socket.closed()).toEqual({ code, reason })
    await untouched(setup, before)
    // The room carries on: Ada is still live and a fresh editor gets in and sees the design.
    expect(await status(setup.ada.page)).toBe('live')
    const again = await open(browser, accounts.Bo, `/s/${setup.edit}`)
    await whenLive(again.page)
    expect(canonical(await document_(again.page))).toBe(before)
    await bo.context.close()
    await again.context.close()
    await setup.ada.context.close()
  })
}

test('the login cannot be bypassed or guessed: no token, a wrong token, another design, a binary frame first, a foreign origin', async ({ browser }) => {
  const setup = await design(browser)
  const other = await createDesign(setup.ada, documentOf([[rect()]]), 'Another design')
  const otherEdit = await createLink(setup.ada, other, 'edit')
  const bo = await host(browser, 'Bo')

  const noFrame = await RawSocket.open(bo.page, setup.designId)
  await noFrame.send(frame.step1(new Uint8Array([0])))
  expect(await noFrame.closed()).toEqual({ code: 4400, reason: 'auth_required' })

  const wrong = await RawSocket.open(bo.page, setup.designId)
  await wrong.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(32) }))
  expect(await wrong.closed()).toEqual({ code: 4403, reason: 'forbidden' })

  const elsewhere = await RawSocket.open(bo.page, setup.designId)
  await elsewhere.send(JSON.stringify({ type: 'auth', token: otherEdit }))
  expect(await elsewhere.closed()).toEqual({ code: 4403, reason: 'forbidden' })

  const noToken = await RawSocket.open(bo.page, setup.designId)
  await noToken.send(JSON.stringify({ type: 'auth' }))
  expect(await noToken.closed()).toEqual({ code: 4400, reason: 'bad_auth' })

  const notJson = await RawSocket.open(bo.page, setup.designId)
  await notJson.send('{{{')
  expect(await notJson.closed()).toEqual({ code: 4400, reason: 'bad_auth' })

  const badType = await RawSocket.open(bo.page, setup.designId)
  await badType.send(JSON.stringify({ type: 'auth', token: 12345 }))
  expect(await badType.closed()).toEqual({ code: 4400, reason: 'bad_auth' })

  // A page of another site cannot open a socket with the visitor's cookies, and neither can a missing origin.
  const path = `/ws/designs/${setup.designId}/`
  const session = cookieHeader(accounts.Bo)
  expect(await upgrade(path, { Origin: 'https://evil.example', Cookie: session })).toBe(403)
  expect(await upgrade(path, { Cookie: session })).toBe(403)
  expect(await upgrade(path, { Origin: `http://localhost:${process.env.E2E_COLLAB_PORT ?? 5380}`, Cookie: session })).toBe(101)

  // A revoked link stops working for a socket that has not logged in yet.
  const revocable = await createLinkWithId(setup.ada, setup.designId, 'edit')
  await call(setup.ada.context, 'delete', `/designs/${setup.designId}/share-links/${revocable.id}/`)
  const revoked = await RawSocket.open(bo.page, setup.designId)
  await revoked.send(JSON.stringify({ type: 'auth', token: revocable.token }))
  expect(await revoked.closed()).toEqual({ code: 4403, reason: 'forbidden' })

  expect(await status(setup.ada.page)).toBe('live')
  await bo.context.close()
  await setup.ada.context.close()
})

test('a link with a password: five wrong guesses end the socket, the right one gets in', async ({ browser }) => {
  const setup = await design(browser)
  const secret = await createLink(setup.ada, setup.designId, 'edit', 'correct horse battery')
  const bo = await host(browser, 'Bo')
  const guesses = await RawSocket.open(bo.page, setup.designId)
  for (let i = 0; i < 4; i++) {
    await guesses.send(JSON.stringify({ type: 'auth', token: secret, password: `wrong-${i}` }))
    await expect.poll(async () => (await guesses.texts()).filter((t) => t.code === 'password_required').length).toBe(i + 1)
  }
  expect(await guesses.isOpen()).toBe(true)
  await guesses.send(JSON.stringify({ type: 'auth', token: secret, password: 'wrong-4' }))
  expect(await guesses.closed()).toEqual({ code: 4403, reason: 'forbidden' })

  const right = await RawSocket.open(bo.page, setup.designId)
  await right.send(JSON.stringify({ type: 'auth', token: secret, password: 'correct horse battery' }))
  expect(await right.ready()).toMatchObject({ role: 'edit', canWrite: true })
  await right.close()
  await bo.context.close()
  await setup.ada.context.close()
})

test('a flood of frames ends that socket with 4429 and does not slow the others down', async ({ browser }) => {
  const setup = await design(browser)
  const bo = await host(browser, 'Bo')
  const before = canonical(await document_(setup.ada.page))

  const awarenessFlood = (await login(bo, setup.designId, setup.edit)).socket
  await awarenessFlood.flood(frame.awareness(777, 1, { cursor: { pageId: 'p', x: 1, y: 1 } }), 1500)
  expect(await awarenessFlood.closed()).toEqual({ code: 4429, reason: 'rate_limited' })

  const queryFlood = (await login(bo, setup.designId, setup.edit)).socket
  await queryFlood.flood(Uint8Array.from([3]), 1500)
  expect(await queryFlood.closed()).toEqual({ code: 4429, reason: 'rate_limited' })

  const bigAwareness = (await login(bo, setup.designId, setup.edit)).socket
  await bigAwareness.send(awarenessState({ cursor: { pageId: 'p', x: 1, y: 1 }, note: 'x'.repeat(3000) }))
  expect(await bigAwareness.closed()).toEqual({ code: 4400, reason: 'bad_frame' })

  await untouched(setup, before)
  expect(await status(setup.ada.page)).toBe('live')
  await bo.context.close()
  await setup.ada.context.close()
})

test('nobody can pose as somebody else in the presence list, or take over another window\'s identity', async ({ browser }) => {
  const setup = await design(browser)
  const bo = await host(browser, 'Bo')
  const { socket } = await login(bo, setup.designId, setup.edit)
  // Bo claims to be Ada, with an owner role and a script in the name.
  await socket.send(frame.awareness(424242, 1, { user: { id: 'someone-else', name: '<img src=x onerror=alert(1)>', role: 'owner', color: 'red', avatarUrl: 'javascript:alert(1)' }, cursor: { pageId: 'p', x: 5, y: 5 } }))
  const peers = () =>
    setup.ada.page.evaluate(() =>
      (window as unknown as { __doory_collab: { session: { presence: { store: { getState(): { peers: { name: string; role: string; userId: string; avatarUrl: string | null; color: string }[] } } } } } }).__doory_collab.session.presence.store
        .getState()
        .peers.map((p) => ({ name: p.name, role: p.role, userId: p.userId, avatarUrl: p.avatarUrl, color: p.color })),
    )
  await expect.poll(async () => (await peers()).length).toBe(1)
  const [shown] = await peers()
  expect(shown.name).toBe('Bo')
  expect(shown.role).toBe('edit')
  expect(shown.userId).not.toBe('someone-else')
  expect(shown.avatarUrl).toBeNull()
  expect(shown.color).toMatch(/^#[0-9a-f]{6}$/i)
  await expect(setup.ada.page.locator('img[src^="javascript"]')).toHaveCount(0)
  // A second socket cannot take over the awareness id of the first.
  const { socket: thief } = await login(bo, setup.designId, setup.edit)
  await thief.send(frame.awareness(424242, 99, { cursor: { pageId: 'p', x: 500, y: 500 } }))
  await thief.send(frame.step1(new Uint8Array([0])))
  await expect.poll(async () => (await thief.frames()).some((f) => f.bytes && f.bytes[0] === 0)).toBe(true)
  const cursors = await setup.ada.page.evaluate(() => (window as unknown as { __doory_collab: { session: { presence: { store: { getState(): { peers: { cursor: { x: number } | null }[] } } } } } }).__doory_collab.session.presence.store.getState().peers.map((p) => p.cursor?.x ?? null))
  expect(cursors).not.toContain(500)
  await bo.context.close()
  await setup.ada.context.close()
})

test('people who are not allowed in see nothing of the design, whatever they try', async ({ browser }) => {
  const setup = await design(browser)
  const di = await host(browser, 'Di')
  // Di has no link: not the owner, so the login is required, and nothing but a valid token gets past it.
  const guess = await RawSocket.open(di.page, setup.designId)
  await guess.send(JSON.stringify({ type: 'auth', token: setup.edit.slice(0, 31) }))
  expect(await guess.closed()).toEqual({ code: 4403, reason: 'forbidden' })
  const frames = await guess.frames()
  expect(frames.filter((f) => f.bytes)).toEqual([])
  expect((await guess.texts()).some((t) => t.type === 'ready')).toBe(false)
  // And the REST side agrees: the owner's design is not readable.
  const response = await di.context.request.get(`/api/v1/designs/${setup.designId}/`)
  expect([403, 404]).toContain(response.status())
  await di.context.close()
  await setup.ada.context.close()

})

test('a hostile writer who spoils the size of the design cannot keep it from being drawn or saved: the editors put their size back', async ({ browser }) => {
  const setup = await design(browser)
  const bo = await host(browser, 'Bo')
  const { socket } = await login(bo, setup.designId, setup.edit)
  const forger = await Forger.join(socket)
  await forger.write((doc) => doc.getMap('meta').set('width', 'not a number'))
  await setup.ada.page.waitForTimeout(1500)
  expect((await document_(setup.ada.page)).width).toBe(800)
  // Ada's next change is saved: her editor repaired the size, and the server can validate the design again.
  await select(setup.ada.page, [setup.shapes[0]])
  await nudge(setup.ada.page, 50)
  await saveNow(setup.ada.page)
  const saved = await stored(setup.ada, setup.designId)
  expect(saved.width).toBe(800)
  const first = saved.pages[0].objects[0] as unknown as { left: number }
  expect(first.left).toBe(250)
  expect(await status(setup.ada.page)).toBe('live')
  await bo.context.close()
  await setup.ada.context.close()
})

test('a hostile writer who puts a value in the design that the server will not save is announced, and the banner goes when it is put right', async ({ browser }) => {
  test.setTimeout(120_000)
  const setup = await design(browser)
  const bo = await host(browser, 'Bo')
  const { socket } = await login(bo, setup.designId, setup.edit)
  const forger = await Forger.join(socket)
  const pageId = (await document_(setup.ada.page)).pages[0].id
  await forger.write((doc) => (doc.getMap('pages').get(pageId) as import('yjs').Map<unknown>).set('durationSec', -5))
  await expect.poll(async () => ((await document_(setup.ada.page)).pages[0] as { durationSec?: number }).durationSec).toBe(-5)
  await select(setup.ada.page, [setup.shapes[0]])
  await nudge(setup.ada.page, 50)
  await saveNow(setup.ada.page)
  await expect(setup.ada.page.getByTestId('collab-banner')).toContainText('This design is not being saved')
  // The design in the database is still the one before the poison.
  expect(((await call(setup.ada.context, 'get', `/designs/${setup.designId}/`)) as { document: DocLike }).document.pages[0].objects[0].left).toBe(200)
  // Ada puts the value right; the next save works and the banner goes.
  await (await engineOf(setup.ada.page)).evaluate((e, id) => e.pages.setDuration(id, 10), pageId)
  await saveNow(setup.ada.page)
  await expect(setup.ada.page.getByTestId('collab-banner')).toHaveCount(0)
  expect(((await call(setup.ada.context, 'get', `/designs/${setup.designId}/`)) as { document: DocLike }).document.pages[0].objects[0].left).toBe(250)
  await bo.context.close()
  await setup.ada.context.close()
})
