import { FabricImage, type Group } from 'fabric'
import { createBlankDocument } from '@/lib/document'
import type { SlotSpec } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { installImageStub } from '../test/imageStub'
import { EditorEngine } from './editor'
import { resizeDocument } from './magicResize'
import { renderableObjects } from './render'
import { asDory } from './objects/dory'
import { clampSlotImage, clampSlotTransform, coverSlotTransform, slotCorners, transformSlot, validSlot } from './objects/slot'

const slot = (patch: Partial<SlotSpec> = {}): SlotSpec => ({ cx: 200, cy: 200, width: 100, height: 100, angle: 0, ...patch })
const state = (patch: Partial<Parameters<typeof clampSlotTransform>[1]> = {}) => ({ width: 300, height: 200, angle: 0, scaleX: 1, scaleY: 1, cx: 200, cy: 200, ...patch })

describe('slot geometry', () => {
  it('accepts a well-formed slot from a document and rejects the rest', () => {
    expect(validSlot({ cx: 10, cy: 20, width: 100, height: 50, angle: 15, mask: 'circle', radius: 9, src: 'x' })).toEqual({ cx: 10, cy: 20, width: 100, height: 50, angle: 15, mask: 'circle', radius: 0.5, src: 'x' })
    expect(validSlot({ cx: 0, cy: 0, width: 5, height: 5 })).toEqual({ cx: 0, cy: 0, width: 5, height: 5, angle: 0 })
    expect(validSlot({ cx: Number.NaN, cy: 0, width: 5, height: 5 })).toBeUndefined()
    expect(validSlot({ cx: 0, cy: 0, width: -5, height: 5 })).toBeUndefined()
    expect(validSlot({ cx: '1', cy: 0, width: 5, height: 5 })).toBeUndefined()
    expect(validSlot(null)).toBeUndefined()
    expect(validSlot({ cx: 0, cy: 0, width: 1e9, height: 5 })?.width).toBe(40000)
  })

  it('covers a frame with the smallest scale that spans it on both axes', () => {
    expect(coverSlotTransform(slot(), 300, 200)).toEqual({ scale: 0.5, cx: 200, cy: 200 })
    expect(coverSlotTransform(slot({ width: 150, height: 60 }), 300, 200).scale).toBeCloseTo(0.5)
  })

  it('lifts a too small picture to cover the frame and clamps its centre', () => {
    const next = clampSlotTransform(slot(), state({ scaleX: 0.4, scaleY: 0.4, cx: 50, cy: 50 }))
    expect(next.scale).toBeCloseTo(0.5)
    // 150 x 100 picture: horizontally it may slide 25 px either way, vertically not at all.
    expect(next.cx).toBeCloseTo(175)
    expect(next.cy).toBeCloseTo(200)
  })

  it('leaves a picture that already covers the frame alone', () => {
    const next = clampSlotTransform(slot(), state({ scaleX: 1, scaleY: 1, cx: 210, cy: 190 }))
    expect(next).toEqual({ scale: 1, cx: 210, cy: 190 })
  })

  it('never lets the picture move far enough to reveal an edge', () => {
    const far = clampSlotTransform(slot(), state({ scaleX: 1, scaleY: 1, cx: 900, cy: -500 }))
    // 300 x 200 picture over a 100 x 100 frame: 100 px of travel horizontally, 50 px vertically.
    expect(far.cx).toBeCloseTo(300)
    expect(far.cy).toBeCloseTo(150)
  })

  it('accounts for a tilted frame and a turned picture', () => {
    const corners = slotCorners(slot({ angle: 45 }))
    expect(corners[0].x).toBeCloseTo(200)
    expect(corners[0].y).toBeCloseTo(200 - Math.SQRT2 * 50)
    // A frame tilted 45 deg is 141.4 px across in the picture's own axes.
    const tilted = clampSlotTransform(slot({ angle: 45 }), state({ scaleX: 0.1, scaleY: 0.1 }))
    expect(tilted.scale).toBeCloseTo((Math.SQRT2 * 100) / 200)
    // Turning the picture to the frame's tilt makes the frame square inside it again.
    const aligned = clampSlotTransform(slot({ angle: 45 }), state({ angle: 45, scaleX: 0.1, scaleY: 0.1 }))
    expect(aligned.scale).toBeCloseTo(0.5)
  })

  it('keeps the frame covered when the picture is rotated 90 degrees', () => {
    const next = clampSlotTransform(slot({ width: 200, height: 100 }), state({ angle: 90, scaleX: 0.2, scaleY: 0.2 }))
    // In the picture's frame the slot is 100 wide and 200 tall: the 200 px side needs 200 / 200 of the picture's height.
    expect(next.scale).toBeCloseTo(1)
  })
})

