import { describe, expect, it } from 'vitest'
import { GIF_WARN_BYTES, contentClass, estimateOutput, etaMs, formatBytes, formatLength, movingFrames, videoBitrate } from './estimate'
import { defaultVideoOptions } from './options'
import { compileTimeline } from './timeline'
import { allPages, anim, deck, doc, page, rect } from './testing'

const frame = { width: 1280, height: 720 }

describe('videoBitrate', () => {
  it('grows with the picture, the frame rate and the quality, and shrinks with a better codec', () => {
    const base = videoBitrate('avc', frame, 30, 'balanced')
    expect(videoBitrate('avc', { width: 1920, height: 1080 }, 30, 'balanced')).toBeGreaterThan(base)
    expect(videoBitrate('avc', frame, 60, 'balanced')).toBeGreaterThan(base)
    expect(videoBitrate('avc', frame, 60, 'balanced')).toBeLessThan(base * 2)
    expect(videoBitrate('avc', frame, 30, 'high')).toBeGreaterThan(base)
    expect(videoBitrate('avc', frame, 30, 'small')).toBeLessThan(base)
    expect(videoBitrate('vp9', frame, 30, 'balanced')).toBeLessThan(base)
  })

  it('stays within what an encoder takes', () => {
    expect(videoBitrate('avc', { width: 2, height: 2 }, 24, 'small')).toBe(200_000)
    expect(videoBitrate('avc', { width: 4096, height: 2160 }, 60, 'high')).toBeLessThanOrEqual(60_000_000)
  })
})

describe('estimateOutput', () => {
  const timeline = compileTimeline(allPages(deck()), { pageSeconds: null })

  it('gives the length and the number of frames', () => {
    const estimate = estimateOutput(timeline, defaultVideoOptions('mp4'), frame, false)
    expect(estimate).toMatchObject({ durationMs: 15_500, frames: 465, tooLong: false, large: false })
  })

  it('adds the sound to a video and nothing to a GIF', () => {
    const silent = estimateOutput(timeline, defaultVideoOptions('mp4'), frame, false).bytes
    const sound = estimateOutput(timeline, defaultVideoOptions('mp4'), frame, true).bytes
    expect(sound - silent).toBeCloseTo((128_000 / 8) * 15.5, -3)
    const gif = defaultVideoOptions('gif')
    expect(estimateOutput(timeline, gif, frame, true).bytes).toBe(estimateOutput(timeline, gif, frame, false).bytes)
  })

  it('expects a still design to be much smaller than one that moves all the time', () => {
    const still = compileTimeline(allPages(doc([page('a', { durationSec: 10 }), page('b', { durationSec: 10 })])), { pageSeconds: null })
    const stillBytes = estimateOutput(still, defaultVideoOptions('mp4'), frame, false).bytes
    const movingBytes = estimateOutput(timeline, { ...defaultVideoOptions('mp4') }, frame, false).bytes / timeline.totalMs
    expect(stillBytes / still.totalMs).toBeLessThan(movingBytes)
  })

  it('stores a GIF frame only where something changes: a still page costs one frame', () => {
    const still = compileTimeline(allPages(doc([page('a', { durationSec: 30 })])), { pageSeconds: null })
    expect(movingFrames(still, 15)).toBe(1)
    expect(movingFrames(timeline, 15)).toBeLessThan(estimateOutput(timeline, defaultVideoOptions('gif'), frame, false).frames)
  })

  it('warns about a GIF over 25 MB and a video over the limit', () => {
    const long = compileTimeline(allPages(doc([page('a', { durationSec: 600 })])), { pageSeconds: null })
    expect(estimateOutput(long, defaultVideoOptions('mp4'), frame, false).tooLong).toBe(false)
    const tooLong = compileTimeline(allPages(doc([page('a', { durationSec: 600 }), page('b', { durationSec: 5 })])), { pageSeconds: null })
    expect(estimateOutput(tooLong, defaultVideoOptions('mp4'), frame, false).tooLong).toBe(true)
    const moving = compileTimeline(allPages(doc([page('a', { durationSec: 5, transition: { preset: 'fade', durationMs: 3000, easing: 'linear' } }), page('b', { transition: { preset: 'fade', durationMs: 3000, easing: 'linear' } })])), { pageSeconds: 60 })
    const big = estimateOutput(moving, { ...defaultVideoOptions('gif'), fps: 20, resolution: 720 }, { width: 1280, height: 720 }, false)
    expect(big.bytes > GIF_WARN_BYTES).toBe(big.large)
  })
})

