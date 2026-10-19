/**
 * The same questions as fuzz.test.ts, asked of whole editors: three real `EditorEngine`s with Fabric canvases and
 * `CollabSession`s around an in-memory server, driven through the engine's own commands (the ones the toolbar, the shortcuts
 * and the layers panel call) at random, some of them at the same moment. When everything has settled, every editor shows the
 * design the server holds, and its canvas shows the design it holds.
 */
import type { FabricObject } from 'fabric'
import type { DoryDocument } from '@/types/document'
import { installImageStub } from '../../test/imageStub'
import { jsonEqual } from '../../engine/json'
import { type Peer, frames, open, owner, seedDocument } from '../engineTesting'
import { FakeCollabServer, settle } from '../fakeServer'
import { readDocument, rootsOf } from '../schema'
import { Random } from '../testing'

const SEEDS = Number(process.env.FUZZ_ENGINE_SEEDS ?? 3)
const FIRST = Number(process.env.FUZZ_ENGINE_FIRST ?? 1)
const STEPS = Number(process.env.FUZZ_ENGINE_STEPS ?? 36)
const TOGETHER = Number(process.env.FUZZ_ENGINE_TOGETHER ?? 3)
/**
 * How slow the machine is, in turns of the event loop that building an object may take at most (a font or an image that is slow
 * to load) and in clocks that run ahead between two commands (so the undo steps of a slow user are cut at other places); 0 is
 * as fast as it goes.
 */
const JITTER = Number(process.env.FUZZ_ENGINE_JITTER ?? 6)
const COLORS = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed']

vi.setConfig({ testTimeout: 300_000 })

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null))

function mountAll(peer: Peer): void {
  for (const page of peer.engine.state.doc.pages) {
    if (peer.engine.viewOf(page.id)) continue
    peer.engine.mountPage(page.id, peer.host)
  }
}

async function ready(peer: Peer): Promise<void> {
  mountAll(peer)
  for (const page of peer.engine.state.doc.pages) {
    const view = await peer.engine.whenView(page.id)
    view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  }
}