async function setup(width = 559, height = 794) {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(width, height), meta: { id: 'd1', title: 'Test', mode: 'guest' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width, height })
  return { engine, handle, pageId, view }
}

const asset = (engine: EditorEngine) => engine.assets.upload(new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }), 'photo.png')
const objectsOf = (engine: EditorEngine) => engine.state.doc.pages[0].objects

describe('frame transforms', () => {
  it('moves the frame with a translation and leaves its size and tilt', () => {
    expect(transformSlot(slot({ angle: 20, mask: 'circle' }), [1, 0, 0, 1, 30, -10])).toEqual({ cx: 230, cy: 190, width: 100, height: 100, angle: 20, mask: 'circle' })
  })

  it('turns the frame about the origin and adds the turn to its tilt', () => {
    const turned = transformSlot(slot({ cx: 100, cy: 0, width: 80, height: 40 }), [0, 1, -1, 0, 0, 0])
    expect(turned.cx).toBeCloseTo(0)
    expect(turned.cy).toBeCloseTo(100)
    expect(turned.angle).toBeCloseTo(90)
    expect(turned.width).toBeCloseTo(80)
    expect(turned.height).toBeCloseTo(40)
  })

  it('scales the frame with the plane, uniformly or per axis', () => {
    expect(transformSlot(slot({ width: 50, height: 20 }), [2, 0, 0, 2, 0, 0])).toMatchObject({ cx: 400, cy: 400, width: 100, height: 40 })
    expect(transformSlot(slot({ width: 50, height: 20 }), [3, 0, 0, 0.5, 0, 0])).toMatchObject({ width: 150, height: 10 })
  })

  it('keeps a mirrored frame a plain rectangle', () => {
    const mirrored = transformSlot(slot({ cx: 100, width: 80, height: 40 }), [-1, 0, 0, 1, 500, 0])
    expect(mirrored).toMatchObject({ cx: 400, cy: 200, width: 80, height: 40 })
    expect(Math.abs(mirrored.angle)).toBeCloseTo(180)
  })
})

describe('exports', () => {
  it('leave out unfilled placeholders of every shape but keep photos that carry the flag', () => {
    const objects = [
      { id: '1', type: 'rect', isPlaceholder: true },
      { id: '2', type: 'ellipse', isPlaceholder: true },
      { id: '3', type: 'path', isPlaceholder: true },
      { id: '4', type: 'image', isPlaceholder: true },
      { id: '5', type: 'rect' },
    ]
    expect(renderableObjects(objects).map((o) => o.id)).toEqual(['4', '5'])
  })
})

describe('placeholder frames follow their pictures', () => {
  const doc = () => {
    const base = createBlankDocument(400, 400)
    base.pages[0].objects = [
      { id: 'p', type: 'image', src: 'https://example.test/a.jpg', left: 150, top: 150, width: 200, height: 100, scaleX: 1, scaleY: 1, angle: 0, originX: 'center', originY: 'center', slot: { cx: 150, cy: 150, width: 80, height: 60, angle: 10, mask: 'circle' } },
    ]
    return base
  }

  it('scales and moves the frame with the picture when the page is resized to fit', () => {
    const next = resizeDocument(doc(), 800, 400, 'scale').pages[0].objects[0]
    // k = min(2, 1) = 1 and the content is centred in the new, wider page: everything moves 200 px right.
    expect(next.left).toBeCloseTo(350)
    expect(next.slot).toMatchObject({ cx: 350, cy: 150, width: 80, height: 60, angle: 10, mask: 'circle' })
    const bigger = resizeDocument(doc(), 800, 800, 'scale').pages[0].objects[0]
    expect(bigger.slot).toMatchObject({ cx: 300, cy: 300, width: 160, height: 120 })
    expect(bigger.scaleX).toBeCloseTo(2)
  })

  it('keeps the frame on the picture when the page is resized proportionally', () => {
    const next = resizeDocument(doc(), 800, 400, 'magic').pages[0].objects[0]
    const slot = next.slot as SlotSpec
    expect(slot.cx - (next.left as number)).toBeCloseTo(0)
    expect(slot.width).toBeCloseTo(80)
  })

  it('leaves the frame alone when only the size changes', () => {
    expect(resizeDocument(doc(), 800, 400, 'keep').pages[0].objects[0].slot).toMatchObject({ cx: 150, cy: 150 })
  })
})

