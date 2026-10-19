import { describe, expect, it } from 'vitest'
import { CHART_KINDS, CHART_SAMPLES, chartSvg } from './charts'

const parse = (svg: string): Document => new DOMParser().parseFromString(svg, 'image/svg+xml')

describe('chartSvg', () => {
  it.each(CHART_KINDS)('%s is well-formed SVG with hex colours only', (kind) => {
    const doc = parse(chartSvg(kind))
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 200 200')
    const fills = [...doc.querySelectorAll('[fill],[stroke]')].flatMap((el) => [el.getAttribute('fill'), el.getAttribute('stroke')]).filter((c): c is string => !!c && c !== 'none')
    expect(fills.length).toBeGreaterThan(0)
    for (const c of fills) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('draws one bar, one slice per value', () => {
    expect(parse(chartSvg('bar')).querySelectorAll('rect')).toHaveLength(CHART_SAMPLES.bar.length)
    expect(parse(chartSvg('pie')).querySelectorAll('path')).toHaveLength(CHART_SAMPLES.pie.length)
    expect(parse(chartSvg('donut', [1, 1, 1, 1])).querySelectorAll('path')).toHaveLength(4)
  })

  it('scales bars to the largest value', () => {
    const rects = [...parse(chartSvg('bar', [10, 20])).querySelectorAll('rect')]
    expect(Number(rects[1].getAttribute('height'))).toBeCloseTo(Number(rects[0].getAttribute('height')) * 2, 1)
  })

  it('falls back to the sample for unusable data and ignores non-finite numbers', () => {
    expect(chartSvg('pie', [])).toBe(chartSvg('pie', CHART_SAMPLES.pie))
    expect(parse(chartSvg('line', [10, Number.NaN, 20])).querySelectorAll('circle')).toHaveLength(2)
  })

  it('draws a single value as a full circle (an arc from a point to itself would be invisible)', () => {
    expect(parse(chartSvg('pie', [5])).querySelectorAll('circle')).toHaveLength(1)
    const donut = parse(chartSvg('donut', [5, 0]))
    expect(donut.querySelectorAll('path')).toHaveLength(1)
    expect(donut.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd')
    expect(chartSvg('pie', [5])).not.toContain('NaN')
  })
})
