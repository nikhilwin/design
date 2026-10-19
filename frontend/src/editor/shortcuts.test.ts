import { formatShortcut, matchesShortcut, parseShortcut } from './shortcuts'

const ev = (key: string, mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('shortcuts', () => {
  it('parses chords and alternatives', () => {
    expect(parseShortcut('Mod+Shift+Z')).toEqual([{ mod: true, shift: true, alt: false, key: 'z' }])
    expect(parseShortcut('Mod+Z|Mod+Y')).toHaveLength(2)
    expect(parseShortcut('Mod++')[0]).toMatchObject({ mod: true, key: '+' })
    expect(parseShortcut('Delete|Backspace').map((c) => c.key)).toEqual(['delete', 'backspace'])
  })

  it('matches modifiers exactly', () => {
    expect(matchesShortcut(ev('z', { ctrlKey: true }), 'Mod+Z')).toBe(true)
    expect(matchesShortcut(ev('z', { metaKey: true }), 'Mod+Z')).toBe(true)
    expect(matchesShortcut(ev('Z', { ctrlKey: true, shiftKey: true }), 'Mod+Z')).toBe(false)
    expect(matchesShortcut(ev('Z', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+Z')).toBe(true)
    expect(matchesShortcut(ev('z'), 'Mod+Z')).toBe(false)
    expect(matchesShortcut(ev('z', { ctrlKey: true, altKey: true }), 'Mod+Z')).toBe(false)
  })

  it('matches arrows with and without shift', () => {
    expect(matchesShortcut(ev('ArrowLeft'), 'ArrowLeft')).toBe(true)
    expect(matchesShortcut(ev('ArrowLeft', { shiftKey: true }), 'ArrowLeft')).toBe(false)
    expect(matchesShortcut(ev('ArrowLeft', { shiftKey: true }), 'Shift+ArrowLeft')).toBe(true)
  })

  it('treats symbol keys by character', () => {
    expect(matchesShortcut(ev('?', { shiftKey: true }), '?')).toBe(true)
    expect(matchesShortcut(ev('=', { ctrlKey: true }), 'Mod+=')).toBe(true)
    expect(matchesShortcut(ev('+', { ctrlKey: true, shiftKey: true }), 'Mod++')).toBe(true)
  })

  it('formats for each platform', () => {
    expect(formatShortcut('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z')
    expect(formatShortcut('Mod+Shift+Z', true)).toBe('⇧⌘Z')
    expect(formatShortcut('Delete|Backspace', false)).toBe('Del')
    expect(formatShortcut('ArrowLeft', false)).toBe('←')
  })
})
