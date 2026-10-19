import { DocBuilder } from '../kit'
import type { TemplateDesign } from '../registry'

// After the most downloaded sale post on the big template sites: a shopper in an orange organic shape on the right, a
// script "Super offer" over a heavy three-line headline, a round discount badge, and a dark wave along the bottom with
// the contact line and a yellow "Shop now".
const RED = '#e3262f'
const NAVY = '#0f1729'
const ORANGE = '#ff9a1f'
const YELLOW = '#ffc629'
const WHITE = '#ffffff'

// The wave the dark band starts with (page coordinates).
const WAVE = 'M 0 560 C 200 530 420 556 600 590 C 760 618 920 604 1080 560 L 1080 1080 L 0 1080 Z'
// The organic shape the photo sits in, as a mask in the frame's 100 x 100 box.
const BLOB = { path: 'M 14 0 L 100 0 L 100 88 C 84 98 66 100 50 96 C 30 91 20 78 12 62 C 4 46 0 30 4 16 C 6 8 9 3 14 0 Z' }

export const saleAnnouncement: TemplateDesign = {
  slug: 'bold-sale-announcement',
  title: 'Bold sale announcement',
  category: 'social-media',
  tags: ['sale', 'instagram', 'promo', 'discount', 'shop', 'fashion'],
  description: 'A bold sale post: a shopper in an orange shape, a script "Super offer" over a heavy headline, a discount badge and a dark band with your contact line and a Shop now button.',
  preset: 'instagram-post',
  featured: true,
  async build() {
    const doc = new DocBuilder(this.slug, { width: 1080, height: 1080, unit: 'px', presetId: 'instagram-post' })
    const p = doc.page('Sale', { type: 'solid', color: RED })

    // The orange shape and the shopper in it.
    p.path({ name: 'Orange shape', d: 'M 470 0 L 1080 0 L 1080 720 C 960 760 820 740 700 690 C 560 630 500 520 470 380 C 450 260 440 120 470 0 Z', fill: ORANGE })
    await p.photo({ name: 'Photo', file: 'sale-bags.webp', x: 520, y: 0, w: 560, h: 700, mask: BLOB, focusX: 0.36, focusY: 0.35, zoom: 1.05 })

    // The dark wave.
    p.path({ name: 'Dark band', d: WAVE, fill: NAVY })

    // Logo.
    p.circle({ name: 'Logo mark', cx: 96, cy: 96, r: 34, fill: WHITE })
    p.text({ name: 'Logo initial', x: 62, y: 70, w: 68, text: 'L', font: 'poppins', bold: true, size: 40, color: RED, on: WHITE, align: 'center', lh: 1, lines: 1 })
    p.text({ name: 'Logo name', x: 146, y: 78, w: 300, text: 'Lumen Store', font: 'poppins', bold: true, size: 30, color: WHITE, on: RED, lines: 1 })

    // Headline.
    p.text({ name: 'Script', x: 64, y: 280, w: 460, text: 'Super offer', font: 'greatVibes', size: 84, color: WHITE, on: RED, lh: 1, lines: 1 })
    p.text({ name: 'Headline line 1', x: 60, y: 372, w: 520, text: 'WEEKEND', font: 'poppins', bold: true, size: 100, color: WHITE, on: RED, lh: 1, lines: 1 })
    p.text({ name: 'Headline line 2', x: 60, y: 630, w: 560, text: 'FASHION', font: 'poppins', bold: true, size: 100, color: ORANGE, on: NAVY, lh: 1, lines: 1 })
    p.text({ name: 'Headline line 3', x: 60, y: 734, w: 560, text: 'BIG SALE', font: 'poppins', bold: true, size: 100, color: WHITE, on: NAVY, lh: 1, lines: 1 })

    // Badge.
    p.circle({ name: 'Badge', cx: 800, cy: 740, r: 118, fill: YELLOW })
    p.circle({ name: 'Badge ring', cx: 800, cy: 740, r: 100, fill: '#00000000', stroke: NAVY, strokeWidth: 3, dash: [8, 7] })
    p.text({ name: 'Badge value', x: 690, y: 680, w: 220, text: '30%', font: 'poppins', bold: true, size: 72, color: NAVY, on: YELLOW, align: 'center', lh: 1, lines: 1 })
    p.text({ name: 'Badge label', x: 690, y: 756, w: 220, text: 'OFF', font: 'poppins', bold: true, size: 52, color: NAVY, on: YELLOW, align: 'center', lh: 1, lines: 1 })

    // Contact line and button.
    p.icon({ name: 'Phone icon', icon: 'phone', x: 64, y: 930, size: 52, color: WHITE, width: 2 })
    p.text({ name: 'Website', x: 132, y: 924, w: 520, text: 'lumenstore.example', font: 'poppins', size: 28, color: WHITE, on: NAVY, lines: 1 })
    p.text({ name: 'Phone', x: 132, y: 960, w: 520, text: '+1 555 0148', font: 'poppins', bold: true, size: 40, color: WHITE, on: NAVY, lines: 1 })
    p.rect({ name: 'Button', x: 744, y: 936, w: 272, h: 72, fill: YELLOW, radius: 12 })
    p.text({ name: 'Button label', x: 744, y: 936 + 18, w: 272, text: 'SHOP NOW', font: 'poppins', bold: true, size: 32, color: NAVY, on: YELLOW, align: 'center', lines: 1 })
    return doc
  },
}
