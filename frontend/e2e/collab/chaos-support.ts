/**
 * Support for the chaos specs: a seeded random number generator, random editor actions that run in the page through the
 * test hook, a raw WebSocket client that speaks (and forges) the wire protocol from inside a signed-in page, control of the
 * API process (stop, start, crash) and the checks that all browsers hold the same design as the server.
 */
import { type JSHandle, type Page, type WebSocketRoute, expect } from '@playwright/test'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { type Client, type DocLike, call, document_ } from './helpers'

const API = Number(process.env.E2E_COLLAB_API_PORT ?? 8110)
const CONTROL = `http://127.0.0.1:${process.env.E2E_COLLAB_CONTROL_PORT ?? API + 1}`

/* ------------------------------------------------------------------------------------------------
 * The API process
 * ------------------------------------------------------------------------------------------------ */

/** Stops, starts or restarts the API (one process, one in-memory channel layer): 'crash' is SIGKILL, 'graceful' SIGTERM. */
export async function api(action: 'restart' | 'halt' | 'start', mode: 'crash' | 'graceful' = 'graceful'): Promise<void> {
  const response = await fetch(`${CONTROL}/${action}?mode=${mode}`, { method: 'POST' })
  if (!response.ok) throw new Error(`api ${action}: ${response.status} ${await response.text()}`)
}

/* ------------------------------------------------------------------------------------------------
 * The editor's engine, as far as the specs drive it directly
 * ------------------------------------------------------------------------------------------------ */

export interface EngineApi {
  pages: {
    add(index?: number): string | null
    resize(width: number, height: number, mode: string, options: { scope: 'page' | 'all'; pageId?: string }): void
    remove(id: string): void
    setDuration(id: string, seconds: number | null): void
  }
  style: { setFill(spec: { type: 'solid'; color: string }): void }
  arrange: { nudge(dx: number, dy: number): void }
}

/** A handle on the page's editor engine: `(await engineOf(page)).evaluate((engine, arg) => engine.pages.add(arg), 1)`. */
export async function engineOf(page: Page): Promise<JSHandle<EngineApi>> {
  return page.evaluateHandle(() => (window as unknown as { __doory_collab: { engine: EngineApi } }).__doory_collab.engine)
}

/* ------------------------------------------------------------------------------------------------
 * Randomness
 * ------------------------------------------------------------------------------------------------ */

/** A small seeded generator (xorshift32), so a failing run can be repeated with `CHAOS_SEED`. */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0 || 1
  }

  next(): number {
    let x = this.state
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.state = x
    return x / 0x1_0000_0000
  }

  int(max: number): number {
    return Math.floor(this.next() * max)
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }

  chance(p: number): boolean {
    return this.next() < p
  }
}

export const SEED = Number(process.env.CHAOS_SEED ?? 20260509)

/* ------------------------------------------------------------------------------------------------
 * Random editor actions
 * ------------------------------------------------------------------------------------------------ */

export type ActionKind =
  | 'nudge'
  | 'scale'
  | 'rotate'
  | 'opacity'
  | 'fill'
  | 'delete'
  | 'duplicate'
  | 'shape'
  | 'zorder'
  | 'group'
  | 'ungroup'
  | 'lock'
  | 'undo'
  | 'redo'
  | 'pageAdd'
  | 'pageRemove'
  | 'pageMove'
  | 'background'
  | 'notes'
  | 'shadow'

export interface Action {
  kind: ActionKind
  a: number
  b: number
  c: number
}

export interface ActionResult {
  /** What it did, for the failure message. */
  did: string
  created: string[]
  removed: string[]
}

export const ACTIONS: readonly ActionKind[] = [
  'nudge',
  'nudge',
  'nudge',
  'scale',
  'rotate',
  'opacity',
  'fill',
  'fill',
  'delete',
  'duplicate',
  'shape',
  'shape',
  'zorder',
  'group',
  'ungroup',
  'lock',
  'undo',
  'undo',
  'redo',
  'pageAdd',
  'pageRemove',
  'pageMove',
  'background',
  'notes',
  'shadow',
]