describe('labels', () => {
  it('writes sizes and lengths the way a person reads them', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(850 * 1024)).toBe('850 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12 MB')
    expect(formatBytes(Number.NaN)).toBe('0 KB')
    expect(formatLength(7000)).toBe('0:07')
    expect(formatLength(65_400)).toBe('1:05')
    expect(formatLength(-5)).toBe('0:00')
  })
})

describe('etaMs', () => {
  it('promises nothing before a few frames are done', () => {
    expect(etaMs(0, 100, 0)).toBeNull()
    expect(etaMs(2, 100, 400)).toBeNull()
  })

  it('extrapolates from the rate so far', () => {
    expect(etaMs(10, 100, 1000)).toBe(9000)
    expect(etaMs(50, 100, 2500)).toBe(2500)
  })

  it('is zero when everything is done', () => {
    expect(etaMs(100, 100, 5000)).toBe(0)
  })
})

describe('contentClass', () => {
  const solid = { type: 'solid' as const, color: '#ffffff' }
  it('is flat for shapes and text on a colour, and for graphics and QR codes', () => {
    expect(contentClass(page('a'))).toBe('flat')
    expect(contentClass(page('a', { objects: [rect('r'), { id: 'q', type: 'image', qr: { text: 'x', fg: '#000', bg: '#fff' } }, { id: 'g', type: 'image', src: '/media/elements/star.svg' }] }))).toBe('flat')
    expect(contentClass(page('a', { objects: [{ id: 'p', type: 'image', isPlaceholder: true }] }))).toBe('flat')
  })

  it('is gradient for a gradient background and photo for a picture, a background picture first', () => {
    expect(contentClass(page('a', { background: { type: 'gradient', kind: 'linear', stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] } }))).toBe('gradient')
    expect(contentClass(page('a', { objects: [{ id: 'i', type: 'image', src: '/media/uploads/photo.jpg' }] }))).toBe('photo')
    expect(contentClass(page('a', { background: { type: 'image', src: '/media/x.jpg', fit: 'cover' }, objects: [] }))).toBe('photo')
    expect(contentClass({ background: solid, objects: [] })).toBe('flat')
  })
})

/** The animated deck of the dev harness, as pages: what was measured in Chromium 141 is in the comments. */
function measuredDeck() {
  const loopStar = rect('s', { emphasis: anim('float', { durationMs: 2400, delayMs: 800, loop: true }), enter: anim('fade', { durationMs: 600, delayMs: 1000 }) })
  const cards = rect('c', { enter: anim('fade', { durationMs: 600, delayMs: 1200 }), exit: anim('fade', { durationMs: 500, delayMs: 4400 }) })
  const thanks = rect('t', { enter: anim('fade', { durationMs: 600, delayMs: 900 }) })
  return doc(
    [
      page('a', { durationSec: 6, objects: [loopStar] }),
      page('b', { durationSec: 5, transition: { preset: 'push', durationMs: 700, easing: 'ease-in-out', direction: 'right' }, objects: [cards] }),
      page('c', { durationSec: 4, transition: { preset: 'circle', durationMs: 900, easing: 'ease-in-out' }, objects: [thanks] }),
    ],
    1280,
    720,
  )
}

