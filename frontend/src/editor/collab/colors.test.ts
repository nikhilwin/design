import { USER_COLORS, colorForUser, contrast, initials, isHexColor, textOn } from './colors'

/** Hue in degrees, or `null` for a grey. */
function hue(hex: string): number | null {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d < 40) return null
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

describe('collaborator colours', () => {
  it('are stable for a user and spread over the palette', () => {
    expect(colorForUser('user-1')).toBe(colorForUser('user-1'))
    const used = new Set(Array.from({ length: 200 }, (_, i) => colorForUser(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)))
    expect(used.size).toBeGreaterThanOrEqual(10)
  })

  it('read with white text and stand out against a white page', () => {
    for (const color of USER_COLORS) {
      expect(isHexColor(color)).toBe(true)
      expect(contrast(color, '#ffffff')).toBeGreaterThanOrEqual(4.5)
      expect(textOn(color)).toBe('#ffffff')
    }
  })

  it('never use a red or a pink, which are the editor\'s own selection colours', () => {
    for (const color of USER_COLORS) {
      const h = hue(color)
      if (h !== null) expect(h > 10 && h < 330).toBe(true)
    }
  })

  it('differ from each other by at least 15 degrees of hue', () => {
    const hues = USER_COLORS.map(hue).filter((h): h is number => h !== null)
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const gap = Math.abs(hues[i] - hues[j])
        expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(15)
      }
    }
  })

  it('pick the readable text colour for any background', () => {
    expect(textOn('#ffffff')).toBe('#111111')
    expect(textOn('#000000')).toBe('#ffffff')
    expect(textOn('#fde047')).toBe('#111111')
  })

  it('only accept #rrggbb', () => {
    expect(isHexColor('#a1B2c3')).toBe(true)
    for (const bad of ['#fff', 'red', '#12345g', '', null, 12, 'url(x)']) expect(isHexColor(bad)).toBe(false)
  })

  it('make initials from a name', () => {
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('ada')).toBe('AD')
    expect(initials('  Jean  Luc  Picard ')).toBe('JP')
    expect(initials('')).toBe('?')
    expect(initials('李 雷')).toBe('李雷')
  })
})