export function randomAction(rng: Rng): Action {
  return { kind: rng.pick(ACTIONS), a: rng.int(1_000_000), b: rng.int(1_000_000), c: rng.int(1_000_000) }
}

/** Runs one action in the page, the way the editor's own commands do it (the same engine calls the toolbar makes). */
export async function act(page: Page, action: Action): Promise<ActionResult> {
  return page.evaluate(async (a) => {
    interface Obj {
      id: string
      type: string
      locked?: boolean
      objects?: unknown[]
    }
    interface Pg {
      id: string
      objects: Obj[]
    }
    interface Engine {
      state: { doc: { pages: Pg[] }; activePageId: string; readOnly: boolean }
      select(ids: string[], pageId?: string): void
      viewOf(pageId: string): unknown
      undo(): Promise<void>
      redo(): Promise<void>
      sealHistory(): void
      arrange: { nudge(dx: number, dy: number): void; delete(): void; duplicate(): Promise<void>; group(): void; ungroup(): void; zOrder(mode: string): void; setAngle(angle: number): void; toggleLock(): void; setSize(w?: number, h?: number, lock?: boolean): void }
      style: { setOpacity(v: number): void; setFill(spec: { type: 'solid'; color: string }): void; setShadow(spec: { color: string; blur: number; offsetX: number; offsetY: number } | null): void }
      insert: { shape(kind: string): Promise<void> }
      pages: { add(index?: number): string | null; remove(id: string): void; move(id: string, to: number): void; setBackground(id: string, bg: { type: 'solid'; color: string }): void; setNotes(id: string, text: string): void; activate(id: string, scroll?: boolean): void }
    }
    const e = (window as unknown as { __doory_collab: { engine: Engine } }).__doory_collab.engine
    const pagesNow = (): Pg[] => e.state.doc.pages
    const ids = (): string[] => pagesNow().flatMap((p) => p.objects.map((o) => o.id))
    const before = new Set(ids())
    const live = (): Pg[] => pagesNow().filter((p) => e.viewOf(p.id) !== undefined)
    const withObjects = (): Pg[] => live().filter((p) => p.objects.length > 0)
    const target = (): { p: Pg; o: Obj } | null => {
      const pages = withObjects()
      if (pages.length === 0 || e.state.readOnly) return null
      const p = pages[a.a % pages.length]
      return { p, o: p.objects[a.b % p.objects.length] }
    }
    let did: string = a.kind
    const colors = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#1c1517']
    if (!e.state.readOnly) {
      switch (a.kind) {
        case 'nudge': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.arrange.nudge((a.c % 61) - 30, ((a.c >> 6) % 61) - 30)
          break
        }
        case 'scale': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.arrange.setSize(20 + (a.c % 300), 20 + ((a.c >> 9) % 300))
          break
        }
        case 'rotate': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.arrange.setAngle(a.c % 360)
          break
        }
        case 'opacity': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.style.setOpacity(((a.c % 91) + 10) / 100)
          break
        }
        case 'fill': {
          const t = target()
          if (!t || t.o.type === 'group') break
          e.select([t.o.id], t.p.id)
          e.style.setFill({ type: 'solid', color: colors[a.c % colors.length] })
          break
        }
        case 'shadow': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.style.setShadow(a.c % 5 === 0 ? null : { color: '#000000', blur: a.c % 30, offsetX: a.c % 10, offsetY: (a.c >> 4) % 10 })
          break
        }
        case 'delete': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.arrange.delete()
          break
        }
        case 'duplicate': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          await e.arrange.duplicate()
          break
        }
        case 'shape': {
          const pages = live()
          if (pages.length === 0) break
          e.pages.activate(pages[a.a % pages.length].id, false)
          await e.insert.shape((['rect', 'ellipse', 'triangle', 'star'] as const)[a.c % 4])
          break
        }
        case 'zorder': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.arrange.zOrder((['front', 'back', 'forward', 'backward'] as const)[a.c % 4])
          break
        }
        case 'group': {
          const pages = withObjects().filter((p) => p.objects.length >= 2)
          if (pages.length === 0) break
          const p = pages[a.a % pages.length]
          const first = a.b % p.objects.length
          const second = (first + 1 + (a.c % (p.objects.length - 1))) % p.objects.length
          e.select([p.objects[first].id, p.objects[second].id], p.id)
          e.arrange.group()
          break
        }
        case 'ungroup': {
          const groups = withObjects().flatMap((p) => p.objects.filter((o) => o.type === 'group').map((o) => ({ p, o })))
          if (groups.length === 0) break
          const g = groups[a.a % groups.length]
          e.select([g.o.id], g.p.id)
          e.arrange.ungroup()
          break
        }
        case 'lock': {
          const t = target()
          if (!t) break
          e.select([t.o.id], t.p.id)
          e.arrange.toggleLock()
          break
        }
        case 'undo':
          e.sealHistory()
          await e.undo()
          break
        case 'redo':
          await e.redo()
          break
        case 'pageAdd':
          if (pagesNow().length < 6) e.pages.add(a.a % (pagesNow().length + 1))
          break
        case 'pageRemove':
          if (pagesNow().length > 1) e.pages.remove(pagesNow()[a.a % pagesNow().length].id)
          break
        case 'pageMove':
          if (pagesNow().length > 1) e.pages.move(pagesNow()[a.a % pagesNow().length].id, a.b % pagesNow().length)
          break
        case 'background':
          e.pages.setBackground(pagesNow()[a.a % pagesNow().length].id, { type: 'solid', color: colors[a.c % colors.length] })
          break
        case 'notes':
          e.pages.setNotes(pagesNow()[a.a % pagesNow().length].id, `Notes ${a.c % 1000}`)
          break
      }
    } else did = `${a.kind} (read-only)`
    const after = ids()
    const now = new Set(after)
    return { did, created: after.filter((id) => !before.has(id)), removed: [...before].filter((id) => !now.has(id)) }
  }, action)
}

