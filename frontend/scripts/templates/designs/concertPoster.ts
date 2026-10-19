import { DocBuilder } from '../kit'
import type { TemplateDesign } from '../registry'

// After the tour posters people buy most right now: near-black, tiny repeated words in the corners, the act in huge
// heavy type with a warm gradient between two outlined words, the city, venue and dates in condensed capitals on a
// gradient band, and the special guest on a band of its own.
const W = 1728
const H = 2304
const NIGHT = '#151410'
const SMALL = '#cfc7ae'
const INK = '#151410'
const GOLD = ['#ffe27a', '#f4a640'] as const
const BAND = ['#f2a33a', '#e8cf55'] as const
const SKY = ['#9fb4ff', '#d3dcff'] as const

export const concertPoster: TemplateDesign = {
  slug: 'night-bloom-concert-poster',
  title: 'Night Bloom concert poster',
  category: 'posters',
  tags: ['poster', 'concert', 'tour', 'festival', 'music', 'gig', 'event', 'print'],
  description: 'A tour poster for 18 x 24 in print: the act in huge gradient type between two outlined words, the city, venue and date on a warm band, and the special guest below.',
  preset: '',
  featured: true,
  build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'in' })
    const p = doc.page('Poster', { type: 'solid', color: NIGHT })

    // Tiny repeated words in the corners.
    const corner = (name: string, x: number, y: number, text: string, align: 'left' | 'right', lines: number): void => {
      p.text({ name, x, y, w: 420, text, font: 'archivo', bold: true, size: 34, color: SMALL, on: NIGHT, align, upper: true, lh: 1.1, lines })
    }
    corner('Corner top left', 96, 96, 'Night Bloom\nNight Bloom', 'left', 2)
    corner('Corner top right', W - 516, 96, 'Night Bloom\nNight Bloom', 'right', 2)
    corner('Tour left', 96, 210, 'Tour\n2027', 'left', 2)
    corner('Tour right', W - 516, 210, 'Tour\n2027', 'right', 2)
    corner('Live left', 96, 860, 'Live\nLive\nLive\nLive', 'left', 4)
    corner('Live right', W - 516, 860, 'Live\nLive\nLive\nLive', 'right', 4)

    // The act, between two outlined words.
    const outlined = { font: 'archivo' as const, bold: true, size: 130, color: '#00000000', on: NIGHT, align: 'center' as const, upper: true, outline: { color: SKY[0], width: 3 }, decorative: true, lines: 1 }
    p.text({ name: 'Outlined word above', x: 0, y: 330, w: W, text: 'Night Bloom', ...outlined })
    p.text({ name: 'Act', x: 80, y: 530, w: W - 160, text: 'Marlow &\nthe Echoes', font: 'archivo', bold: true, size: 186, color: { angle: 90, stops: [[0, GOLD[0]], [1, GOLD[1]]] }, on: NIGHT, align: 'center', upper: true, lh: 0.95, spacing: -20, lines: 2 })
    p.text({ name: 'Outlined word below', x: 0, y: 960, w: W, text: 'Night Bloom', ...outlined })

    // City, venue and date on the band.
    p.rect({ name: 'Band', x: 120, y: 1190, w: W - 240, h: 640, fill: { angle: 90, stops: [[0, BAND[0]], [1, BAND[1]]] } })
    const band = (name: string, y: number, text: string, size: number): void => {
      p.text({ name, x: 150, y, w: W - 300, text, font: 'oswald', bold: true, size, color: INK, on: [BAND[0], BAND[1]], align: 'center', upper: true, lh: 1, spacing: 40, lines: 1 })
    }
    band('City', 1226, 'Riverside Park', 150)
    band('Venue', 1396, 'The Open Air Stage', 104)
    band('Night', 1524, 'Night 07/18', 150)
    band('Date', 1690, 'Sat 13 June 2027', 112)

    // Special guest.
    p.text({ name: 'Guest intro', x: 0, y: 1872, w: W, text: 'with very special guest', font: 'greatVibes', size: 72, color: SMALL, on: NIGHT, align: 'center', lines: 1 })
    p.rect({ name: 'Guest band', x: 120, y: 1990, w: W - 240, h: 200, fill: { angle: 0, stops: [[0, SKY[0]], [1, SKY[1]]] } })
    p.text({ name: 'Guest', x: 150, y: 2014, w: W - 300, text: 'Paper Tigers', font: 'oswald', bold: true, size: 132, color: INK, on: [SKY[0], SKY[1]], align: 'center', upper: true, lh: 1, spacing: 300, lines: 1 })
    return doc
  },
}