/** One command, chosen by the numbers: the objects it works on are the ones the peer's own document has. */
async function command(peer: Peer, r: Random): Promise<string> {
  const e = peer.engine
  const doc = e.state.doc
  const pages = doc.pages.filter((p) => e.viewOf(p.id))
  const withObjects = pages.filter((p) => p.objects.length > 0)
  const target = (): { page: string; id: string } | null => {
    if (withObjects.length === 0) return null
    const page = r.pick(withObjects)
    return { page: page.id, id: r.pick(page.objects).id }
  }
  const kind = r.pick(['nudge', 'nudge', 'size', 'angle', 'opacity', 'fill', 'delete', 'duplicate', 'shape', 'shape', 'zorder', 'group', 'ungroup', 'lock', 'undo', 'undo', 'redo', 'pageAdd', 'pageRemove', 'pageMove', 'background', 'notes', 'shadow'] as const)
  const t = kind === 'shape' || kind === 'undo' || kind === 'redo' || kind.startsWith('page') || kind === 'background' || kind === 'notes' || kind === 'group' || kind === 'ungroup' ? null : target()
  if (t) e.select([t.id], t.page)
  switch (kind) {
    case 'nudge':
      if (t) e.arrange.nudge(r.int(41) - 20, r.int(41) - 20)
      break
    case 'size':
      if (t) e.arrange.setSize(20 + r.int(200), 20 + r.int(200))
      break
    case 'angle':
      if (t) e.arrange.setAngle(r.int(360))
      break
    case 'opacity':
      if (t) e.style.setOpacity((10 + r.int(90)) / 100)
      break
    case 'fill':
      if (t) e.style.setFill({ type: 'solid', color: r.pick(COLORS) })
      break
    case 'shadow':
      if (t) e.style.setShadow(r.int(4) === 0 ? null : { color: '#000000', blur: r.int(30), offsetX: r.int(10), offsetY: r.int(10) })
      break
    case 'delete':
      if (t) e.arrange.delete()
      break
    case 'duplicate':
      if (t) await e.arrange.duplicate()
      break
    case 'zorder':
      if (t) e.arrange.zOrder(r.pick(['front', 'back', 'forward', 'backward'] as const))
      break
    case 'lock':
      if (t) e.arrange.toggleLock()
      break
    case 'shape':
      if (pages.length > 0) {
        e.setActivePage(r.pick(pages).id)
        await e.insert.shape(r.pick(['rect', 'ellipse', 'triangle', 'star'] as const))
      }
      break
    case 'group': {
      const page = withObjects.find((p) => p.objects.length >= 2)
      if (page) {
        e.select(page.objects.slice(0, 2).map((o) => o.id), page.id)
        e.arrange.group()
      }
      break
    }
    case 'ungroup': {
      for (const page of withObjects) {
        const group = page.objects.find((o) => o.type === 'group')
        if (group) {
          e.select([group.id], page.id)
          e.arrange.ungroup()
          break
        }
      }
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
      if (doc.pages.length < 5) {
        e.pages.add(r.int(doc.pages.length + 1))
        await ready(peer)
      }
      break
    case 'pageRemove':
      if (doc.pages.length > 1) e.pages.remove(r.pick(doc.pages).id)
      break
    case 'pageMove':
      if (doc.pages.length > 1) e.pages.move(r.pick(doc.pages).id, r.int(doc.pages.length))
      break
    case 'background':
      e.pages.setBackground(r.pick(doc.pages).id, { type: 'solid', color: r.pick(COLORS) })
      break
    case 'notes':
      e.pages.setNotes(r.pick(doc.pages).id, `Notes ${r.int(1000)}`)
      break
  }
  return kind
}

/** Where two plain values first differ, as a path, so that a failure says what to look at. */
function firstDifference(a: unknown, b: unknown, path = ''): string {
  if (jsonEqual(a, b)) return ''
  if (Array.isArray(a) && Array.isArray(b)) {
    const names = (list: unknown[]): string => list.map((v) => (v as { id?: string })?.id?.slice(0, 8) ?? JSON.stringify(v)?.slice(0, 30)).join(',')
    if (a.length !== b.length) return `${path || 'root'}: ${a.length} entries in the editor [${names(a)}], ${b.length} on the server [${names(b)}]`
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return firstDifference(a[i], b[i], `${path}[${i}]`)
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (!jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`)
  }
  return `${path}: editor ${JSON.stringify(a)?.slice(0, 300)} server ${JSON.stringify(b)?.slice(0, 300)}`
}

/** The ids of the objects a canvas holds, in stacking order. */
const canvasIds = (peer: Peer, pageId: string): string[] =>
  (peer.engine.viewOf(pageId)?.canvas.getObjects() ?? []).filter((o: FabricObject) => !(o as { isUi?: boolean }).isUi).map((o: FabricObject) => (o as { id?: string }).id ?? '')

async function run(seed: number): Promise<void> {
  const r = new Random(seed * 31 + 5)
  const doc: DoryDocument = await seedDocument()
  const server = new FakeCollabServer(doc)
  const peers = [await open(server, owner('u1', 'Ada'), doc), await open(server, owner('u2', 'Bo'), doc), await open(server, owner('u3', 'Cy'), doc)]
  const log: string[] = []
  // Building an object waits for its fonts: here that wait lasts a number of turns that depends on the seed, so the order in which
  // the editors finish their work is another one for every seed (and not a matter of how busy the machine is).
  const slow = new Random(seed * 77 + 3)
  if (JITTER > 0)
    for (const peer of peers) {
      const ensure = peer.engine.fonts.ensure.bind(peer.engine.fonts)
      peer.engine.fonts.ensure = async (fonts) => {
        await settle(slow.int(JITTER + 1))
        await ensure(fonts)
      }
    }
  if (JITTER > 0) vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  try {
    await frames()
    for (let step = 0; step < STEPS; step++) {
      if (JITTER > 0) vi.setSystemTime(Date.now() + slow.int(JITTER * 150))
      // Some commands run at the same moment on different editors, some after the others have caught up.
      const together = 1 + r.int(TOGETHER)
      await Promise.all(
        Array.from({ length: together }, async () => {
          const peer = r.pick(peers)
          log.push(`${peers.indexOf(peer)}:${await command(peer, r)}`)
        }),
      )
      await settle(r.int(3))
      if (r.int(4) === 0) await frames()
    }
    // Editors catch up asynchronously (canvases rebuild objects); give them time, and look again until they agree or time is up.
    const problem = (): string | null => {
      const shared = readDocument(rootsOf(server.doc), null)
      if (!shared) return 'the server holds no design'
      for (const [i, peer] of peers.entries()) {
        const mine = peer.engine.state.doc
        if (!jsonEqual(plain(mine), plain(shared))) return `editor ${i} shows another design than the server (${firstDifference(plain(mine), plain(shared))})`
        for (const page of mine.pages) {
          if (!peer.engine.viewOf(page.id)) continue
          const shown = canvasIds(peer, page.id)
          const wanted = page.objects.map((o) => o.id)
          if (shown.join() !== wanted.join()) return `the canvas of editor ${i} shows [${shown}] where its design has [${wanted}] (${page.id})`
        }
      }
      return null
    }
    let found = problem()
    // A machine that is busy with other work is slow, not wrong: give it up to 20 seconds, and no longer than that.
    for (const until = performance.now() + 20_000; found && performance.now() < until; ) {
      await frames()
      await Promise.all(peers.map(ready))
      found = problem()
    }
    expect(found, `seed ${seed}: ${found}\n${log.join(' ')}`).toBeNull()
  } finally {
    if (JITTER > 0) vi.useRealTimers()
    for (const peer of peers) {
      peer.session.destroy()
      peer.engine.dispose()
    }
    document.body.innerHTML = ''
  }
}

describe('whole editors on both sides of the server, driven at random', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub()
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['thumb'], { type: 'image/webp' })))
  })
  afterEach(() => {
    restore()
    vi.restoreAllMocks()
  })

  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    it(`ends with one design on the server, in every editor and on every canvas (seed ${seed})`, async () => {
      await run(seed)
    })
  }
})
