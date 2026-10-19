/**
 * The builder the template designs are written with (browser side).
 *
 * Every object is created with the engine's own Fabric classes and factories and written with the engine's own
 * serialiser (`serializeObjects`), so a generated document is exactly what the editor itself would save and it
 * round-trips. Positions are page px; shapes are given by their top-left corner and size, and text boxes grow
 * downwards from their top-left corner (the origin the designs use for text), so a longer text pushes down, not
 * up. Ids are derived from the template slug, so a rebuild gives byte-identical JSON.
 */
import { Ellipse, Group, Path, Point, Polygon, Rect, StaticCanvas, Textbox, type FabricObject } from 'fabric'
import type { DocObject, DocPage, DoryDocument, MaskShape, PageBackground, ShadowSpec } from '@/types/document'
import { applyEffects } from '@/editor/engine/objects/effects'
import { buildFill, type FillSpec } from '@/editor/engine/objects/fills'
import { createImage, createLine, createPlaceholder, createQrCode, createStar } from '@/editor/engine/objects/factories'
import { applySlotClip } from '@/editor/engine/objects/masks'
import { coverSlotTransform, slotOf } from '@/editor/engine/objects/slot'
import { asDory, type DoryProps, type QrSpec } from '@/editor/engine/objects/dory'
import { serializeObjects } from '@/editor/engine/serialization'
import { FONT_PICKS, stackOf, type FontKey } from './fontPalette'
import { ICONS, scalePath, type IconName } from './icons'

/* ------------------------------------------------------------------------------------------------
 * Colours
 * ---------------------------------------------------------------------------------------------- */

function channel(hex: string, from: number): number {
  const v = Number.parseInt(hex.slice(from, from + 2), 16) / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) throw new Error(`Not a solid colour: ${hex}`)
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

/** WCAG contrast ratio of two opaque colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Opaque `fg` painted over `bg` at `alpha`. */
export function mix(fg: string, bg: string, alpha: number): string {
  const part = (from: number): string =>
    Math.round(Number.parseInt(fg.slice(from, from + 2), 16) * alpha + Number.parseInt(bg.slice(from, from + 2), 16) * (1 - alpha))
      .toString(16)
      .padStart(2, '0')
  return `#${part(1)}${part(3)}${part(5)}`
}

/* ------------------------------------------------------------------------------------------------
 * Deterministic ids
 * ---------------------------------------------------------------------------------------------- */

