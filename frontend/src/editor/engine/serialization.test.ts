import { Canvas, FabricImage, Group, IText, StaticCanvas } from 'fabric'
import { installImageStub } from '../test/imageStub'
import { createBlankDocument } from '@/lib/document'
import type { DocObject, DocPage } from '@/types/document'
import { applyCurve } from './objects/curvedText'
import { applyEffects } from './objects/effects'
import {
  createEllipse,
  createIText,
  createLine,
  createPathShape,
  createPlaceholder,
  createPolygon,
  createQrCode,
  createRect,
  createStar,
  createTextbox,
  createTriangle,
} from './objects/factories'
import { asDory } from './objects/dory'
import { applyMask } from './objects/masks'
import { kindOfDoc, kindOfLive, objectKinds, registerObjectKind } from './objects/kinds'
import { EXTRA_PROPS, type LoadContext, deserializeObjects, getExtraProps, serializeObjects, serializePage, shareObjects } from './serialization'

const ctx: LoadContext = { resolveSrc: async (s) => s, ensureFonts: async () => undefined }
const page = { width: 800, height: 600 }
const at = { x: 400, y: 300 }

function newCanvas(): StaticCanvas {
  return new StaticCanvas(document.createElement('canvas'), { width: 800, height: 600, renderOnAddRemove: false })
}

async function roundTrip(objects: DocObject[]): Promise<DocObject[]> {
  const c = newCanvas()
  c.add(...(await deserializeObjects(objects, ctx)))
  const out = serializeObjects(c)
  c.dispose()
  return out
}

