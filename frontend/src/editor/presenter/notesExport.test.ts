import { describe, expect, it } from 'vitest'
import type { DocPage, DoryDocument } from '@/types/document'
import { buildNotes, hasNotes, notesFile, notesFileName } from './notesExport'

const page = (id: string, extra: Partial<DocPage> = {}): DocPage => ({ id, background: { type: 'solid', color: '#ffffff' }, objects: [], ...extra })
const docOf = (...pages: DocPage[]): DoryDocument => ({ schemaVersion: 1, width: 800, height: 600, unit: 'px', pages })

describe('buildNotes', () => {
  const doc = docOf(page('a', { name: 'Cover', notes: 'Welcome everyone.\nIntroduce yourself.' }), page('b'), page('c', { name: 'Close', notes: '  Ask for questions.  \n\n' }))

  it('writes Markdown with a section per page, in order', () => {
    expect(buildNotes(doc, 'Launch deck', 'markdown')).toBe(
      [
        '# Speaker notes: Launch deck',
        '',
        '## Page 1: Cover',
        '',
        'Welcome everyone.',
        'Introduce yourself.',
        '',
        '## Page 2: Page 2',
        '',
        '(no notes)',
        '',
        '## Page 3: Close',
        '',
        '  Ask for questions.',
        '',
      ].join('\n'),
    )
  })

  it('writes plain text with underlined headings', () => {
    const text = buildNotes(doc, 'Launch deck', 'text')
    expect(text.startsWith('Speaker notes: Launch deck\n==========================\n\nPage 1: Cover\n-------------\n\nWelcome everyone.')).toBe(true)
    expect(text.endsWith('  Ask for questions.\n')).toBe(true)
    expect(text).toContain('(no notes)')
    expect(text).not.toContain('#')
  })

  it('keeps the notes verbatim and puts a multi-line title or page name on one line', () => {
    const tricky = docOf(page('a', { name: 'Line\none', notes: '<script>alert(1)</script> **bold** # not a heading' }))
    const md = buildNotes(tricky, 'A\nB', 'markdown')
    expect(md).toContain('# Speaker notes: A B')
    expect(md).toContain('## Page 1: Line one')
    expect(md).toContain('<script>alert(1)</script> **bold** # not a heading')
  })

  it('names an untitled design', () => {
    expect(buildNotes(docOf(page('a')), '   ', 'markdown')).toContain('# Speaker notes: Untitled design')
  })

  it('ends with exactly one newline', () => {
    for (const format of ['markdown', 'text'] as const) {
      const out = buildNotes(doc, 'x', format)
      expect(out.endsWith('\n')).toBe(true)
      expect(out.endsWith('\n\n')).toBe(false)
    }
  })
})

describe('hasNotes', () => {
  it('is true only when some page has text', () => {
    expect(hasNotes(docOf(page('a'), page('b', { notes: 'x' })))).toBe(true)
    expect(hasNotes(docOf(page('a'), page('b')))).toBe(false)
    expect(hasNotes(docOf(page('a', { notes: '   ' })))).toBe(false)
  })
})

describe('notesFileName', () => {
  it('makes a safe slug', () => {
    expect(notesFileName('My Pitch Deck!', 'markdown')).toBe('my-pitch-deck-notes.md')
    expect(notesFileName('  Q3 / Q4: plans  ', 'text')).toBe('q3-q4-plans-notes.txt')
    expect(notesFileName('../../etc/passwd', 'text')).toBe('etc-passwd-notes.txt')
    expect(notesFileName('Café Münch', 'markdown')).toBe('café-münch-notes.md')
  })

  it('falls back for titles with no usable characters and caps the length', () => {
    expect(notesFileName('!!!', 'markdown')).toBe('design-notes.md')
    expect(notesFileName('', 'text')).toBe('design-notes.txt')
    expect(notesFileName('x'.repeat(200), 'text').length).toBeLessThanOrEqual(60 + '-notes.txt'.length)
  })
})

describe('notesFile', () => {
  it('returns a blob with the right type and the file name', async () => {
    const file = notesFile(docOf(page('a', { notes: 'hi' })), 'Deck', 'markdown')
    expect(file.filename).toBe('deck-notes.md')
    expect(file.blob.type).toBe('text/markdown;charset=utf-8')
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(file.blob)
    })
    expect(text).toContain('hi')
  })
})
