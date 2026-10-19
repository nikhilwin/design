import { DocBuilder } from '../kit'
import type { IconName } from '../icons'
import type { TemplateDesign } from '../registry'

// After the best-selling "black luxe" cards: a charcoal front with the first name in a huge, faint script behind the
// name in spaced serif capitals; on the back the name again on white, and a charcoal band with the contacts and a QR
// code to book.
const W = 336
const H = 192
const CHARCOAL = '#2e2d2b'
const SCRIPT = '#3d3c39'
const WHITE = '#ffffff'
const PALE = '#e9e6e0'
const GREY = '#b9b5ad'
const INK = '#222120'

export const businessCard: TemplateDesign = {
  slug: 'clean-business-card',
  title: 'Clean business card',
  category: 'business',
  tags: ['business card', 'contact', 'print', 'elegant', 'luxury', 'black', 'qr code'],
  description: 'An elegant two-sided business card: a charcoal front with a faint script name behind your name in spaced capitals, and a back with your contacts and a QR code.',
  preset: 'business-card',
  async build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'px', presetId: 'business-card' })

    // Front.
    const front = doc.page('Front', { type: 'solid', color: CHARCOAL })
    front.text({ name: 'Script name', x: 0, y: 20, w: W, text: 'Jordan', font: 'greatVibes', size: 128, color: SCRIPT, on: CHARCOAL, align: 'center', lh: 1, decorative: true, lines: 1 })
    front.text({ name: 'Name', x: 0, y: 80, w: W, text: 'Jordan Ellis', font: 'crimson', size: 20, color: PALE, on: CHARCOAL, align: 'center', upper: true, spacing: 300, lines: 1 })
    front.text({ name: 'Role', x: 0, y: 110, w: W, text: 'Owner of your studio name', font: 'crimson', size: 8, color: GREY, on: CHARCOAL, align: 'center', upper: true, spacing: 300, lines: 1 })

    // Back.
    const back = doc.page('Back', { type: 'solid', color: WHITE })
    back.text({ name: 'Name', x: 0, y: 30, w: W, text: 'Jordan Ellis', font: 'crimson', size: 18, color: INK, on: WHITE, align: 'center', upper: true, spacing: 300, lines: 1 })
    back.text({ name: 'Role', x: 0, y: 58, w: W, text: 'Owner of your studio name', font: 'crimson', size: 8, color: '#5d5a54', on: WHITE, align: 'center', upper: true, spacing: 300, lines: 1 })
    back.rect({ name: 'Band', x: 0, y: 92, w: W, h: H - 92, fill: CHARCOAL })
    back.text({ name: 'Find us', x: 24, y: 104, w: 190, text: 'Find us online', font: 'crimson', size: 8, color: GREY, on: CHARCOAL, align: 'center', upper: true, spacing: 300, lines: 1 })
    const icons: IconName[] = ['heart', 'globe', 'mail']
    icons.forEach((icon, i) => back.icon({ name: `Social ${i + 1}`, icon, x: 99 + i * 18, y: 118, size: 10, color: PALE, width: 2 }))
    const rows = ['+1 555 0142', 'hello@yourstudio.example', 'yourstudio.example']
    rows.forEach((row, i) => {
      back.text({ name: row, x: 24, y: 138 + i * 14, w: 190, text: row, font: 'inter', size: 8, color: PALE, on: CHARCOAL, align: 'center', lines: 1 })
    })
    await back.qr({ name: 'QR code', x: 240, y: 102, size: 58, spec: { text: 'https://example.com/', fg: INK, bg: WHITE } })
    back.text({ name: 'Scan', x: 214, y: 166, w: 110, text: 'Scan to book', font: 'crimson', size: 8, color: GREY, on: CHARCOAL, align: 'center', upper: true, spacing: 160, lines: 1 })
    return doc
  },
}