describe('serialization', () => {
  let restoreImages: () => void
  beforeAll(() => {
    restoreImages = installImageStub()
  })
  afterAll(() => restoreImages())

  it('serialises ids, lower-case types and Doory props via EXTRA_PROPS', () => {
    const c = newCanvas()
    const t = createTextbox(page, at, { text: 'Hi' })
    Object.assign(t, { name: 'Title', locked: true })
    c.add(t)
    const [o] = serializeObjects(c)
    expect(o.type).toBe('textbox')
    expect(o.id).toBe(asDory(t).id)
    expect(o.name).toBe('Title')
    expect(o.locked).toBe(true)
    expect(o.text).toBe('Hi')
    expect('version' in o).toBe(false)
    expect(EXTRA_PROPS).toContain('curveAmount')
  })

  it('round-trips every built-in shape kind identically (idempotent)', async () => {
    const c = newCanvas()
    c.add(
      createRect(at, 120, 12),
      createEllipse(at, 90),
      createTriangle(at, 80),
      createPolygon(at, 100, 6),
      createStar(at, 100, 7, 0.4),
      createPathShape('heart', at, 120) as NonNullable<ReturnType<typeof createPathShape>>,
      createLine(at, { length: 200, arrowEnd: 'triangle', arrowStart: 'circle', width: 8 }),
      createTextbox(page, at, { text: 'Hello world', preset: 'heading' }),
    )
    const first = serializeObjects(c)
    const second = await roundTrip(first)
    expect(second).toEqual(first)
    expect(first.map((o) => o.type)).toEqual(['rect', 'ellipse', 'triangle', 'polygon', 'polygon', 'path', 'doryline', 'textbox'])
    c.dispose()
  })

  it('keeps template field tags on text, shapes and placeholders', async () => {
    const c = newCanvas()
    const text = createTextbox(page, at, { text: 'Hi' })
    const rect = createRect(at, 100, 0)
    const slot = createPlaceholder(at, 200, 150)
    asDory(text).field = { key: 'headline', type: 'text', label: 'Headline' }
    asDory(rect).field = { key: 'accent', type: 'color' }
    asDory(slot).field = { key: 'photo', type: 'image' }
    c.add(text, rect, slot)
    const out = await roundTrip(serializeObjects(c))
    expect(out.map((o) => o.field)).toEqual([
      { key: 'headline', type: 'text', label: 'Headline' },
      { key: 'accent', type: 'color' },
      { key: 'photo', type: 'image' },
    ])
    c.dispose()
  })

  it('keeps shape descriptors (polygon sides, star points, line arrows)', async () => {
    const c = newCanvas()
    c.add(createPolygon(at, 100, 8), createLine(at, { length: 100, arrowEnd: 'open' }))
    const out = await roundTrip(serializeObjects(c))
    expect(out[0].shapeKind).toBe('polygon')
    expect(out[0].sides).toBe(8)
    expect(out[1].arrowEnd).toBe('open')
    c.dispose()
  })

  it('round-trips effects and re-applies native shadow/outline', async () => {
    const t = createTextbox(page, at, { text: 'FX' })
    applyEffects(t, { shadow: { color: '#000000aa', blur: 6, offsetX: 2, offsetY: 3 }, outline: { color: '#ff0000', width: 3 } })
    const c = newCanvas()
    c.add(t)
    const first = serializeObjects(c)
    expect(first[0].stroke).toBe('#ff0000')
    const back = await deserializeObjects(first, ctx)
    expect(asDory(back[0]).effects?.outline?.width).toBe(3)
    expect(back[0].shadow).not.toBeNull()
    c.dispose()
  })

  it('curved text keeps curveAmount but not the derived path', async () => {
    const t = createIText('Curved', at, { fontSize: 40, fontFamily: 'Arial' })
    applyCurve(t, 180)
    const c = newCanvas()
    c.add(t)
    const [o] = serializeObjects(c)
    expect(o.curveAmount).toBe(180)
    expect(o.path).toBeUndefined()
    const [back] = await deserializeObjects([o], ctx)
    expect((back as IText).path).toBeDefined()
    expect(asDory(back).curveAmount).toBe(180)
    c.dispose()
  })

  it('shrink-to-fit text steps live fontSize down, keeps fixed height and serialises user fontSize + fitFontSize', async () => {
    const doc: DocObject = {
      id: 'fit1',
      type: 'textbox',
      text: 'Summer Music Festival Live',
      left: 400,
      top: 300,
      width: 360,
      height: 67.8,
      fontFamily: '"Plus Jakarta Sans", sans-serif',
      fontSize: 60,
      fontWeight: 700,
      lineHeight: 1.16,
      fit: { mode: 'shrink', minFontSize: 24 },
    }
    const [live] = await deserializeObjects([doc], ctx)
    const tb = live as IText
    expect(tb.fontSize).toBeLessThan(60)
    expect(tb.fontSize).toBeGreaterThanOrEqual(24)
    expect(tb.height).toBeCloseTo(67.8, 3)
    expect(tb.width).toBeCloseTo(360, 3)
    const c = newCanvas()
    c.add(tb)
    const [out] = serializeObjects(c)
    expect(out.fontSize).toBe(60)
    expect(out.height).toBeCloseTo(67.8, 3)
    expect(out.fit).toEqual({ mode: 'shrink', minFontSize: 24 })
    expect(out.fitFontSize).toBe(tb.fontSize)
    const [outOfRange] = await deserializeObjects([{ ...doc, id: 'fit-huge', fontSize: 200_000 }], ctx)
    expect(asDory(outOfRange).fit).toBeUndefined()
    c.dispose()
  })

  it('image: stores the logical src, filters as specs and drops derived clipPath', async () => {
    const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    const doc: DocObject = {
      id: 'img1',
      type: 'image',
      src: 'idb://11111111-1111-4111-8111-111111111111',
      width: 10,
      height: 10,
      maskShape: 'circle',
      filters: [{ type: 'brightness', value: 0.2 }],
      assetId: 'asset-1',
    }
    const resolving: LoadContext = { resolveSrc: async () => dataUrl, ensureFonts: async () => undefined }
    const apply = vi.spyOn(FabricImage.prototype, 'applyFilters').mockImplementation(() => undefined)
    const [img] = await deserializeObjects([doc], resolving)
    expect(img).toBeInstanceOf(FabricImage)
    expect(img.clipPath).toBeDefined()
    expect(asDory(img).docSrc).toBe('idb://11111111-1111-4111-8111-111111111111')
    const c = newCanvas()
    c.add(img)
    const [out] = serializeObjects(c)
    expect(out.src).toBe('idb://11111111-1111-4111-8111-111111111111')
    expect(out.filters).toEqual([{ type: 'brightness', value: 0.2 }])
    expect(out.clipPath).toBeUndefined()
    expect(out.maskShape).toBe('circle')
    expect(out.assetId).toBe('asset-1')
    expect(out.docSrc).toBeUndefined()
    expect(apply).toHaveBeenCalled()
    apply.mockRestore()
    c.dispose()
  })

  it('QR codes serialise without a data URL and regenerate on load', async () => {
    const qr = await createQrCode({ text: 'https://example.org', fg: '#000000', bg: '#ffffff' }, at, 160)
    const c = newCanvas()
    c.add(qr)
    const [o] = serializeObjects(c)
    expect(o.qr).toEqual({ text: 'https://example.org', fg: '#000000', bg: '#ffffff' })
    expect(o.src).toBeUndefined()
    const [back] = await deserializeObjects([o], ctx)
    expect(back).toBeInstanceOf(FabricImage)
    expect(kindOfLive(back)).toBe('qr')
    c.dispose()
  })

  it('unreadable objects survive a round trip untouched', async () => {
    const broken: DocObject = { id: 'bad', type: 'someFutureThing', left: 5, top: 6, width: 7, height: 8, custom: { a: 1 } }
    const [stand] = await deserializeObjects([broken], ctx)
    expect(asDory(stand).rawDoc).toEqual(broken)
    const c = newCanvas()
    c.add(stand)
    expect(serializeObjects(c)[0]).toEqual(broken)
    c.dispose()
  })

  it('groups round-trip with children and ids', async () => {
    const a = createRect({ x: 100, y: 100 }, 50)
    const b = createEllipse({ x: 200, y: 100 }, 50)
    const g = new Group([a, b])
    asDory(g).id = 'grp'
    const c = newCanvas()
    c.add(g)
    const first = serializeObjects(c)
    expect(first[0].type).toBe('group')
    expect((first[0].objects as DocObject[]).map((o) => o.type)).toEqual(['rect', 'ellipse'])
    expect(await roundTrip(first)).toEqual(first)
    c.dispose()
  })

  it('placeholders keep isPlaceholder and mask', async () => {
    const ph = createPlaceholder(at, 200, 150, 'rounded')
    applyMask(ph)
    const c = newCanvas()
    c.add(ph)
    const [o] = serializeObjects(c)
    expect(o.isPlaceholder).toBe(true)
    expect(o.maskShape).toBe('rounded')
    c.dispose()
  })

  it('classifies kinds consistently for JSON and live objects', async () => {
    const rect = createRect(at, 40)
    const text = createTextbox(page, at)
    const line = createLine(at, { length: 40 })
    expect(kindOfLive(rect)).toBe('shape')
    expect(kindOfLive(text)).toBe('text')
    expect(kindOfLive(line)).toBe('line')
    expect(kindOfDoc({ id: 'x', type: 'image' })).toBe('image')
    expect(kindOfDoc({ id: 'x', type: 'Image', qr: { text: 'a', fg: '#000', bg: '#fff' } })).toBe('qr')
    expect(kindOfDoc({ id: 'x', type: 'path', elementId: 'e1' })).toBe('element')
    expect(kindOfDoc({ id: 'x', type: 'mystery' })).toBe('object')
  })

  it('third-party kinds take part in prepare/hydrate/dehydrate and extra props', async () => {
    const calls: string[] = []
    const off = registerObjectKind({
      id: 'sticker-test',
      label: 'Sticker',
      priority: 200,
      matches: (o) => o.stickerPack === 'x',
      extraProps: ['stickerPack'],
      prepare: () => void calls.push('prepare'),
      hydrate: () => void calls.push('hydrate'),
      dehydrate: (out) => void (out.dehydrated = true),
    })
    expect(getExtraProps()).toContain('stickerPack')
    const out = await roundTrip([{ id: 's', type: 'rect', width: 5, height: 5, stickerPack: 'x' }])
    expect(calls).toEqual(['prepare', 'hydrate'])
    expect(out[0].dehydrated).toBe(true)
    expect(out[0].stickerPack).toBe('x')
    off()
    expect(objectKinds.has('sticker-test')).toBe(false)
  })

  it('structural sharing reuses unchanged objects', () => {
    const base = [
      { id: 'a', type: 'rect', left: 1 },
      { id: 'b', type: 'rect', left: 2 },
    ] as DocObject[]
    const same = shareObjects(structuredClone(base), base)
    expect(same).toBe(base)
    const changed = shareObjects([{ ...base[0] }, { ...base[1], left: 9 }], base)
    expect(changed[0]).toBe(base[0])
    expect(changed[1]).not.toBe(base[1])
    const reordered = shareObjects([base[1], base[0]], base)
    expect(reordered).not.toBe(base)
    expect(reordered[0]).toBe(base[1])
  })

  it('serializePage returns the same page when nothing changed', async () => {
    const doc = createBlankDocument(800, 600)
    const c = newCanvas()
    c.add(createRect(at, 50))
    const base: DocPage = { ...doc.pages[0], objects: [] }
    const p1 = serializePage(c, base)
    expect(p1.objects).toHaveLength(1)
    const p2 = serializePage(c, p1)
    expect(p2).toBe(p1)
    c.dispose()
  })

  it('interactive canvases serialise active selections with absolute coordinates', async () => {
    const c = new Canvas(document.createElement('canvas'), { width: 800, height: 600, renderOnAddRemove: false })
    const a = createRect({ x: 100, y: 100 }, 50)
    const b = createRect({ x: 300, y: 200 }, 50)
    c.add(a, b)
    const before = serializeObjects(c)
    const { ActiveSelection } = await import('fabric')
    c.setActiveObject(new ActiveSelection([a, b], { canvas: c }))
    const during = serializeObjects(c)
    expect(during.map((o) => [o.left, o.top])).toEqual(before.map((o) => [o.left, o.top]))
    await c.dispose()
  })
})