/* ------------------------------------------------------------------------------------------------
 * A browser's connection to the room
 * ------------------------------------------------------------------------------------------------ */

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What stands between one browser page and the room: it can be cut (the socket closes, new ones are refused and the browser
 * goes offline), made slow (every frame takes `lag` ms, in order) or have its current socket killed so that it has to reconnect.
 */
export class Wire {
  lag = 0
  /** Frames in both directions vanish without a sound, and the socket stays open: a phone that lost its network without saying goodbye. */
  blackhole = false
  attempts = 0
  /** How the server (or this page) ended each connection: 'server 4400 bad_frame', 'page 1000 bye'. */
  readonly closes: string[] = []
  private cut = false
  private readonly open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>()

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws\/designs\//, (ws) => {
      this.attempts += 1
      if (this.cut) {
        ws.close({ code: 1012, reason: 'server_restart' })
        return
      }
      const server = ws.connectToServer()
      const pair = { page: ws, server }
      this.open.add(pair)
      let toServer = Promise.resolve()
      let toPage = Promise.resolve()
      ws.onMessage((message) => {
        if (this.blackhole) return
        const wait = this.lag
        toServer = toServer.then(async () => {
          if (wait > 0) await pause(wait)
          server.send(message)
        })
      })
      server.onMessage((message) => {
        if (this.blackhole) return
        const wait = this.lag
        toPage = toPage.then(async () => {
          if (wait > 0) await pause(wait)
          ws.send(message)
        })
      })
      ws.onClose((code, reason) => {
        this.open.delete(pair)
        this.closes.push(`page ${code} ${reason ?? ''}`)
        void server.close({ code, reason })
      })
      server.onClose((code, reason) => {
        this.open.delete(pair)
        this.closes.push(`server ${code} ${reason ?? ''}`)
        void ws.close({ code, reason })
      })
    })
  }

  /** The socket breaks (the browser reconnects by itself). */
  drop(code = 1006, reason = ''): void {
    for (const { page } of [...this.open]) void page.close({ code, reason })
  }

  /** No room connection works until `up`. */
  async down(page: Page): Promise<void> {
    this.cut = true
    await page.context().setOffline(true)
    this.drop(1012, 'server_restart')
  }

  async up(page: Page): Promise<void> {
    this.cut = false
    await page.context().setOffline(false)
  }
}