function hash32(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** A version-4 shaped UUID derived from `seed` (stable across runs). */
export function stableId(seed: string): string {
  let state = hash32(seed) || 1
  const bytes: number[] = []
  for (let i = 0; i < 16; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    bytes.push((state >>> 24) & 0xff)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* ------------------------------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------------------------------- */

export interface GradientFill {
  /** Degrees, 0 = left to right, 90 = top to bottom. Ignored for radial gradients. */
  angle?: number
  radial?: boolean
  stops: readonly [number, string][]
}
export type Fill = string | GradientFill

function fillSpec(fill: Fill): FillSpec {
  if (typeof fill === 'string') return { type: 'solid', color: fill }
  return {
    type: 'gradient',
    kind: fill.radial ? 'radial' : 'linear',
    angle: fill.angle ?? 90,
    stops: fill.stops.map(([offset, color]) => ({ offset, color })),
  }
}

/** The colour a gradient is darkest/lightest against text: every stop must work, so callers pass each. */
export function stopsOf(fill: Fill): string[] {
  return typeof fill === 'string' ? [fill] : fill.stops.map(([, color]) => color)
}

interface Common {
  name: string
  locked?: boolean
  opacity?: number
  /** Degrees, about the centre of the box. */
  angle?: number
  shadow?: ShadowSpec
  stroke?: string
  strokeWidth?: number
  dash?: number[]
}

export interface RectOptions extends Common {
  x: number
  y: number
  w: number
  h: number
  fill: Fill
  radius?: number
}

export interface EllipseOptions extends Common {
  x: number
  y: number
  w: number
  h: number
  fill: Fill
}

export interface PathOptions extends Common {
  /** Path data in page coordinates. */
  d: string
  fill?: Fill
  /** Round line caps and joins, for stroked icons and dotted lines. */
  round?: boolean
}

export interface PolygonOptions extends Common {
  points: readonly [number, number][]
  fill: Fill
}

export interface StarOptions extends Common {
  cx: number
  cy: number
  size: number
  points: number
  innerRatio: number
  fill: Fill
}

export interface LineOptions extends Common {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
  round?: boolean
  arrowEnd?: 'triangle' | 'open'
}

export interface PlaceholderOptions {
  name: string
  x: number
  y: number
  w: number
  h: number
  mask?: MaskShape
  /** Corner radius of a `rounded` mask, as a fraction of the shorter side (0-0.5). */
  maskRadius?: number
  angle?: number
}

/** Where the starter photos are published (backend/data/templates/photos, copied to media by `seed_templates`). */
export const PHOTOS_URL = '/media/templates/photos/'

export interface PhotoOptions extends PlaceholderOptions {
  /** File name in backend/data/templates/photos. */
  file: string
  /** Which part of the picture the frame shows, 0-1 across the part that does not fit (0.5 = centred). */
  focusX?: number
  focusY?: number
  /** Zoom beyond "just covers the frame" (1 = covers). */
  zoom?: number
}

export interface TextOptions {
  name: string
  /** Left edge and top of the box. */
  x: number
  y: number
  /** Width of the box. */
  w: number
  text: string
  font: FontKey
  size: number
  bold?: boolean
  italic?: boolean
  color: Fill
  /** Colours the text sits on; AA contrast is checked against every one of them. */
  on: string | readonly string[]
  align?: 'left' | 'center' | 'right'
  /** Line height multiplier. */
  lh?: number
  /** Letter spacing in 1/1000 em. */
  spacing?: number
  /** Shown in capitals; the typed text is kept, so editing stays natural (`textCase`). */
  upper?: boolean
  shadow?: ShadowSpec
  outline?: { color: string; width: number }
  opacity?: number
  angle?: number
  locked?: boolean
  /** Number of lines the text must wrap into with the shipped font (checked while building). */
  lines?: number
  /** Skip the contrast check (decorative glyphs). */
  decorative?: boolean
  /** Words set in italic or bold inside the text (every occurrence), the way a quote stresses a word. */
  emphasis?: readonly { text: string; italic?: boolean; bold?: boolean }[]
}

export interface PlacedText {
  obj: Textbox
  x: number
  y: number
  w: number
  h: number
  bottom: number
  right: number
  lines: number
  /** Width of the widest line (px). */
  widest: number
}

/* ------------------------------------------------------------------------------------------------
 * Page and document builders
 * ---------------------------------------------------------------------------------------------- */

export class PageBuilder {
  readonly objects: FabricObject[] = []
  private counter = 0

  constructor(
    readonly doc: DocBuilder,
    readonly index: number,
    readonly width: number,
    readonly height: number,
    public background: PageBackground,
    readonly name: string,
    public notes?: string,
  ) {}

  private id(): string {
    this.counter += 1
    return stableId(`${this.doc.slug}/${this.index}/${this.counter}`)
  }

  /** Gives `obj` (and, for groups, its children) a stable id and adds it on top of the page. */
  add<T extends FabricObject>(obj: T, props: DoryProps = {}): T {
    this.stamp(obj, props)
    this.objects.push(obj)
    return obj
  }

  private stamp(obj: FabricObject, props: DoryProps = {}): void {
    Object.assign(obj, { id: this.id(), ...props })
    if (obj instanceof Group) for (const child of obj.getObjects()) this.stamp(child, { name: asDory(child).name })
  }

  private style<T extends FabricObject>(obj: T, o: Common): T {
    if (o.stroke) obj.set({ stroke: o.stroke, strokeWidth: o.strokeWidth ?? 1, strokeUniform: true })
    if (o.dash) obj.set({ strokeDashArray: o.dash })
    if (o.opacity !== undefined) obj.set({ opacity: o.opacity })
    if (o.angle) obj.set({ angle: o.angle })
    if (o.shadow) applyEffects(obj, { shadow: o.shadow })
    return obj
  }

  private common(o: Common): DoryProps {
    return { name: o.name, ...(o.locked ? { locked: true } : {}) }
  }

  rect(o: RectOptions): Rect {
    const rect = new Rect({
      left: o.x + o.w / 2,
      top: o.y + o.h / 2,
      originX: 'center',
      originY: 'center',
      width: o.w,
      height: o.h,
      rx: o.radius ?? 0,
      ry: o.radius ?? 0,
      fill: buildFill(fillSpec(o.fill)),
      strokeWidth: 0,
      strokeUniform: true,
    })
    this.style(rect, o)
    return this.add(rect, { ...this.common(o), shapeKind: 'rect' })
  }

  ellipse(o: EllipseOptions): Ellipse {
    const ellipse = new Ellipse({
      left: o.x + o.w / 2,
      top: o.y + o.h / 2,
      originX: 'center',
      originY: 'center',
      rx: o.w / 2,
      ry: o.h / 2,
      width: o.w,
      height: o.h,
      fill: buildFill(fillSpec(o.fill)),
      strokeWidth: 0,
      strokeUniform: true,
    })
    this.style(ellipse, o)
    return this.add(ellipse, { ...this.common(o), shapeKind: 'ellipse' })
  }

  circle(o: Omit<EllipseOptions, 'x' | 'y' | 'w' | 'h'> & { cx: number; cy: number; r: number }): Ellipse {
    return this.ellipse({ ...o, x: o.cx - o.r, y: o.cy - o.r, w: o.r * 2, h: o.r * 2 })
  }

  polygon(o: PolygonOptions): Polygon {
    const xs = o.points.map(([x]) => x)
    const ys = o.points.map(([, y]) => y)
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const polygon = new Polygon(
      o.points.map(([x, y]) => ({ x, y })),
      { fill: buildFill(fillSpec(o.fill)), strokeWidth: 0, strokeUniform: true, strokeLineJoin: 'round' },
    )
    polygon.set({ left: (minX + maxX) / 2, top: (minY + maxY) / 2, originX: 'center', originY: 'center' })
    this.style(polygon, o)
    return this.add(polygon, this.common(o))
  }

  /** A parametric star (editable as a star in the editor). */
  star(o: StarOptions): Polygon {
    const star = createStar({ x: o.cx, y: o.cy }, o.size, o.points, o.innerRatio)
    star.set({ fill: buildFill(fillSpec(o.fill)) })
    this.style(star, o)
    return this.add(star, this.common(o))
  }

  /** An arbitrary path, positioned exactly where its coordinates say. */
  path(o: PathOptions): Path {
    const path = new Path(o.d, {
      fill: o.fill ? buildFill(fillSpec(o.fill)) : null,
      strokeWidth: 0,
      strokeUniform: true,
      objectCaching: false,
    })
    path.set({ left: path.pathOffset.x, top: path.pathOffset.y, originX: 'center', originY: 'center' })
    if (o.round) path.set({ strokeLineCap: 'round', strokeLineJoin: 'round' })
    this.style(path, o)
    return this.add(path, this.common(o))
  }

  /** A QR code (regenerated by the editor from `text`, so no image is stored). */
  async qr(o: { name: string; x: number; y: number; size: number; spec: QrSpec }): Promise<FabricObject> {
    const code = await createQrCode(o.spec, { x: o.x + o.size / 2, y: o.y + o.size / 2 }, o.size)
    return this.add(code, { name: o.name })
  }

  /** One of the line icons in `icons.ts`, `size` px square with its top-left corner at (x, y). */
  icon(o: { name: string; icon: IconName; x: number; y: number; size: number; color: string; width?: number; opacity?: number }): Path {
    const path = new Path(scalePath(ICONS[o.icon], o.size, o.x, o.y), {
      fill: null,
      stroke: o.color,
      strokeWidth: o.width ?? Math.max(1.5, o.size / 12),
      strokeUniform: true,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      objectCaching: false,
    })
    // The data is already in page coordinates; a path is positioned by the centre of its own box.
    path.set({ left: path.pathOffset.x, top: path.pathOffset.y, originX: 'center', originY: 'center' })
    if (o.opacity !== undefined) path.set({ opacity: o.opacity })
    return this.add(path, { name: o.name })
  }

  /** A straight line or dotted/dashed rule between two points. */
  line(o: LineOptions): FabricObject {
    const length = Math.hypot(o.x2 - o.x1, o.y2 - o.y1)
    const line = createLine({ x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 }, { length, color: o.color, width: o.width, dash: o.dash ?? null, arrowEnd: o.arrowEnd ?? 'none' })
    line.set({ angle: (Math.atan2(o.y2 - o.y1, o.x2 - o.x1) * 180) / Math.PI })
    if (o.opacity !== undefined) line.set({ opacity: o.opacity })
    return this.add(line, this.common(o))
  }

  /** An empty photo slot ("click to add a photo"); it never appears in an export. */
  placeholder(o: PlaceholderOptions): FabricObject {
    const frame = createPlaceholder({ x: o.x + o.w / 2, y: o.y + o.h / 2 }, o.w, o.h, o.mask)
    if (o.maskRadius !== undefined) {
      asDory(frame).maskRadius = o.maskRadius
      frame.set({ dirty: true })
    }
    if (o.angle) frame.set({ angle: o.angle })
    asDory(frame).name = o.name
    return this.add(frame, { name: o.name })
  }

  /**
   * A photo in a frame, as if a placeholder had been filled: the picture covers the frame and is clipped to it, and in
   * the editor it can be panned or replaced while the frame stays put.
   */
  async photo(o: PhotoOptions): Promise<FabricObject> {
    const frame = createPlaceholder({ x: o.x + o.w / 2, y: o.y + o.h / 2 }, o.w, o.h, o.mask)
    if (o.maskRadius !== undefined) asDory(frame).maskRadius = o.maskRadius
    if (o.angle) frame.set({ angle: o.angle })
    const slot = slotOf(frame)
    const src = `${PHOTOS_URL}${o.file}`
    const img = await createImage({ src, url: src }, new Point(0, 0), { width: 1, height: 1 })
    const cover = coverSlotTransform(slot, img.width, img.height)
    const scale = cover.scale * (o.zoom ?? 1)
    const spareX = img.width * scale - slot.width
    const spareY = img.height * scale - slot.height
    img.set({ left: slot.cx + (0.5 - (o.focusX ?? 0.5)) * spareX, top: slot.cy + (0.5 - (o.focusY ?? 0.5)) * spareY, scaleX: scale, scaleY: scale, angle: slot.angle })
    Object.assign(img, { slot })
    applySlotClip(img)
    return this.add(img, { name: o.name })
  }

  private makeText(o: TextOptions): { box: Textbox; widest: number } {
    const pick = FONT_PICKS[o.font]
    const weight = o.bold ? 700 : 400
    if (!(pick.weights as readonly number[]).includes(weight)) throw new Error(`${pick.family} has no weight ${weight}`)
    if (o.italic && !('italic' in pick && pick.italic)) throw new Error(`${pick.family} has no italic face in the palette`)
    const shown = o.upper ? o.text.toUpperCase() : o.text
    const box = new Textbox(shown, {
      left: o.x,
      top: o.y,
      originX: 'left',
      originY: 'top',
      width: o.w,
      fontFamily: stackOf(o.font),
      fontSize: o.size,
      fontWeight: weight,
      fontStyle: o.italic ? 'italic' : 'normal',
      fill: typeof o.color === 'string' ? o.color : buildFill(fillSpec(o.color)),
      textAlign: o.align ?? 'left',
      lineHeight: o.lh ?? 1.2,
      charSpacing: o.spacing ?? 0,
      splitByGrapheme: false,
      editable: true,
      strokeUniform: true,
    })
    for (const e of o.emphasis ?? []) {
      if (e.italic && !('italic' in pick && pick.italic)) throw new Error(`${pick.family} has no italic face in the palette`)
      if (e.bold && !(pick.weights as readonly number[]).includes(700)) throw new Error(`${pick.family} has no weight 700`)
      const style = { ...(e.italic ? { fontStyle: 'italic' } : {}), ...(e.bold ? { fontWeight: 700 } : {}) }
      let at = shown.indexOf(e.text)
      if (at < 0) throw new Error(`"${o.name}": "${e.text}" is not in the text`)
      while (at >= 0) {
        box.setSelectionStyles(style, at, at + e.text.length)
        at = shown.indexOf(e.text, at + e.text.length)
      }
    }
    if (o.angle) box.set({ angle: o.angle })
    if (o.opacity !== undefined) box.set({ opacity: o.opacity })
    if (o.shadow || o.outline) applyEffects(box, { ...(o.shadow ? { shadow: o.shadow } : {}), ...(o.outline ? { outline: o.outline } : {}) })
    box.initDimensions()
    const widest = Math.max(...box._textLines.map((_, i) => box.getLineWidth(i)))
    return { box, widest }
  }

  /** Size a text would take, without adding it (to centre several boxes as one unit). */
  measure(o: TextOptions): { widest: number; height: number } {
    const { box, widest } = this.makeText(o)
    return { widest, height: box.height }
  }

  text(o: TextOptions): PlacedText {
    const { box, widest } = this.makeText(o)
    const lines = box._textLines.length
    if (o.lines !== undefined && lines !== o.lines) {
      this.doc.problems.push(`page ${this.index + 1} "${o.name}": expected ${o.lines} line(s) but it wraps into ${lines} (width ${o.w}, size ${o.size}, widest line ${Math.round(widest)})`)
    }
    if (!o.decorative) {
      const large = o.size >= 24 || (o.bold === true && o.size >= 18.66)
      const need = large ? 3 : 4.5
      const stops = stopsOf(o.color)
      for (const under of Array.isArray(o.on) ? o.on : [o.on]) {
        for (const color of stops) {
          const ratio = contrast(color, under)
          if (ratio < need) this.doc.problems.push(`page ${this.index + 1} "${o.name}": contrast ${ratio.toFixed(2)} of ${color} on ${under} is below ${need}`)
        }
      }
    }
    const props: DoryProps = this.common(o)
    if (o.upper) Object.assign(props, { textCase: 'upper', caseSource: o.text })
    this.add(box, props)
    return { obj: box, x: o.x, y: o.y, w: o.w, h: box.height, bottom: o.y + box.height, right: o.x + o.w, lines, widest }
  }

  /** Moves `obj` so it sits directly below `reference` in the stacking order. */
  placeBelow(obj: FabricObject, reference: FabricObject): void {
    this.objects.splice(this.objects.indexOf(obj), 1)
    this.objects.splice(this.objects.indexOf(reference), 0, obj)
  }

  /** Groups objects that were added to the page; the group takes the place of its lowest member. */
  group(name: string, members: readonly FabricObject[], props: DoryProps = {}): Group {
    const positions = members.map((member) => this.objects.indexOf(member))
    if (positions.some((at) => at < 0)) throw new Error(`"${name}": a member was not added to the page first`)
    const lowest = Math.min(...positions)
    const ordered = [...members].sort((a, b) => this.objects.indexOf(a) - this.objects.indexOf(b))
    this.objects.splice(0, this.objects.length, ...this.objects.filter((o) => !members.includes(o)))
    const group = new Group(ordered)
    this.stamp(group, { name, ...props })
    this.objects.splice(lowest, 0, group)
    return group
  }

  serialise(): DocObject[] {
    const canvas = new StaticCanvas(document.createElement('canvas'), { width: this.width, height: this.height, renderOnAddRemove: false })
    canvas.add(...this.objects)
    const out = serializeObjects(canvas)
    canvas.dispose()
    return out
  }
}

export interface DocOptions {
  width: number
  height: number
  unit: 'px' | 'mm' | 'in'
  presetId?: string
}

export class DocBuilder {
  readonly pages: PageBuilder[] = []
  /** Rule violations found while composing (line counts, contrast); `build` throws them all together. */
  readonly problems: string[] = []

  constructor(
    readonly slug: string,
    readonly options: DocOptions,
  ) {}

  page(name: string, background: PageBackground, notes?: string): PageBuilder {
    const page = new PageBuilder(this, this.pages.length, this.options.width, this.options.height, background, name, notes)
    this.pages.push(page)
    return page
  }

  build(): DoryDocument {
    if (this.problems.length > 0) throw new Error(`${this.slug}:\n  ${this.problems.join('\n  ')}`)
    const pages: DocPage[] = this.pages.map((page) => {
      const out: DocPage = {
        id: stableId(`${this.slug}/page/${page.index}`),
        name: page.name,
        background: page.background,
        objects: page.serialise(),
      }
      if (page.notes) out.notes = page.notes
      return out
    })
    const doc: DoryDocument = { schemaVersion: 1, width: this.options.width, height: this.options.height, unit: this.options.unit, pages }
    if (this.options.presetId) doc.meta = { presetId: this.options.presetId }
    return doc
  }
}

/* ------------------------------------------------------------------------------------------------
 * Geometry helpers for path data
 * ---------------------------------------------------------------------------------------------- */

const r2 = (n: number): number => Math.round(n * 100) / 100

/** A circle as path data (two arcs). */
export function circlePath(cx: number, cy: number, r: number): string {
  return `M ${r2(cx - r)} ${r2(cy)} A ${r2(r)} ${r2(r)} 0 1 0 ${r2(cx + r)} ${r2(cy)} A ${r2(r)} ${r2(r)} 0 1 0 ${r2(cx - r)} ${r2(cy)} Z`
}

/** A ring (annulus) as one evenodd-free path: the inner circle runs the other way. */
export function ringPath(cx: number, cy: number, outer: number, inner: number): string {
  return `${circlePath(cx, cy, outer)} M ${r2(cx - inner)} ${r2(cy)} A ${r2(inner)} ${r2(inner)} 0 1 1 ${r2(cx + inner)} ${r2(cy)} A ${r2(inner)} ${r2(inner)} 0 1 1 ${r2(cx - inner)} ${r2(cy)} Z`
}

export function rectPath(x: number, y: number, w: number, h: number): string {
  return `M ${r2(x)} ${r2(y)} H ${r2(x + w)} V ${r2(y + h)} H ${r2(x)} Z`
}

/** Pie slice / wedge from angle a0 to a1 (degrees, 0 = right, clockwise). */
export function wedgePath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number): string => `${r2(cx + r * Math.cos((a * Math.PI) / 180))} ${r2(cy + r * Math.sin((a * Math.PI) / 180))}`
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  return `M ${r2(cx)} ${r2(cy)} L ${p(a0)} A ${r2(r)} ${r2(r)} 0 ${large} 1 ${p(a1)} Z`
}