describe('the estimate against exports measured in a browser', () => {
  const timeline = compileTimeline(allPages(measuredDeck()), { pageSeconds: null })
  const within = (estimate: number, actual: number, tolerance: number): void => {
    expect(estimate / actual).toBeGreaterThan(1 - tolerance)
    expect(estimate / actual).toBeLessThan(1 + tolerance)
  }

  it('has the length the harness deck has: 21.5 s', () => {
    expect(timeline.totalMs).toBe(21_500)
  })

  it('is within 15 per cent for flat artwork as VP9 at 480p, 720p and 1080p, any frame rate and quality (measured: 0.49 to 3.2 MB)', () => {
    const at = (resolution: 480 | 720 | 1080, fps: number, quality: 'small' | 'balanced' | 'high', frame: { width: number; height: number }): number =>
      estimateOutput(timeline, { ...defaultVideoOptions('webm'), resolution, fps, quality }, frame, false).bytes
    within(at(480, 24, 'small', { width: 852, height: 480 }), 491_147, 0.15)
    within(at(480, 24, 'balanced', { width: 852, height: 480 }), 571_913, 0.15)
    within(at(480, 24, 'high', { width: 852, height: 480 }), 618_107, 0.15)
    within(at(480, 60, 'balanced', { width: 852, height: 480 }), 972_141, 0.15)
    within(at(720, 30, 'balanced', { width: 1280, height: 720 }), 1_163_195, 0.15)
    within(at(1080, 30, 'balanced', { width: 1920, height: 1080 }), 1_997_895, 0.15)
    within(at(1080, 60, 'balanced', { width: 1920, height: 1080 }), 3_160_597, 0.15)
  })

  it('is within 30 per cent for the same deck as a GIF (measured: 0.7 MB at 240p, 2.5 MB at 480p, 4.5 MB at 720p)', () => {
    const gif = (resolution: 240 | 480 | 720, fps: number, frame: { width: number; height: number }): number => estimateOutput(timeline, { ...defaultVideoOptions('gif'), resolution, fps }, frame, false).bytes
    within(gif(240, 10, { width: 426, height: 240 }), 704_201, 0.45)
    within(gif(480, 15, { width: 852, height: 480 }), 2_499_928, 0.3)
    within(gif(720, 20, { width: 1280, height: 720 }), 4_484_922, 0.3)
  })

  it('expects a deck with no motion to be a tenth of that: one frame a page for a GIF, a few kilobits a second for video', () => {
    const still = compileTimeline(allPages(doc([page('a', { durationSec: 5 }), page('b', { durationSec: 5 }), page('c', { durationSec: 5 })], 1280, 720)), { pageSeconds: null })
    // Measured: 68 kB as a 480p WebM at 30 fps, 13 kB as a 480p GIF.
    within(estimateOutput(still, { ...defaultVideoOptions('webm'), resolution: 480 }, { width: 852, height: 480 }, false).bytes, 67_788, 0.25)
    within(estimateOutput(still, { ...defaultVideoOptions('gif'), resolution: 480 }, { width: 852, height: 480 }, false).bytes, 13_169, 0.3)
  })

  it('expects pictures to cost much more than flat artwork, and a gradient something in between', () => {
    const withBackground = (background: ReturnType<typeof page>['background'], objects = measuredDeck().pages[0].objects) =>
      compileTimeline(allPages(doc([page('a', { durationSec: 6, background, objects }), page('b', { durationSec: 6, background, objects })], 1280, 720)), { pageSeconds: null })
    const size = (t: ReturnType<typeof compileTimeline>, format: 'webm' | 'gif'): number => estimateOutput(t, { ...defaultVideoOptions(format), resolution: 480 }, { width: 852, height: 480 }, false).bytes
    const flat = withBackground({ type: 'solid', color: '#ffffff' })
    const gradient = withBackground({ type: 'gradient', kind: 'linear', stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] })
    const photo = withBackground({ type: 'image', src: '/media/p.jpg', fit: 'cover' })
    for (const format of ['webm', 'gif'] as const) {
      expect(size(gradient, format)).toBeGreaterThan(size(flat, format) * 1.5)
      expect(size(photo, format)).toBeGreaterThan(size(gradient, format) * 1.5)
    }
    // A photograph moving at 480p is some megabytes a minute, as measured (2.1 MB for 14 s at 480p, 24 fps).
    within(estimateOutput(photo, { ...defaultVideoOptions('webm'), resolution: 480, fps: 24 }, { width: 852, height: 480 }, false).bytes, 2_086_312 * (12 / 14.3), 0.5)
  })
})
