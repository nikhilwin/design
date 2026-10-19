import { DocBuilder } from '../kit'
import type { TemplateDesign } from '../registry'

// After the best-loved minimalist quote sets: one solid colour, the quote centred in a narrow serif with a word in
// capitals and a word in italics for stress, and a tiny spaced handle at the foot.
const BLACK = '#0e0e0e'
const WHITE = '#f7f5f1'
const GREY = '#a7a39c'

export const quoteCard: TemplateDesign = {
  slug: 'serif-quote-card',
  title: 'Serif quote card',
  category: 'social-media',
  tags: ['quote', 'instagram', 'minimal', 'black', 'typography', 'inspiration'],
  description: 'A minimalist quote post: black, a centred serif quote with one word in capitals and one in italics, and a small handle at the foot.',
  preset: 'instagram-post',
  build() {
    const doc = new DocBuilder(this.slug, { width: 1080, height: 1080, unit: 'px', presetId: 'instagram-post' })
    const p = doc.page('Quote', { type: 'solid', color: BLACK })

    p.text({
      name: 'Quote',
      x: 150,
      y: 330,
      w: 780,
      text: 'Have nothing in your house that you do not know to be USEFUL, or believe to be beautiful.',
      font: 'crimson',
      size: 66,
      color: WHITE,
      on: BLACK,
      align: 'center',
      lh: 1.1,
      emphasis: [{ text: 'beautiful', italic: true }],
      lines: 4,
    })
    p.text({ name: 'Author', x: 0, y: 740, w: 1080, text: 'William Morris', font: 'crimson', size: 24, color: GREY, on: BLACK, align: 'center', upper: true, spacing: 300, lines: 1 })
    p.text({ name: 'Handle', x: 0, y: 980, w: 1080, text: '#yourbrandhere', font: 'crimson', size: 18, color: GREY, on: BLACK, align: 'center', upper: true, spacing: 400, lines: 1 })
    return doc
  },
}
