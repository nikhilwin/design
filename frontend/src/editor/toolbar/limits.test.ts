import { describe, expect, it } from 'vitest'
import { MAX_DIMENSION_PX } from '@/types/document'
import { CHAR_SPACING_RANGE, CORNER_RADIUS_MAX, FONT_SIZE_RANGE, LINE_HEIGHT_RANGE, STROKE_WIDTH_MAX } from '../engine/numbers'
import { unitToPx } from '../engine/units'
import { CANVAS_SIDE_PX, CORNER_RADIUS, FONT_SIZE, LETTER_SPACING, LINE_HEIGHT, LINE_WIDTH, STROKE_WIDTH, canvasSideRange, capLimit, clampTo, rangeHint } from './limits'

describe('toolbar limits', () => {
  it('are the toolbar’s ranges', () => {
    expect([FONT_SIZE.min, FONT_SIZE.max]).toEqual([8, 200])
    expect([LINE_HEIGHT.min, LINE_HEIGHT.max]).toEqual([0.5, 3])
    expect([STROKE_WIDTH.min, STROKE_WIDTH.max]).toEqual([0, 20])
    expect([CORNER_RADIUS.min, CORNER_RADIUS.max]).toEqual([0, 100])
  })

  it('stay inside what the engine accepts, so the chrome narrows the engine and never the other way round', () => {
    const inside = (limit: { min: number; max: number }, min: number, max: number): boolean => limit.min >= min && limit.max <= max
    expect(inside(FONT_SIZE, FONT_SIZE_RANGE[0], FONT_SIZE_RANGE[1])).toBe(true)
    expect(inside(LINE_HEIGHT, LINE_HEIGHT_RANGE[0], LINE_HEIGHT_RANGE[1])).toBe(true)
    expect(inside(LETTER_SPACING, CHAR_SPACING_RANGE[0], CHAR_SPACING_RANGE[1])).toBe(true)
    expect(inside(STROKE_WIDTH, 0, STROKE_WIDTH_MAX)).toBe(true)
    expect(inside(LINE_WIDTH, 0, STROKE_WIDTH_MAX)).toBe(true)
    expect(inside(CORNER_RADIUS, 0, CORNER_RADIUS_MAX)).toBe(true)
  })

  it('clamp and round to the limit’s digits', () => {
    expect(clampTo(FONT_SIZE, 5)).toBe(8)
    expect(clampTo(FONT_SIZE, 999)).toBe(200)
    expect(clampTo(LINE_HEIGHT, 0.04)).toBe(0.5)
    expect(clampTo(LINE_HEIGHT, 1.26)).toBe(1.3)
    expect(clampTo(LETTER_SPACING, -5000)).toBe(-200)
    expect(clampTo(STROKE_WIDTH, -1)).toBe(0)
    expect(clampTo(CORNER_RADIUS, 101)).toBe(100)
  })

  it('cap a limit at a smaller maximum without ever going below its minimum', () => {
    expect(capLimit(CORNER_RADIUS, 30).max).toBe(30)
    expect(capLimit(CORNER_RADIUS, 4000).max).toBe(100)
    expect(capLimit(CORNER_RADIUS, -5).max).toBe(0)
  })

  it('read as a sentence for the tooltip and the screen reader', () => {
    expect(rangeHint(FONT_SIZE)).toBe('Between 8 and 200')
    expect(rangeHint(LINE_HEIGHT)).toBe('Between 0.5 and 3')
    expect(rangeHint({ ...FONT_SIZE, min: 1, max: 20000 }, 'px')).toBe('Between 1 and 20000 px')
  })
})

describe('canvas side range', () => {
  it('is the document format’s own bound, not the reference’s 100-4000 px', () => {
    expect(CANVAS_SIDE_PX).toEqual({ min: 1, max: MAX_DIMENSION_PX })
    expect(canvasSideRange('px')).toMatchObject({ min: 1, max: 20000, decimals: 0 })
  })

  it.each(['px', 'mm', 'in'] as const)('has ends that are accepted back as pixels in %s', (unit) => {
    const range = canvasSideRange(unit)
    expect(Math.round(unitToPx(range.min, unit))).toBeGreaterThanOrEqual(CANVAS_SIDE_PX.min)
    expect(Math.round(unitToPx(range.max, unit))).toBeLessThanOrEqual(CANVAS_SIDE_PX.max)
    expect(range.max).toBeGreaterThan(range.min)
  })

  it('reads in the unit of the field', () => {
    expect(canvasSideRange('mm')).toMatchObject({ min: 0.3, max: 5291.6 })
    expect(canvasSideRange('in')).toMatchObject({ min: 0.02, max: 208.33 })
  })
})