/* ------------------------------------------------------------------------------------------------
 * Comparing designs
 * ------------------------------------------------------------------------------------------------ */

/** The design as JSON with sorted keys, so two designs compare equal whatever order their properties were set in. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : v))
}

/** The ids of everything on the pages, groups included. */
export function allIds(doc: DocLike): string[] {
  const out: string[] = []
  const visit = (list: { id: string; objects?: unknown }[]): void => {
    for (const o of list) {
      out.push(o.id)
      if (Array.isArray(o.objects)) visit(o.objects as { id: string; objects?: unknown }[])
    }
  }
  for (const page of doc.pages) visit(page.objects)
  return out
}

/** Waits until every client holds the same design and returns it. */
export async function converged(clients: Client[], timeout = 30_000): Promise<DocLike> {
  let last: DocLike[] = []
  await expect
    .poll(
      async () => {
        last = await Promise.all(clients.map((c) => document_(c.page)))
        const first = canonical(last[0])
        return last.every((doc) => canonical(doc) === first)
      },
      { timeout, message: 'every browser should end up with the same design' },
    )
    .toBe(true)
  return last[0]
}

/** What the server has stored for the design (after asking the room to save it). */
export async function stored(owner: Client, designId: string): Promise<DocLike> {
  await owner.page.evaluate(() => (window as unknown as { __doory_collab: { engine: { persistence: { saveNow(): Promise<void> } } } }).__doory_collab.engine.persistence.saveNow())
  const design = (await call(owner.context, 'get', `/designs/${designId}/`)) as { document: DocLike }
  return design.document
}

/** Watches a page for uncaught exceptions and REST saves of the document (which must not happen while live). */
export function watch(page: Page, label: string): { errors: string[]; saves: string[] } {
  const seen = { errors: [] as string[], saves: [] as string[] }
  page.on('pageerror', (error) => seen.errors.push(`${label}: ${error.message}`))
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && /\/api\/v1\/(designs|shared)\//.test(request.url()) && request.postData()?.includes('"document"')) seen.saves.push(`${label}: ${request.url()}`)
  })
  return seen
}

/* ------------------------------------------------------------------------------------------------
 * A raw WebSocket client
 * ------------------------------------------------------------------------------------------------ */

export interface RawFrame {
  text?: string
  bytes?: number[]
}

interface RawWindow {
  __raw?: Map<number, { ws: WebSocket; frames: RawFrame[]; closed: { code: number; reason: string } | null; opened: boolean }>
}

let rawIds = 0

/**
 * A WebSocket opened from inside a page (so it carries that page's cookies and `Origin`), driven byte by byte: the
 * spec decides what to send, however wrong, and sees what comes back and how the server closes it.
 */
export class RawSocket {
  private constructor(
    private readonly page: Page,
    private readonly id: number,
  ) {}

