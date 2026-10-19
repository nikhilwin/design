import { DocBuilder, type PageBuilder } from '../kit'
import type { TemplateDesign } from '../registry'

// After the best-selling "Series A" investor deck: white slides, heavy sans titles, a small grey section label, a light
// grey photo panel on the cover, the problem as three soft cards and the market as nested circles, with one blue accent.
const W = 1920
const H = 1080
const WHITE = '#ffffff'
const INK = '#0b0d12'
const MUTED = '#5e6470'
const SOFT = '#f2f3f5'
const LINE = '#e3e5e9'
const BLUE = '#2f5bff'

function header(p: PageBuilder, section: string, index: string): void {
  p.rect({ name: 'Logo mark', x: 96, y: 72, w: 36, h: 36, fill: INK, radius: 10 })
  p.text({ name: 'Company name', x: 146, y: 74, w: 400, text: 'Fieldnote', font: 'inter', bold: true, size: 26, color: INK, on: WHITE, lines: 1 })
  p.text({ name: 'Section', x: 1424, y: 78, w: 400, text: `${section}  ·  ${index}`, font: 'inter', size: 22, color: MUTED, on: WHITE, align: 'right', lines: 1 })
}

export const pitchDeck: TemplateDesign = {
  slug: 'modern-pitch-deck',
  title: 'Modern pitch deck',
  category: 'presentations',
  tags: ['presentation', 'pitch', 'startup', 'deck', 'business', 'investor', 'series a'],
  description: 'A clean investor deck in white, ink and one blue: a cover with a photo panel, the problem as three cards and the market as nested circles.',
  preset: 'presentation',
  featured: true,
  async build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'px', presetId: 'presentation' })

    // 1. Cover.
    const cover = doc.page('Cover', { type: 'solid', color: WHITE }, 'Say what you do and what you are raising in one sentence.')
    header(cover, 'Investor presentation', '2027')
    cover.text({ name: 'Title', x: 92, y: 330, w: 900, text: 'Series A Pitch Deck', font: 'inter', bold: true, size: 120, color: INK, on: WHITE, lh: 1.02, lines: 2 })
    cover.text({ name: 'Subtitle', x: 96, y: 610, w: 760, text: 'One search for everything your team already wrote down: notes, docs and chats.', font: 'inter', size: 32, color: MUTED, on: WHITE, lh: 1.4, lines: 2 })
    cover.rect({ name: 'Pill 1', x: 96, y: 760, w: 200, h: 60, fill: INK, radius: 30 })
    cover.text({ name: 'Pill 1 label', x: 96, y: 760 + 16, w: 200, text: 'Raising $8M', font: 'inter', bold: true, size: 22, color: WHITE, on: INK, align: 'center', lines: 1 })
    cover.rect({ name: 'Pill 2', x: 312, y: 760, w: 200, h: 60, fill: WHITE, radius: 30, stroke: LINE, strokeWidth: 2 })
    cover.text({ name: 'Pill 2 label', x: 312, y: 760 + 16, w: 200, text: 'March 2027', font: 'inter', bold: true, size: 22, color: INK, on: WHITE, align: 'center', lines: 1 })
    cover.text({ name: 'Presenter', x: 96, y: 960, w: 800, text: 'Jordan Ellis, founder and CEO', font: 'inter', size: 22, color: MUTED, on: WHITE, lines: 1 })
    cover.rect({ name: 'Photo panel', x: 1060, y: 150, w: 764, h: 834, fill: SOFT, radius: 36 })
    await cover.photo({ name: 'Cover photo', file: 'deck-architecture.webp', x: 1060, y: 150, w: 764, h: 834, mask: 'rounded', maskRadius: 0.047, focusX: 0.25, focusY: 0.6 })

    // 2. The problem: three cards.
    const problem = doc.page('The problem', { type: 'solid', color: WHITE }, 'Three problems your customer has today, each in one line.')
    header(problem, 'The problem', '02')
    problem.text({ name: 'Title', x: 92, y: 210, w: 1500, text: 'Answers get lost between tools', font: 'inter', bold: true, size: 84, color: INK, on: WHITE, lines: 1 })
    problem.text({ name: 'Lead', x: 96, y: 330, w: 1200, text: 'Teams write more than ever, and find less of it when they need it.', font: 'inter', size: 30, color: MUTED, on: WHITE, lines: 1 })
    const cards = [
      { n: '01', title: 'Notes are everywhere', text: 'Docs, chat, email, tickets and meeting tools each hold part of the answer.' },
      { n: '02', title: 'Search starts over', text: 'People spend about five hours a week looking for things they have seen before.' },
      { n: '03', title: 'Questions repeat', text: 'One question in three has been answered already. Nobody can find where.' },
    ]
    cards.forEach((c, i) => {
      const x = 96 + i * 584
      const dark = i === 1
      const fill = dark ? INK : SOFT
      problem.rect({ name: `Card ${i + 1}`, x, y: 450, w: 552, h: 470, fill, radius: 28 })
      problem.text({ name: `Card ${i + 1} number`, x: x + 44, y: 494, w: 200, text: c.n, font: 'inter', bold: true, size: 30, color: dark ? '#9aa3b2' : MUTED, on: fill, lines: 1 })
      problem.text({ name: `Card ${i + 1} title`, x: x + 44, y: 700, w: 470, text: c.title, font: 'inter', bold: true, size: 40, color: dark ? WHITE : INK, on: fill, lines: 1 })
      problem.text({ name: `Card ${i + 1} text`, x: x + 44, y: 768, w: 464, text: c.text, font: 'inter', size: 25, color: dark ? '#c9ced8' : MUTED, on: fill, lh: 1.45 })
    })

    // 3. The market: nested circles and the three numbers.
    const market = doc.page('Market opportunity', { type: 'solid', color: WHITE }, 'Size the market from the top down and say where the numbers come from.')
    header(market, 'Market opportunity', '03')
    market.text({ name: 'Title', x: 92, y: 210, w: 1500, text: 'A large market, and a clear first slice', font: 'inter', bold: true, size: 84, color: INK, on: WHITE, lines: 1 })
    market.circle({ name: 'TAM circle', cx: 540, cy: 680, r: 300, fill: SOFT })
    market.circle({ name: 'SAM circle', cx: 540, cy: 760, r: 210, fill: '#e1e7ff' })
    market.circle({ name: 'SOM circle', cx: 540, cy: 850, r: 120, fill: BLUE })
    market.text({ name: 'TAM label', x: 340, y: 430, w: 400, text: 'TAM', font: 'inter', bold: true, size: 28, color: MUTED, on: SOFT, align: 'center', lines: 1 })
    market.text({ name: 'SAM label', x: 340, y: 590, w: 400, text: 'SAM', font: 'inter', bold: true, size: 28, color: '#3a4ba8', on: '#e1e7ff', align: 'center', lines: 1 })
    market.text({ name: 'SOM label', x: 340, y: 830, w: 400, text: 'SOM', font: 'inter', bold: true, size: 32, color: WHITE, on: BLUE, align: 'center', lines: 1 })
    const rows = [
      { value: '$47B', label: 'Total addressable market', text: 'Knowledge-work software spend, worldwide.' },
      { value: '$8.2B', label: 'Serviceable market', text: 'Teams of 20 to 500 people that already pay for a docs tool.' },
      { value: '$410M', label: 'Obtainable in five years', text: 'Five per cent of the serviceable market.' },
    ]
    rows.forEach((r, i) => {
      const y = 420 + i * 190
      market.line({ name: `Rule ${i + 1}`, x1: 1000, y1: y, x2: 1824, y2: y, color: LINE, width: 2 })
      market.text({ name: `Value ${i + 1}`, x: 1000, y: y + 34, w: 330, text: r.value, font: 'inter', bold: true, size: 76, color: i === 2 ? BLUE : INK, on: WHITE, lh: 1, lines: 1 })
      market.text({ name: `Label ${i + 1}`, x: 1340, y: y + 36, w: 484, text: r.label, font: 'inter', bold: true, size: 28, color: INK, on: WHITE, lines: 1 })
      market.text({ name: `Text ${i + 1}`, x: 1340, y: y + 82, w: 484, text: r.text, font: 'inter', size: 22, color: MUTED, on: WHITE, lh: 1.4 })
    })
    market.text({ name: 'Source', x: 96, y: 1000, w: 1400, text: 'Sample figures: replace them with your own and name the source.', font: 'inter', size: 20, color: MUTED, on: WHITE, lines: 1 })
    return doc
  },
}