describe('filling a placeholder', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub({ width: 600, height: 300 })
    vi.spyOn(FabricImage.prototype, '_render').mockImplementation(() => undefined)
    URL.createObjectURL = vi.fn(() => 'blob:fake')
  })
  afterEach(async () => {
    // Let queued repaints finish while the image render stub is still in place.
    await new Promise((r) => setTimeout(r, 40))
    vi.restoreAllMocks()
    restore()
    document.body.innerHTML = ''
  })

  it('replaces the frame with a picture that covers it and remembers the frame', async () => {
    const { engine, pageId, view } = await setup()
    await engine.insert.shape('ellipse')
    engine.style.setPlaceholder(true)
    const id = engine.state.selection.ids[0]
    const frame = view.getById(id)?.getBoundingRect()
    await engine.insert.fillPlaceholderWith(pageId, id, await asset(engine))
    const [img] = objectsOf(engine)
    expect(img.type).toBe('image')
    const spec = img.slot as SlotSpec
    expect(spec.mask).toBe('circle')
    expect(spec.width).toBeCloseTo(frame?.width ?? 0)
    // The picture covers the frame (cover fit of a 600 x 300 picture into an oval of 82 x 82).
    const live = view.getById(String(img.id))
    expect(live?.getScaledHeight()).toBeCloseTo(spec.height, 0)
    expect(live?.clipPath?.absolutePositioned).toBe(true)
    // The clip is derived from the slot: it is not written to the document.
    expect(img.clipPath).toBeUndefined()
    engine.dispose()
  })

  it('keeps the picture covering the frame when it is dragged or zoomed', async () => {
    const { engine, pageId, view } = await setup()
    await engine.insert.shape('rect')
    engine.style.setPlaceholder(true)
    const id = engine.state.selection.ids[0]
    await engine.insert.fillPlaceholderWith(pageId, id, await asset(engine))
    const img = view.getById(String(objectsOf(engine)[0].id)) as FabricImage
    const spec = asDory(img).slot as SlotSpec
    img.set({ left: img.left + 500, top: img.top - 500 })
    clampSlotImage(img)
    const box = img.getBoundingRect()
    expect(box.left).toBeLessThanOrEqual(spec.cx - spec.width / 2 + 0.01)
    expect(box.left + box.width).toBeGreaterThanOrEqual(spec.cx + spec.width / 2 - 0.01)
    expect(box.top).toBeLessThanOrEqual(spec.cy - spec.height / 2 + 0.01)
    img.set({ scaleX: 0.01, scaleY: 0.01 })
    clampSlotImage(img)
    expect(img.getScaledHeight()).toBeGreaterThanOrEqual(spec.height - 0.01)
    engine.dispose()
  })

  it('resets to an empty placeholder in the same place, shape and layer', async () => {
    const { engine, pageId } = await setup()
    await engine.insert.shape('rect')
    await engine.insert.shape('triangle')
    engine.select([objectsOf(engine)[0].id])
    engine.style.setPlaceholder(true)
    const id = engine.state.selection.ids[0]
    const before = engine.activeView()?.getById(id)?.getCenterPoint()
    await engine.insert.fillPlaceholderWith(pageId, id, await asset(engine))
    expect(objectsOf(engine)[0].type).toBe('image')
    engine.style.resetToPlaceholder()
    const [back, other] = objectsOf(engine)
    expect(back.type).toBe('rect')
    expect(back.isPlaceholder).toBe(true)
    expect(other.type).toBe('triangle')
    expect(back.left as number).toBeCloseTo(before?.x ?? 0)
    expect(back.top as number).toBeCloseTo(before?.y ?? 0)
    expect(back.slot).toBeUndefined()
    engine.dispose()
  })

  it('survives a save and reload: the clip is rebuilt from the slot', async () => {
    const { engine, handle, pageId } = await setup()
    await engine.insert.shape('rect')
    engine.style.setPlaceholder(true)
    await engine.insert.fillPlaceholderWith(pageId, engine.state.selection.ids[0], await asset(engine))
    const doc = structuredClone(engine.state.doc)
    engine.dispose()
    const again = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd2', title: 'Again', mode: 'guest' }, ephemeral: true })
    const host = document.createElement('div')
    document.body.appendChild(host)
    again.mountPage(doc.pages[0].id, host)
    const view = await again.whenView(doc.pages[0].id)
    await vi.waitFor(() => expect(view.canvas.getObjects()).toHaveLength(1))
    expect(view.canvas.getObjects()[0].clipPath?.absolutePositioned).toBe(true)
    again.dispose()
  })

  it('moves the frame together with the picture when the picture is duplicated', async () => {
    const { engine, pageId } = await setup()
    await engine.insert.shape('rect')
    engine.style.setPlaceholder(true)
    await engine.insert.fillPlaceholderWith(pageId, engine.state.selection.ids[0], await asset(engine))
    const first = objectsOf(engine)[0].slot as SlotSpec
    await engine.arrange.duplicate()
    const copy = objectsOf(engine)[1].slot as SlotSpec
    expect(copy.cx - first.cx).toBe(20)
    expect(copy.cy - first.cy).toBe(20)
    engine.dispose()
  })

  it('ignores crop and frame changes on a picture that fills a placeholder', async () => {
    const { engine, pageId } = await setup()
    await engine.insert.shape('rect')
    engine.style.setPlaceholder(true)
    await engine.insert.fillPlaceholderWith(pageId, engine.state.selection.ids[0], await asset(engine))
    await engine.crop.start()
    expect(engine.crop.active).toBe(false)
    engine.style.setMask('circle')
    expect(objectsOf(engine)[0].maskShape).toBeUndefined()
    engine.dispose()
  })

  it('mirrors the frame with the page when the page is flipped', async () => {
    const { engine, pageId } = await setup(400, 300)
    await engine.insert.shape('rect')
    engine.arrange.setPosition(40, 60)
    engine.style.setPlaceholder(true)
    await engine.insert.fillPlaceholderWith(pageId, engine.state.selection.ids[0], await asset(engine))
    const before = objectsOf(engine)[0].slot as SlotSpec
    engine.pages.flipCanvas('horizontal')
    const after = objectsOf(engine)[0].slot as SlotSpec
    expect(after.cx).toBeCloseTo(400 - before.cx)
    expect(after.cy).toBeCloseTo(before.cy)
    expect(objectsOf(engine)[0].flipX).toBe(true)
    engine.dispose()
  })

  it('replaces a placeholder, a slot picture or a masked picture in its frame and keeps its field tag', async () => {
    const { commands, isCommandEnabled } = await import('../commands')
    await import('../builtins/commands')
    const { engine } = await setup()
    await engine.insert.placeholder('circle')
    const id = engine.state.selection.ids[0]
    engine.style.setField({ key: 'avatar', type: 'image', label: 'Avatar' })
    const cmd = commands.get('image.replace')
    expect(cmd && isCommandEnabled(cmd, { editor: engine, state: engine.state })).toBe(true)

    const first = await engine.assets.upload(new File([new Uint8Array([1])], 'first.png', { type: 'image/png' }), 'first.png')
    await engine.insert.replaceSelectedImage(first)
    const filled = objectsOf(engine)[0]
    expect(filled.id).toBe(id)
    expect(filled.type).toBe('image')
    expect(filled.field).toEqual({ key: 'avatar', type: 'image', label: 'Avatar' })
    expect((filled.slot as SlotSpec).mask).toBe('circle')

    const second = await engine.assets.upload(new File([new Uint8Array([2])], 'second.png', { type: 'image/png' }), 'second.png')
    await engine.insert.replaceSelectedImage(second)
    const replacedSlot = objectsOf(engine)[0]
    expect(replacedSlot.id).toBe(id)
    expect(replacedSlot.assetId).toBe(second.id)
    expect(replacedSlot.slot).toEqual(filled.slot)
    expect(replacedSlot.field).toEqual({ key: 'avatar', type: 'image', label: 'Avatar' })

    engine.style.resetToPlaceholder()
    const reset = objectsOf(engine)[0]
    expect(reset.id).toBe(id)
    expect(reset.isPlaceholder).toBe(true)
    expect(reset.field).toEqual({ key: 'avatar', type: 'image', label: 'Avatar' })

    await engine.insert.imageFromAsset(first)
    engine.style.setMask('rounded', 0.25)
    engine.style.setField({ key: 'hero', type: 'image' })
    await engine.insert.replaceSelectedImage(second)
    const masked = objectsOf(engine)[1]
    expect(masked.assetId).toBe(second.id)
    expect(masked.maskShape).toBe('rounded')
    expect(masked.maskRadius).toBe(0.25)
    expect(masked.field).toEqual({ key: 'hero', type: 'image' })
    engine.dispose()
  })
})

