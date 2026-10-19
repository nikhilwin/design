import { describe, expect, it } from 'vitest'
import { PATTERN_IDS, patternSvg, patternUrl, tileSize } from './patterns'

describe('background patterns', () => {
  it.each(PATTERN_IDS)('%s is a well-formed square tile using only the given colours', (id) => {
    const svg = patternSvg(id, '#112233', '#ffeedd', 40)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.getAttribute('width')).toBe('40')
    expect(doc.documentElement.getAttribute('height')).toBe('40')
    const colours = new Set([...doc.querySelectorAll('[fill],[stroke]')].flatMap((e) => [e.getAttribute('fill'), e.getAttribute('stroke')]).filter((c): c is string => !!c && c !== 'none'))
    expect([...colours].sort()).toEqual(['#112233', '#ffeedd'])
  })

  it('never puts unchecked text into the markup', () => {
    const svg = patternSvg('dots', '"/><script>x</script>', 'red', 40)
    expect(svg).not.toContain('script')
    expect(svg).toContain('#7a64e0')
    expect(svg).toContain('#ffffff')
  })

  it('keeps the tile edge within limits and proportional to the page', () => {
    expect(tileSize(1080, 1080)).toBe(60)
    expect(tileSize(100, 100)).toBe(16)
    expect(tileSize(20000, 20000)).toBe(160)
    expect(tileSize(1920, 1080)).toBe(60)
  })

  it('builds an SVG data URL', () => {
    expect(patternUrl('grid', '#000000', '#ffffff', 32)).toMatch(/^data:image\/svg\+xml;utf8,%3Csvg/)
  })
})
