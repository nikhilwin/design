import { DocBuilder } from '../kit'
import type { TemplateDesign } from '../registry'

// After the most-reviewed grand opening template: white paper, a sweeping script "Grand" over a spaced serif "Opening",
// a script "please join us", one line in capitals and the details in three columns split by fine rules, the day as a
// big script numeral in the middle.
const W = 816
const H = 1056
const PAPER = '#ffffff'
const INK = '#1c1a17'
const SOFT = '#55504a'

export const grandOpeningFlyer: TemplateDesign = {
  slug: 'grand-opening-flyer',
  title: 'Grand opening flyer',
  category: 'flyers',
  tags: ['flyer', 'opening', 'invitation', 'cafe', 'boutique', 'shop', 'print', 'minimal', 'elegant'],
  description: 'An elegant grand opening flyer for US Letter: a sweeping script "Grand" over a spaced serif "Opening", and the time, day and place in three columns.',
  preset: 'letter',
  build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'in', presetId: 'letter' })
    const p = doc.page('Flyer', { type: 'solid', color: PAPER })

    p.text({ name: 'Business name', x: 0, y: 112, w: W, text: 'Corner Bloom Café', font: 'crimson', size: 20, color: INK, on: PAPER, align: 'center', upper: true, spacing: 360, lines: 1 })
    p.text({ name: 'Grand', x: 0, y: 170, w: W, text: 'Grand', font: 'pinyon', size: 250, color: INK, on: PAPER, align: 'center', lh: 1, lines: 1 })
    p.text({ name: 'Opening', x: 0, y: 452, w: W, text: 'Opening', font: 'crimson', size: 52, color: INK, on: PAPER, align: 'center', upper: true, spacing: 420, lines: 1 })

    // "please join us" between two fine strokes.
    p.line({ name: 'Stroke left', x1: 252, y1: 572, x2: 320, y2: 572, color: INK, width: 1 })
    p.text({ name: 'Join us', x: 0, y: 540, w: W, text: 'please join us', font: 'greatVibes', size: 44, color: INK, on: PAPER, align: 'center', lines: 1 })
    p.line({ name: 'Stroke right', x1: 496, y1: 572, x2: 564, y2: 572, color: INK, width: 1 })
    p.text({ name: 'Invitation', x: 158, y: 626, w: 500, text: 'For a morning of coffee and pastries celebrating the opening of our new café', font: 'crimson', size: 17, color: SOFT, on: PAPER, align: 'center', upper: true, spacing: 120, lh: 1.5, lines: 2 })

    // Time, day and place.
    p.line({ name: 'Rule left', x1: 300, y1: 776, x2: 300, y2: 920, color: INK, width: 1 })
    p.line({ name: 'Rule right', x1: 516, y1: 776, x2: 516, y2: 920, color: INK, width: 1 })
    p.text({ name: 'Time', x: 96, y: 822, w: 190, text: 'From 8:00\nuntil 14:00', font: 'crimson', size: 17, color: INK, on: PAPER, align: 'right', upper: true, spacing: 100, lh: 1.5, lines: 2 })
    p.text({ name: 'Weekday', x: 300, y: 776, w: 216, text: 'Saturday', font: 'crimson', size: 17, color: INK, on: PAPER, align: 'center', upper: true, spacing: 260, lines: 1 })
    p.text({ name: 'Day', x: 300, y: 790, w: 216, text: '12th', font: 'greatVibes', size: 84, color: INK, on: PAPER, align: 'center', lh: 1.1, lines: 1 })
    p.text({ name: 'Month', x: 300, y: 892, w: 216, text: 'July', font: 'crimson', size: 17, color: INK, on: PAPER, align: 'center', upper: true, spacing: 260, lines: 1 })
    p.text({ name: 'Place', x: 530, y: 822, w: 190, text: '24 Orchard Lane\nRiverside', font: 'crimson', size: 17, color: INK, on: PAPER, align: 'left', upper: true, spacing: 100, lh: 1.5, lines: 2 })

    p.text({ name: 'Website', x: 0, y: 988, w: W, text: 'cornerbloom.example', font: 'crimson', size: 15, color: SOFT, on: PAPER, align: 'center', spacing: 200, upper: true, lines: 1 })
    return doc
  },
}