describe('frames travel with their pictures when a whole selection is transformed', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub({ width: 600, height: 300 })
    vi.spyOn(FabricImage.prototype, '_render').mockImplementation(() => undefined)
    URL.createObjectURL = vi.fn(() => 'blob:fake')
  })
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 40))
    vi.restoreAllMocks()
    restore()
    document.body.innerHTML = ''
  })

  /** A filled placeholder and an ellipse, both selected. */
  async function layout() {
    const ctx = await setup(600, 600)
    const { engine, pageId } = ctx
    await engine.insert.shape('rect')
    engine.arrange.setPosition(100, 100)
    engine.style.setPlaceholder(true)
    await engine.insert.fillPlaceholderWith(pageId, engine.state.selection.ids[0], await asset(engine))
    await engine.insert.shape('ellipse')
    engine.arrange.setPosition(400, 300)
    engine.selectAll()
    const picture = () => objectsOf(engine).find((o) => o.type === 'image')
    const frame = () => (picture()?.slot ?? slot()) as SlotSpec
    /** Where the frame's centre lies relative to the picture's centre. */
    const offset = () => ({ x: frame().cx - Number(picture()?.left), y: frame().cy - Number(picture()?.top) })
    return { ...ctx, picture, frame, offset }
  }

  it('moves the frame by the same amount when the selection is nudged or positioned', async () => {
    const { engine, frame, picture } = await layout()
    const before = frame()
    const left = Number(picture()?.left)
    engine.arrange.nudge(10, 5)
    expect(frame().cx - before.cx).toBeCloseTo(10)
    expect(frame().cy - before.cy).toBeCloseTo(5)
    expect(Number(picture()?.left) - left).toBeCloseTo(10)
    engine.arrange.setPosition(20, 30)
    expect(frame().cx - Number(picture()?.left)).toBeCloseTo(0)
    expect(frame().cy - Number(picture()?.top)).toBeCloseTo(0)
    expect(frame().cx).not.toBeCloseTo(before.cx + 10)
    engine.dispose()
  })

  it('turns the frame with the picture when the selection is rotated', async () => {
    const { engine, frame, offset } = await layout()
    const before = frame()
    engine.arrange.rotateBy(90)
    expect(frame().angle).toBeCloseTo(90)
    expect(frame().width).toBeCloseTo(before.width)
    expect(frame().height).toBeCloseTo(before.height)
    expect(offset().x).toBeCloseTo(0)
    expect(offset().y).toBeCloseTo(0)
    engine.dispose()
  })

  it('scales the frame with the picture when the selection is resized', async () => {
    const { engine, frame, offset } = await layout()
    const before = frame()
    const bounds = engine.state.selection.bounds
    engine.arrange.setSize((bounds?.width ?? 1) / 2, (bounds?.height ?? 1) / 2, true)
    expect(frame().width).toBeCloseTo(before.width / 2)
    expect(frame().height).toBeCloseTo(before.height / 2)
    expect(offset().x).toBeCloseTo(0)
    expect(offset().y).toBeCloseTo(0)
    engine.dispose()
  })

  it('moves the frame when a selection is aligned to the page as one layout', async () => {
    const { engine, frame, offset } = await layout()
    const before = frame()
    engine.arrange.align('left', 'page')
    expect(frame().cx).toBeLessThan(before.cx)
    expect(offset().x).toBeCloseTo(0)
    expect(offset().y).toBeCloseTo(0)
    engine.dispose()
  })

  it('mirrors the frame about the middle of the selection when the selection is flipped', async () => {
    const { engine, view, frame } = await layout()
    const before = frame()
    const bounds = engine.state.selection.bounds
    const middle = (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2
    engine.arrange.flip('horizontal')
    expect((frame().cx + before.cx) / 2).toBeCloseTo(middle, 0)
    expect(frame().cy).toBeCloseTo(before.cy)
    expect(view.canvas.getObjects().find((o) => asDory(o).slot)?.flipX).toBe(true)
    engine.dispose()
  })

  it('still pans a picture inside a fixed frame when it is moved on its own', async () => {
    const { engine, frame, picture } = await layout()
    const before = frame()
    engine.select([String(picture()?.id)])
    engine.arrange.nudge(800, 0)
    expect(frame()).toEqual(before)
    expect(Number(picture()?.left)).toBeLessThan(before.cx + before.width)
    engine.dispose()
  })

  it('follows a pointer drag of the selection while it happens and when it ends', async () => {
    const { engine, view, frame } = await layout()
    const before = frame()
    const active = view.canvas.getActiveObject()
    expect(active).toBeDefined()
    if (!active) return
    view.canvas.fire('before:transform', { transform: { target: active } } as never)
    active.set({ left: active.left + 30, top: active.top + 12 })
    view.canvas.fire('object:moving', { target: active, e: new MouseEvent('mousemove') } as never)
    const live = view.canvas.getObjects().find((o) => asDory(o).slot)
    expect(asDory(live as never).slot?.cx).toBeCloseTo(before.cx + 30)
    expect(asDory(live as never).slot?.cy).toBeCloseTo(before.cy + 12)
    view.canvas.fire('object:modified', { target: active } as never)
    expect(frame().cx).toBeCloseTo(before.cx + 30)
    engine.dispose()
  })

  it('takes the frame along when a group holding the picture is moved', async () => {
    const { engine, view } = await layout()
    engine.arrange.group()
    const group = view.canvas.getActiveObject()
    expect(group?.type).toBe('group')
    const picture = () => {
      const g = objectsOf(engine)[0] as unknown as { objects: { type: string; slot?: SlotSpec }[] }
      return g.objects.find((o) => o.type === 'image')
    }
    const before = picture()?.slot as SlotSpec
    engine.arrange.nudge(10, 0)
    expect((picture()?.slot as SlotSpec).cx - before.cx).toBeCloseTo(10)
    engine.dispose()
  })

  it('keeps the frame and its clip when a group holding the picture is saved and reopened', async () => {
    const { engine, handle, view } = await layout()
    engine.arrange.group()
    engine.arrange.nudge(10, 0)
    const doc = structuredClone(engine.state.doc)
    const moved = view.canvas.getObjects()[0] as unknown as Group
    const expected = asDory(moved.getObjects().find((o) => asDory(o).slot) as never).slot
    engine.dispose()
    const again = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd2', title: 'Again', mode: 'guest' }, ephemeral: true })
    const host = document.createElement('div')
    document.body.appendChild(host)
    again.mountPage(doc.pages[0].id, host)
    const reopened = await again.whenView(doc.pages[0].id)
    await vi.waitFor(() => expect(reopened.canvas.getObjects()).toHaveLength(1))
    const child = (reopened.canvas.getObjects()[0] as Group).getObjects().find((o) => asDory(o).slot)
    expect(asDory(child as never).slot).toEqual(expected)
    expect(child?.clipPath?.absolutePositioned).toBe(true)
    again.dispose()
  })
})
