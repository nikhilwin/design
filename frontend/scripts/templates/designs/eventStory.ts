import { DocBuilder } from '../kit'
import type { TemplateDesign } from '../registry'

// After the best-loved "daily story" sets: a full-bleed photo, a row of tiny labels at the top, a big lowercase title
// low on the page with the time and a line of text under it, a strip of dates with the day picked out, and a bookmark.
const W = 1080
const H = 1920
const INK = '#141414'
const WHITE = '#ffffff'
const SOFT = '#d9d4cc'

export const eventStory: TemplateDesign = {
  slug: 'rooftop-event-story',
  title: 'Rooftop event story',
  category: 'social-media',
  tags: ['story', 'event', 'instagram', 'party', 'music', 'sunset', 'minimal'],
  description: 'A full-bleed photo story: tiny labels at the top, a big lowercase title with the time and a line of text, a strip of dates with the day picked out.',
  preset: 'instagram-story',
  featured: true,
  async build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'px', presetId: 'instagram-story' })
    const p = doc.page('Story', { type: 'solid', color: INK })

    await p.photo({ name: 'Photo', file: 'rooftop-friends.webp', x: 0, y: 0, w: W, h: H, focusX: 0.45, focusY: 0.5 })
    // Shade at the bottom, so the white type reads on any photo; the labels at the top sit on the bright sky.
    p.rect({ name: 'Bottom shade', x: 0, y: 1060, w: W, h: 860, fill: { angle: 90, stops: [[0, '#14141400'], [0.42, '#141414e6'], [1, INK]] } })

    // Labels.
    const labels = ['Rooftop', 'Live music', 'Friday']
    labels.forEach((label, i) => {
      p.text({ name: `Label ${i + 1}`, x: 72 + i * 312, y: 160, w: 312, text: label, font: 'manrope', bold: true, size: 26, color: INK, on: '#f4f4f2', align: i === 0 ? 'left' : i === 1 ? 'center' : 'right', upper: true, spacing: 140, lines: 1 })
    })

    // Title, time and a line of text.
    p.text({ name: 'Title', x: 68, y: 1430, w: 940, text: 'sunset sessions', font: 'manrope', bold: true, size: 112, color: WHITE, on: INK, lh: 1, lines: 1 })
    p.text({ name: 'Time', x: 72, y: 1560, w: 940, text: '6:30 pm   |   friday', font: 'manrope', size: 36, color: WHITE, on: INK, lines: 1 })
    p.text({ name: 'Text', x: 72, y: 1624, w: 760, text: 'Live music on the terrace from golden hour till late. Bring a friend.', font: 'manrope', size: 30, color: SOFT, on: INK, lh: 1.4, lines: 2 })

    // The week, with the day picked out.
    const days = ['18', '19', '20', '21', '22', '23', '24']
    days.forEach((day, i) => {
      const x = 72 + i * 136
      const picked = day === '21'
      if (picked) p.rect({ name: 'Picked day', x: x - 6, y: 1752, w: 92, h: 64, fill: WHITE, radius: 32 })
      p.text({ name: `Day ${day}`, x: x - 6, y: 1764, w: 92, text: day, font: 'manrope', bold: true, size: 32, color: picked ? INK : WHITE, on: picked ? WHITE : INK, align: 'center', lines: 1 })
    })
    return doc
  },
}
