/** Path-data helpers for shapes that are cut off by the page edge (so no object ever leaves its page). */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type Point = readonly [number, number]

const r2 = (n: number): number => Math.round(n * 100) / 100

/** Sutherland-Hodgman clipping of `subject` against a convex clip polygon given clockwise (in page coordinates, y down). */
export function clipToConvex(subject: readonly Point[], clip: readonly Point[]): Point[] {
  let out: Point[] = [...subject]
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]
    const b = clip[(i + 1) % clip.length]
    // For a clockwise polygon in y-down coordinates the inside is to the right of a->b.
    const side = (p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    const cut = (p: Point, q: Point): Point => {
      const sp = side(p)
      const sq = side(q)
      const t = sp / (sp - sq)
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    }
    const input = out
    out = []
    input.forEach((current, k) => {
      const previous = input[(k + input.length - 1) % input.length]
      if (side(current) >= 0) {
        if (side(previous) < 0) out.push(cut(previous, current))
        out.push(current)
      } else if (side(previous) >= 0) {
        out.push(cut(previous, current))
      }
    })
  }
  return out
}

const rectPolygon = (rect: Rect): Point[] => [
  [rect.x, rect.y],
  [rect.x + rect.w, rect.y],
  [rect.x + rect.w, rect.y + rect.h],
  [rect.x, rect.y + rect.h],
]

/** Clips against an axis-aligned rectangle. */
export function clipToRect(points: readonly Point[], rect: Rect): Point[] {
  return clipToConvex(points, rectPolygon(rect))
}

/** Points of an ellipse, clockwise on screen. */
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, steps = 144): Point[] {
  const out: Point[] = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return out
}

