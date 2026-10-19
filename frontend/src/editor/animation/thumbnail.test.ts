import { describe, expect, it } from 'vitest'
import type { Anim } from '@/types/document'
import { context2d, createCanvas } from './canvasFx'
import { emphasisPresets, inOutPresets, transitionPresets } from './presets'
import { THUMB_HOLD_MS, type ThumbColors, drawAnimationThumb, drawTransitionThumb, loopTime, stillTime } from './thumbnail'

const COLORS: ThumbColors = { card: 'rgb(225, 29, 72)', ink: 'rgb(255, 255, 255)', ground: 'rgb(244, 241, 241)', other: 'rgb(28, 21, 23)' }
const W = 160
const H = 110

function frame(draw: (ctx: ReturnType<typeof context2d>) => void): Uint8ClampedArray {
  const canvas = createCanvas(W, H)
  const ctx = context2d(canvas)
  draw(ctx)
  return ctx.getImageData(0, 0, W, H).data
}

function differs(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true
  return false
}

const anim = (preset: string, defaults: { durationMs: number; easing: Anim['easing'] }): Anim => ({ preset, delayMs: 0, ...defaults })

describe('thumbnails of enter and exit presets', () => {
  for (const preset of inOutPresets.list()) {
    for (const slot of ['enter', 'exit'] as const) {
      it(`${preset.id} (${slot}) shows something different half way than at rest, and nothing at its hidden end`, () => {
        const a = anim(preset.id, preset.defaults)
        const rest = frame((ctx) => drawAnimationThumb(ctx, W, H, slot, a, slot === 'enter' ? a.durationMs : 0, COLORS))
        const mid = frame((ctx) => drawAnimationThumb(ctx, W, H, slot, a, stillTime(a), COLORS))
        const hidden = frame((ctx) => drawAnimationThumb(ctx, W, H, slot, a, slot === 'enter' ? 0 : a.durationMs, COLORS))
        expect(differs(mid, rest)).toBe(true)
        // The card is brand-coloured; at the start of an enter and the end of an exit none of it is on the tile. A text
        // animation leaves the card where it is and moves the writing on it, which is white.
        const ink = (data: Uint8ClampedArray): number => {
          let n = 0
          for (let i = 0; i < data.length; i += 4) {
            if (preset.textDefault ? data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255 : data[i] > 200 && data[i + 1] < 80) n++
          }
          return n
        }
        expect(ink(rest)).toBeGreaterThan(preset.textDefault ? 100 : 500)
        expect(ink(hidden)).toBeLessThan(ink(rest) * 0.5)
      })
    }
  }
})

describe('thumbnails of emphasis presets', () => {
  for (const preset of emphasisPresets.list()) {
    it(`${preset.id} moves the card in the middle of its cycle and leaves it at rest at both ends`, () => {
      const a = anim(preset.id, preset.defaults)
      const rest = frame((ctx) => drawAnimationThumb(ctx, W, H, 'emphasis', { ...a, intensity: 1 }, 0, COLORS))
      const end = frame((ctx) => drawAnimationThumb(ctx, W, H, 'emphasis', { ...a, intensity: 1 }, a.durationMs, COLORS))
      expect(differs(rest, end)).toBe(false)
      let moved = false
      for (let i = 1; i < 20; i++) if (differs(rest, frame((ctx) => drawAnimationThumb(ctx, W, H, 'emphasis', { ...a, intensity: 1 }, (a.durationMs * i) / 20, COLORS)))) moved = true
      expect(moved).toBe(true)
    })
  }
})

describe('thumbnails of transitions', () => {
  for (const preset of transitionPresets.list()) {
    it(`${preset.id} goes from page A to page B`, () => {
      const t = { preset: preset.id, easing: 'linear' as const, direction: preset.defaults.direction }
      const start = frame((ctx) => drawTransitionThumb(ctx, W, H, t, 0, COLORS))
      const end = frame((ctx) => drawTransitionThumb(ctx, W, H, t, 1, COLORS))
      expect(differs(start, end)).toBe(true)
      expect(start[0]).toBe(225)
      expect(end[0]).toBe(28)
    })
  }
})

describe('the clock of a tile', () => {
  it('holds the last frame for a moment and starts over', () => {
    expect(loopTime(0, 600)).toBe(0)
    expect(loopTime(599, 600)).toBe(599)
    expect(loopTime(600 + THUMB_HOLD_MS - 1, 600)).toBe(600 + THUMB_HOLD_MS - 1)
    expect(loopTime(600 + THUMB_HOLD_MS, 600)).toBe(0)
  })

  it('shows a still where the animation is half way, however its easing spends the time', () => {
    expect(stillTime({ durationMs: 1000, easing: 'linear' })).toBeCloseTo(500, -1)
    expect(stillTime({ durationMs: 1000, easing: 'ease-in' })).toBeGreaterThan(700)
    expect(stillTime({ durationMs: 1000, easing: 'ease-out' })).toBeLessThan(300)
    expect(stillTime({ durationMs: 1000, easing: 'bounce' })).toBeLessThan(500)
  })
})
