import { DocBuilder } from '../kit'
import type { TemplateDesign } from '../registry'

// After the best-selling thumbnail packs: deep blue to violet with streaks of light, the person on the right, a short
// white line over one huge yellow word and a red pill, all in heavy condensed type with a shadow.
const W = 1280
const H = 720
const BLUE = '#141a6b'
const VIOLET = '#4b1aa8'
const YELLOW = '#ffd60a'
const WHITE = '#ffffff'
const RED = '#e5162b'

export const youtubeThumbnail: TemplateDesign = {
  slug: 'bold-youtube-thumbnail',
  title: 'Bold YouTube thumbnail',
  category: 'youtube',
  tags: ['youtube', 'thumbnail', 'video', 'challenge', 'vlog'],
  description: 'A bold challenge thumbnail: deep blue to violet with streaks of light, a face on the right, a huge yellow "30 days" and a red pill.',
  preset: 'youtube-thumbnail',
  async build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'px', presetId: 'youtube-thumbnail' })
    const p = doc.page('Thumbnail', { type: 'gradient', kind: 'linear', angle: 0, stops: [{ offset: 0, color: BLUE }, { offset: 1, color: VIOLET }] })

    // Streaks of light.
    p.path({ name: 'Streak 1', d: 'M 380 0 L 470 0 L 250 720 L 160 720 Z', fill: '#ffffff14' })
    p.path({ name: 'Streak 2', d: 'M 520 0 L 545 0 L 325 720 L 300 720 Z', fill: '#7fd8ff26' })

    // The face, blending into the blue.
    await p.photo({ name: 'Photo', file: 'youtube-face.webp', x: 640, y: 0, w: 640, h: H, focusX: 0.4, focusY: 0.3, zoom: 1.08 })
    p.rect({ name: 'Blend', x: 640, y: 0, w: 200, h: H, fill: { angle: 0, stops: [[0, '#2a1a86'], [1, '#2a1a8600']] } })

    // The words.
    const shadow = { color: '#0a0d3a', blur: 0, offsetX: 6, offsetY: 6 }
    p.text({ name: 'Kicker', x: 64, y: 96, w: 600, text: 'I tried it for', font: 'anton', size: 84, color: WHITE, on: [BLUE, '#2a1a86'], upper: true, lh: 1, shadow, lines: 1 })
    p.text({ name: 'Big word', x: 56, y: 196, w: 680, text: '30 days', font: 'anton', size: 200, color: YELLOW, on: [BLUE, '#2a1a86'], upper: true, lh: 1, shadow, lines: 1 })
    p.rect({ name: 'Pill', x: 64, y: 470, w: 420, h: 84, fill: RED, radius: 42 })
    p.text({ name: 'Pill label', x: 64, y: 470 + 18, w: 420, text: 'Watch till the end', font: 'anton', size: 42, color: WHITE, on: RED, upper: true, align: 'center', lh: 1.1, lines: 1 })
    return doc
  },
}