/** A rectangle with rounded corners as a clockwise polygon. */
export function roundedRectPolygon(x: number, y: number, w: number, h: number, radius: number, steps = 16): Point[] {
  const r = Math.min(radius, w / 2, h / 2)
  if (r <= 0) return rectPolygon({ x, y, w, h })
  const out: Point[] = []
  const corner = (cx: number, cy: number, from: number): void => {
    for (let i = 0; i <= steps; i++) {
      const a = ((from + (i / steps) * 90) * Math.PI) / 180
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  corner(x + w - r, y + r, -90)
  corner(x + w - r, y + h - r, 0)
  corner(x + r, y + h - r, 90)
  corner(x + r, y + r, 180)
  return out
}

/** An arch: a rectangle under a semicircle as wide as the frame. */
export function archPolygon(x: number, y: number, w: number, h: number, steps = 90): Point[] {
  const r = w / 2
  const out: Point[] = [
    [x + w, y + h],
    [x, y + h],
  ]
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI + (i / steps) * Math.PI
    out.push([x + r + r * Math.cos(a), y + r + r * Math.sin(a)])
  }
  return out
}

export function polygonPath(points: readonly Point[]): string {
  return `${points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${r2(x)} ${r2(y)}`).join(' ')} Z`
}

/** A circle of radius `r`, cut by the page rectangle, as a polygon path (1 degree steps: invisible facets at these sizes). */
export function circleInPage(cx: number, cy: number, r: number, page: Rect): string {
  const points: Point[] = []
  for (let a = 0; a < 360; a += 1) points.push([cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)])
  return polygonPath(clipToRect(points, page))
}

/** A ring (annulus) cut by the page; the hole is drawn the other way so it stays open. */
export function ringInPage(cx: number, cy: number, outer: number, inner: number, page: Rect): string {
  const out: Point[] = []
  const inn: Point[] = []
  for (let a = 0; a < 360; a += 1) {
    const rad = (a * Math.PI) / 180
    out.push([cx + outer * Math.cos(rad), cy + outer * Math.sin(rad)])
    inn.push([cx + inner * Math.cos(rad), cy + inner * Math.sin(rad)])
  }
  const clippedOut = clipToRect(out, page)
  const clippedIn = clipToRect(inn.reverse(), page)
  return clippedIn.length > 2 ? `${polygonPath(clippedOut)} ${polygonPath(clippedIn)}` : polygonPath(clippedOut)
}

/** Rotates `point` about `origin` by `degrees`. */
export function rotate(point: Point, origin: Point, degrees: number): Point {
  const rad = (degrees * Math.PI) / 180
  const dx = point[0] - origin[0]
  const dy = point[1] - origin[1]
  return [origin[0] + dx * Math.cos(rad) - dy * Math.sin(rad), origin[1] + dx * Math.sin(rad) + dy * Math.cos(rad)]
}

/** Points of a rectangle rotated about its centre and cut by the page (diagonal bands that run off the page). */
export function bandInPage(cx: number, cy: number, length: number, thickness: number, degrees: number, page: Rect): string {
  const corners: Point[] = [
    [cx - length / 2, cy - thickness / 2],
    [cx + length / 2, cy - thickness / 2],
    [cx + length / 2, cy + thickness / 2],
    [cx - length / 2, cy + thickness / 2],
  ]
  return polygonPath(clipToRect(corners.map((p) => rotate(p, [cx, cy], degrees)), page))
}

/** Alternate rays from a point (every other `step` degrees), cut by the page: one path with a polygon per ray. */
export function raysInPage(cx: number, cy: number, step: number, page: Rect, offset = 0): string {
  const reach = Math.hypot(page.w, page.h) * 2
  const far = (degrees: number): Point => [cx + reach * Math.cos((degrees * Math.PI) / 180), cy + reach * Math.sin((degrees * Math.PI) / 180)]
  const parts: string[] = []
  for (let a = offset; a < offset + 360; a += step * 2) {
    const wedge = clipToRect([[cx, cy], far(a), far(a + step)], page)
    if (wedge.length > 2) parts.push(polygonPath(wedge))
  }
  return parts.join(' ')
}

/** The part of segment a-b inside `rect` (Liang-Barsky), or null when it misses the page. */
export function clipSegment(a: Point, b: Point, rect: Rect): [Point, Point] | null {
  let t0 = 0
  let t1 = 1
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const checks: [number, number][] = [
    [-dx, a[0] - rect.x],
    [dx, rect.x + rect.w - a[0]],
    [-dy, a[1] - rect.y],
    [dy, rect.y + rect.h - a[1]],
  ]
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null
    } else {
      const t = q / p
      if (p < 0) {
        if (t > t1) return null
        t0 = Math.max(t0, t)
      } else {
        if (t < t0) return null
        t1 = Math.min(t1, t)
      }
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ]
}

/** Several segments as one open path (each clipped to the page). */
export function segmentsPath(segments: readonly [Point, Point][], page: Rect): string {
  const parts: string[] = []
  for (const [a, b] of segments) {
    const clipped = clipSegment(a, b, page)
    if (clipped) parts.push(`M ${r2(clipped[0][0])} ${r2(clipped[0][1])} L ${r2(clipped[1][0])} ${r2(clipped[1][1])}`)
  }
  return parts.join(' ')
}

/** A circle sliced into horizontal bands: `cuts` are the [top, bottom] y ranges that are removed; nothing is kept below `floor`. */
export function slicedDisc(cx: number, cy: number, r: number, cuts: readonly [number, number][], floor: number, page: Rect): string {
  const disc = ellipsePolygon(cx, cy, r, r, 360)
  const bounds = [cy - r, ...cuts.flatMap(([a, b]) => [a, b]), floor]
  const parts: string[] = []
  for (let i = 0; i < bounds.length - 1; i += 2) {
    const slice = clipToRect(disc, { x: page.x, y: bounds[i], w: page.w, h: bounds[i + 1] - bounds[i] })
    if (slice.length > 2) parts.push(polygonPath(slice))
  }
  return parts.join(' ')
}

/** A pointed leaf from `base` towards `degrees`, `length` long and `width` wide at its fullest. */
export function leafPath(base: Point, degrees: number, length: number, width: number): string {
  const at = (x: number, y: number): Point => {
    const [rx, ry] = rotate([x, y], [0, 0], degrees)
    return [base[0] + rx, base[1] + ry]
  }
  const pt = (point: Point): string => `${r2(point[0])} ${r2(point[1])}`
  const tip = at(length, 0)
  const upper = [at(length * 0.28, -width), at(length * 0.78, -width * 0.85)] as const
  const lower = [at(length * 0.78, width * 0.85), at(length * 0.28, width)] as const
  return `M ${pt(at(0, 0))} C ${pt(upper[0])} ${pt(upper[1])} ${pt(tip)} C ${pt(lower[0])} ${pt(lower[1])} ${pt(at(0, 0))} Z`
}

/**
 * Top-left origin for a box of `w` x `h` that is turned by `degrees` about its origin but should end up centred on
 * (cx, cy): text boxes are rotated about their top-left corner, so a tilted label needs this to stay on its backing shape.
 */
export function rotatedOrigin(cx: number, cy: number, w: number, h: number, degrees: number): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180
  return { x: cx - ((w / 2) * Math.cos(rad) - (h / 2) * Math.sin(rad)), y: cy - ((w / 2) * Math.sin(rad) + (h / 2) * Math.cos(rad)) }
}
