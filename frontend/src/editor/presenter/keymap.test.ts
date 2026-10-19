import { describe, expect, it } from 'vitest'
import { actionForKey, type KeyLike } from './keymap'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('actionForKey', () => {
  it('maps the navigation keys', () => {
    for (const k of [' ', 'ArrowRight', 'ArrowDown', 'PageDown', 'Enter']) expect(actionForKey(key(k))).toBe('next')
    for (const k of ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']) expect(actionForKey(key(k))).toBe('prev')
    expect(actionForKey(key('Home'))).toBe('first')
    expect(actionForKey(key('End'))).toBe('last')
  })

  it('maps the letters, in either case', () => {
    const letters: Record<string, string> = { f: 'toggleFullscreen', n: 'toggleNotes', p: 'togglePause', b: 'toggleBlackout', l: 'toggleLaser', r: 'restart', m: 'toggleSound' }
    for (const [k, action] of Object.entries(letters)) {
      expect(actionForKey(key(k))).toBe(action)
      expect(actionForKey(key(k.toUpperCase(), { shiftKey: true }))).toBe(action)
    }
  })

  it('maps Escape and the help key', () => {
    expect(actionForKey(key('Escape'))).toBe('exit')
    expect(actionForKey(key('?', { shiftKey: true }))).toBe('toggleHelp')
  })

  it('Shift turns Space and Enter into "back"', () => {
    expect(actionForKey(key(' ', { shiftKey: true }))).toBe('prev')
    expect(actionForKey(key('Enter', { shiftKey: true }))).toBe('prev')
  })

  it('leaves browser chords alone', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(actionForKey(key('r', mods))).toBeNull()
      expect(actionForKey(key('ArrowLeft', mods))).toBeNull()
      expect(actionForKey(key('f', mods))).toBeNull()
    }
  })

  it('ignores keys it does not know', () => {
    for (const k of ['a', 'Tab', 'F5', 'Shift', 'Control', '1', 'Delete']) expect(actionForKey(key(k))).toBeNull()
  })
})
