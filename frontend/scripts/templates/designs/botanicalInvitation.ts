import { DocBuilder, type PageBuilder } from '../kit'
import { leafPath } from '../geometry'
import type { TemplateDesign } from '../registry'

// After the best-selling minimalist wedding suites: white card, black ink, a fine line-drawn sprig on top, the names in
// widely spaced serif capitals with a script "and" between fine strokes, the date in a row split by hairlines, the venue
// in script and the address in small capitals.
const W = 480
const H = 672
const PAPER = '#fdfcfa'
const INK = '#1d1d1b'
const SOFT = '#4d4a45'

/** A small upright sprig drawn as outlines only, like a pen sketch. */
function lineSprig(p: PageBuilder, cx: number, top: number, height: number): void {
  const stem = `M ${cx} ${top + height} C ${cx - 3} ${top + height * 0.6} ${cx + 3} ${top + height * 0.3} ${cx} ${top}`
  const leaves: string[] = []
  for (let i = 0; i < 4; i++) {
    const y = top + height * (0.82 - i * 0.2)
    const length = 20 - i * 3.2
    leaves.push(leafPath([cx, y], -125 + i * 4, length, length * 0.3))
    leaves.push(leafPath([cx, y - height * 0.08], -55 - i * 4, length, length * 0.3))
  }
  leaves.push(leafPath([cx, top + 2], -90, 12, 3.6))
  const sprig = [
    p.path({ name: 'Stem', d: stem, stroke: INK, strokeWidth: 1, round: true, fill: '#00000000' }),
    p.path({ name: 'Leaves', d: leaves.join(' '), stroke: INK, strokeWidth: 1, round: true, fill: '#00000000' }),
  ]
  p.group('Sprig', sprig, { locked: true })
}

export const botanicalInvitation: TemplateDesign = {
  slug: 'botanical-celebration-invitation',
  title: 'Botanical celebration invitation',
  category: 'invitations',
  tags: ['wedding', 'invitation', 'botanical', 'elegant', 'minimal', 'black and white'],
  description: 'A minimalist 5 x 7 in wedding invitation: a fine line-drawn sprig, the names in spaced serif capitals with a script "and", and the date in a row split by hairlines.',
  preset: '',
  build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'in' })
    const p = doc.page('Invitation', { type: 'solid', color: PAPER })

    lineSprig(p, W / 2, 54, 64)
    p.text({ name: 'Families', x: 0, y: 140, w: W, text: 'Together with their families', font: 'crimson', size: 10, color: SOFT, on: PAPER, align: 'center', upper: true, spacing: 260, lines: 1 })

    // The names.
    p.text({ name: 'First name', x: 0, y: 172, w: W, text: 'Ava', font: 'playfair', size: 52, color: INK, on: PAPER, align: 'center', upper: true, spacing: 420, lh: 1.1, lines: 1 })
    p.line({ name: 'Stroke left', x1: 150, y1: 262, x2: 212, y2: 262, color: INK, width: 0.8 })
    p.text({ name: 'And', x: 0, y: 238, w: W, text: 'and', font: 'greatVibes', size: 36, color: INK, on: PAPER, align: 'center', lines: 1 })
    p.line({ name: 'Stroke right', x1: 268, y1: 262, x2: 330, y2: 262, color: INK, width: 0.8 })
    p.text({ name: 'Second name', x: 0, y: 290, w: W, text: 'Theodore', font: 'playfair', size: 44, color: INK, on: PAPER, align: 'center', upper: true, spacing: 300, lh: 1.1, lines: 1 })
    p.text({ name: 'Invitation', x: 60, y: 372, w: 360, text: 'Invite you to celebrate\ntheir marriage', font: 'crimson', size: 10.5, color: SOFT, on: PAPER, align: 'center', upper: true, spacing: 240, lh: 1.7, lines: 2 })

    // The date, in a row split by hairlines.
    p.line({ name: 'Date rule top', x1: 72, y1: 428, x2: 408, y2: 428, color: INK, width: 0.8 })
    p.line({ name: 'Date rule bottom', x1: 72, y1: 498, x2: 408, y2: 498, color: INK, width: 0.8 })
    p.line({ name: 'Date divider left', x1: 186, y1: 440, x2: 186, y2: 486, color: INK, width: 0.8 })
    p.line({ name: 'Date divider right', x1: 294, y1: 440, x2: 294, y2: 486, color: INK, width: 0.8 })
    p.text({ name: 'Weekday', x: 72, y: 456, w: 114, text: 'Saturday', font: 'crimson', size: 11, color: INK, on: PAPER, align: 'center', upper: true, spacing: 160, lines: 1 })
    p.text({ name: 'Month', x: 186, y: 434, w: 108, text: 'June', font: 'crimson', size: 10, color: INK, on: PAPER, align: 'center', upper: true, spacing: 200, lines: 1 })
    p.text({ name: 'Day', x: 186, y: 446, w: 108, text: '14', font: 'playfair', size: 34, color: INK, on: PAPER, align: 'center', lh: 1, lines: 1 })
    p.text({ name: 'Year', x: 186, y: 482, w: 108, text: '2027', font: 'crimson', size: 9, color: INK, on: PAPER, align: 'center', spacing: 200, lines: 1 })
    p.text({ name: 'Time', x: 294, y: 456, w: 114, text: 'At 4:30 PM', font: 'crimson', size: 11, color: INK, on: PAPER, align: 'center', upper: true, spacing: 160, lines: 1 })

    // Venue and address.
    p.text({ name: 'Venue', x: 0, y: 520, w: W, text: 'The Orchard House', font: 'greatVibes', size: 30, color: INK, on: PAPER, align: 'center', lines: 1 })
    p.text({ name: 'Address', x: 0, y: 566, w: W, text: '12 Orchard Lane, Willowbrook', font: 'crimson', size: 10, color: SOFT, on: PAPER, align: 'center', upper: true, spacing: 200, lines: 1 })
    p.text({ name: 'Reception', x: 0, y: 610, w: W, text: 'Reception to follow', font: 'crimson', size: 10, color: INK, on: PAPER, align: 'center', upper: true, spacing: 260, lines: 1 })
    return doc
  },
}
