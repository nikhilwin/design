import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PrintPreview } from './PrintPreview'

const view = (box: SVGElement | null): number[] => (box?.getAttribute('viewBox') ?? '').split(' ').map(Number)

describe('print preview', () => {
  it('draws only the trim line when there is neither bleed nor marks', () => {
    render(<PrintPreview size={{ width: 800, height: 600 }} bleed={false} marks={false} bleedLabel="0 mm" />)
    const svg = screen.getByTestId('print-preview')
    expect(svg.querySelector('[data-part="bleed"]')).toBeNull()
    expect(svg.querySelector('[data-part="marks"]')).toBeNull()
    expect(svg.querySelector('[data-part="trim"]')).not.toBeNull()
    expect(svg).toHaveAccessibleName('Page layout: trim line')
    expect(screen.queryByText('Bleed')).toBeNull()
    expect(screen.queryByText('Crop marks')).toBeNull()
  })

  it('draws the bleed around the trim line and eight marks in the margin', () => {
    render(<PrintPreview size={{ width: 800, height: 600 }} bleed marks bleedLabel="3 mm" />)
    const svg = screen.getByTestId('print-preview')
    const trim = svg.querySelector('[data-part="trim"]')
    const bleed = svg.querySelector('[data-part="bleed"]')
    expect(Number(bleed?.getAttribute('width'))).toBeGreaterThan(Number(trim?.getAttribute('width')))
    expect(Number(bleed?.getAttribute('x'))).toBeLessThan(Number(trim?.getAttribute('x')))
    expect(svg.querySelectorAll('[data-part="marks"] line')).toHaveLength(8)
    expect(svg).toHaveAccessibleName('Page layout: trim line, 3 mm bleed around it, crop marks in the margin')
    expect(screen.getByText('Schematic, not to scale')).toBeInTheDocument()
    expect(screen.getByText('Bleed')).toBeInTheDocument()
    expect(screen.getByText('Crop marks')).toBeInTheDocument()
  })

  it('keeps the proportions of the page and stays inside the drawing', () => {
    render(<PrintPreview size={{ width: 1200, height: 600 }} bleed marks bleedLabel="3 mm" />)
    const svg = screen.getByTestId('print-preview')
    const trim = svg.querySelector('[data-part="trim"]')
    const [, , sheetWidth, sheetHeight] = view(svg as unknown as SVGElement)
    expect(Number(trim?.getAttribute('width')) / Number(trim?.getAttribute('height'))).toBeCloseTo(2, 5)
    for (const line of svg.querySelectorAll('[data-part="marks"] line')) {
      for (const name of ['x1', 'x2']) expect(Number(line.getAttribute(name))).toBeLessThanOrEqual(sheetWidth)
      for (const name of ['y1', 'y2']) expect(Number(line.getAttribute(name))).toBeLessThanOrEqual(sheetHeight)
    }
  })

  it('survives a very wide banner and a very tall strip', () => {
    for (const size of [{ width: 728, height: 90 }, { width: 20000, height: 1 }, { width: 1, height: 20000 }]) {
      const { unmount } = render(<PrintPreview size={size} bleed marks bleedLabel="10 mm" />)
      const trim = screen.getByTestId('print-preview').querySelector('[data-part="trim"]')
      expect(Number(trim?.getAttribute('width'))).toBeGreaterThanOrEqual(18)
      expect(Number(trim?.getAttribute('height'))).toBeGreaterThanOrEqual(18)
      unmount()
    }
  })
})