  static async open(page: Page, designId: string, options: { waitOpen?: boolean } = {}): Promise<RawSocket> {
    const id = ++rawIds
    await page.evaluate(
      ([key, design]) => {
        const w = window as unknown as RawWindow
        w.__raw ??= new Map()
        const entry = { ws: new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/designs/${design}/`), frames: [] as RawFrame[], closed: null as { code: number; reason: string } | null, opened: false }
        entry.ws.binaryType = 'arraybuffer'
        entry.ws.onopen = () => {
          entry.opened = true
        }
        entry.ws.onmessage = (event) => {
          entry.frames.push(typeof event.data === 'string' ? { text: event.data } : { bytes: Array.from(new Uint8Array(event.data as ArrayBuffer)) })
        }
        entry.ws.onclose = (event) => {
          entry.closed = { code: event.code, reason: event.reason }
        }
        w.__raw.set(key as number, entry)
      },
      [id, designId] as const,
    )
    const socket = new RawSocket(page, id)
    if (options.waitOpen !== false) await socket.opened()
    return socket
  }

  async opened(): Promise<void> {
    await this.page.waitForFunction((key) => (window as unknown as RawWindow).__raw!.get(key)!.opened || (window as unknown as RawWindow).__raw!.get(key)!.closed !== null, this.id)
  }

  async send(data: string | Uint8Array): Promise<void> {
    await this.page.evaluate(
      ([key, payload, binary]) => {
        const entry = (window as unknown as RawWindow).__raw!.get(key as number)!
        entry.ws.send(binary ? Uint8Array.from(atob(payload as string), (c) => c.charCodeAt(0)) : (payload as string))
      },
      [this.id, typeof data === 'string' ? data : Buffer.from(data).toString('base64'), typeof data !== 'string'] as const,
    )
  }

  /** Sends one binary frame `count` times in one go from inside the page (a flood). */
  async flood(frameBytes: Uint8Array, count: number): Promise<void> {
    await this.page.evaluate(
      ([key, payload, times]) => {
        const entry = (window as unknown as RawWindow).__raw!.get(key as number)!
        const bytes = Uint8Array.from(atob(payload as string), (c) => c.charCodeAt(0))
        for (let i = 0; i < (times as number); i++) if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(bytes)
      },
      [this.id, Buffer.from(frameBytes).toString('base64'), count] as const,
    )
  }

  async frames(): Promise<RawFrame[]> {
    return this.page.evaluate((key) => [...(window as unknown as RawWindow).__raw!.get(key)!.frames], this.id)
  }

  async texts(): Promise<Record<string, unknown>[]> {
    return (await this.frames()).filter((f) => f.text !== undefined).map((f) => JSON.parse(f.text as string) as Record<string, unknown>)
  }

  /** Waits for the server's `ready` frame (the login worked). */
  async ready(timeout = 15_000): Promise<Record<string, unknown>> {
    let found: Record<string, unknown> | undefined
    await expect
      .poll(async () => (found = (await this.texts()).find((t) => t.type === 'ready')), { timeout, message: 'the server should say ready' })
      .toBeTruthy()
    return found as Record<string, unknown>
  }

  async closed(timeout = 15_000): Promise<{ code: number; reason: string }> {
    await this.page.waitForFunction((key) => (window as unknown as RawWindow).__raw!.get(key)!.closed !== null, this.id, { timeout })
    return this.page.evaluate((key) => (window as unknown as RawWindow).__raw!.get(key)!.closed as { code: number; reason: string }, this.id)
  }

  async isOpen(): Promise<boolean> {
    return this.page.evaluate((key) => {
      const entry = (window as unknown as RawWindow).__raw!.get(key)!
      return entry.ws.readyState === WebSocket.OPEN
    }, this.id)
  }

  async close(): Promise<void> {
    await this.page.evaluate((key) => (window as unknown as RawWindow).__raw!.get(key)!.ws.close(), this.id)
  }
}

/* ------------------------------------------------------------------------------------------------
 * Frames of the wire protocol, built (and forged) by hand
 * ------------------------------------------------------------------------------------------------ */

export const frame = {
  /** A sync step 1 frame for a state vector. */
  step1(vector: Uint8Array): Uint8Array {
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep1)
    encoding.writeVarUint8Array(e, vector)
    return encoding.toUint8Array(e)
  },
  /** A sync update frame carrying `update`. */
  update(update: Uint8Array): Uint8Array {
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    syncProtocol.writeUpdate(e, update)
    return encoding.toUint8Array(e)
  },
  /** An awareness frame for one client. */
  awareness(clientId: number, clock: number, state: unknown): Uint8Array {
    const inner = encoding.createEncoder()
    encoding.writeVarUint(inner, 1)
    encoding.writeVarUint(inner, clientId)
    encoding.writeVarUint(inner, clock)
    encoding.writeVarString(inner, JSON.stringify(state))
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 1)
    encoding.writeVarUint8Array(e, encoding.toUint8Array(inner))
    return encoding.toUint8Array(e)
  },
}

/** An update that sets `meta.<key> = value` as a brand-new client (it refers to no history, so a server can apply it directly). */
export function metaUpdate(key: string, value: unknown, clientId = 4_000_000 + Math.floor(Math.random() * 1_000_000)): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = clientId
  doc.getMap('meta').set(key, value)
  return Y.encodeStateAsUpdate(doc)
}

/** An update that writes into a root type the schema does not have. */
export function foreignRootUpdate(): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = 4_100_000 + Math.floor(Math.random() * 100_000)
  doc.getMap('evil').set('a', 1)
  return Y.encodeStateAsUpdate(doc)
}

/** An update whose value is nested `depth` levels deep. */
export function deepUpdate(depth: number): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = 4_200_000 + Math.floor(Math.random() * 100_000)
  let value: unknown = 1
  for (let i = 0; i < depth; i++) value = { n: value }
  doc.getMap('meta').set('deep', value)
  return Y.encodeStateAsUpdate(doc)
}

/** An update that arrives out of order: it refers to a change the server never got. */
export function gapUpdate(): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = 4_300_000 + Math.floor(Math.random() * 100_000)
  doc.getMap('meta').set('first', 1)
  const mark = Y.encodeStateVector(doc)
  doc.getMap('meta').set('second', 2)
  return Y.encodeStateAsUpdate(doc, mark)
}

export const awarenessState = (state: unknown): Uint8Array => {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(state as Record<string, unknown>)
  const body = awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID])
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 1)
  encoding.writeVarUint8Array(e, body)
  awareness.destroy()
  return encoding.toUint8Array(e)
}

/**
 * A WebSocket upgrade request made by hand, so that its `Origin` and cookie can be anything: resolves with the HTTP status of
 * the refusal, or 101 when the server agreed to upgrade.
 */
export async function upgrade(path: string, headers: Record<string, string>): Promise<number> {
  const { request } = await import('node:http')
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port: Number(process.env.E2E_COLLAB_PORT ?? 5380), path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from('doory-chaos-0001').toString('base64'), ...headers } })
    req.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve(101)
    })
    req.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

/** The `Cookie` header of an account's saved session. */
export function cookieHeader(account: { state: { cookies: { name: string; value: string }[] } }): string {
  return account.state.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/**
 * A client that speaks the protocol well enough to know the design (it syncs a copy) and then writes into it whatever it likes:
 * the edits are real Yjs updates that build on the server's history, so the server's scanner lets them through.
 */
export class Forger {
  readonly doc = new Y.Doc()

  private constructor(private readonly socket: RawSocket) {}

  static async join(socket: RawSocket): Promise<Forger> {
    const forger = new Forger(socket)
    await socket.send(frame.step1(Y.encodeStateVector(forger.doc)))
    let update: Uint8Array | null = null
    await expect
      .poll(async () => {
        for (const f of await socket.frames()) {
          if (!f.bytes || f.bytes[0] !== 0 || f.bytes[1] !== 1) continue
          const decoder = decoding.createDecoder(Uint8Array.from(f.bytes))
          decoding.readVarUint(decoder)
          decoding.readVarUint(decoder)
          update = decoding.readVarUint8Array(decoder)
          return true
        }
        return false
      })
      .toBe(true)
    Y.applyUpdate(forger.doc, update as unknown as Uint8Array)
    return forger
  }

  /** Changes the copy and sends the change as one update. */
  async write(change: (doc: Y.Doc) => void): Promise<void> {
    const before = Y.encodeStateVector(this.doc)
    this.doc.transact(() => change(this.doc))
    await this.socket.send(frame.update(Y.encodeStateAsUpdate(this.doc, before)))
  }
}
