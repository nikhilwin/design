/** Drawn ornaments the designs share (the botanical sprig). */
import type { FabricObject } from 'fabric'
import type { PageBuilder } from './kit'
import { leafPath } from './geometry'

/** A horizontal sprig of leaves and berries growing out from its centre, as one locked group. */
export function sprig(p: PageBuilder, o: { name: string; cx: number; cy: number; span: number; leaf: string; berry: string; flip?: boolean }): void {
  const half = o.span / 2
  const dir = o.flip ? -1 : 1
  const stem = `M ${o.cx - half} ${o.cy} Q ${o.cx} ${o.cy + dir * 7} ${o.cx + half} ${o.cy}`
  const members: FabricObject[] = [p.path({ name: 'Stem', d: stem, stroke: o.leaf, strokeWidth: 1.6, round: true })]
  const leaves: string[] = []
  const steps = 5
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.6) / (steps + 0.4)
      const x = o.cx + side * half * t
      const y = o.cy + dir * 7 * 0.5 * (1 - t * t) * 1.0
      const length = 30 - i * 3.2
      const turn = side === 1 ? 0 : 180
      leaves.push(leafPath([x, y], turn + side * dir * -34, length, length * 0.24))
      leaves.push(leafPath([x, y], turn + side * dir * 34, length, length * 0.24))
    }
  }
  members.push(p.path({ name: 'Leaves', d: leaves.join(' '), fill: o.leaf }))
  members.push(p.circle({ name: 'Berry left', cx: o.cx - half - 3, cy: o.cy, r: 3.6, fill: o.berry }))
  members.push(p.circle({ name: 'Berry right', cx: o.cx + half + 3, cy: o.cy, r: 3.6, fill: o.berry }))
  members.push(p.circle({ name: 'Berry centre', cx: o.cx, cy: o.cy + dir * 3.5, r: 4.4, fill: o.berry }))
  p.group(o.name, members, { locked: true })
}
