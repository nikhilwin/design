import { describe, expect, it } from 'vitest'
import type { AudioTrack } from '@/types/document'
import { buildClock, placeTrack } from './clock'
import { DUCK_ATTACK_MS, DUCK_GAIN, DUCK_RELEASE_MS } from './model'
import { duckCurve, fadeCurve, fitFades, mergeSpans, planMix, sourcePositionMs, valueAt, voiceGainAt } from './plan'

const clock = buildClock(['a', 'b', 'c'], [4000, 6000, 5000]) // 0-4, 4-10, 10-15 s

const track = (patch: Partial<AudioTrack> = {}): AudioTrack => ({
  id: 't',
  kind: 'sfx',
  name: 't',
  src: '/media/a.ogg',
  scope: { type: 'design' },
  startMs: 0,
  durationMs: 2000,
  trimStartMs: 0,
  trimEndMs: 2000,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  muted: false,
  ...patch,
})

describe('buildClock', () => {
  it('lays pages end to end', () => {
    expect(clock.pages).toEqual([
      { pageId: 'a', startMs: 0, endMs: 4000 },
      { pageId: 'b', startMs: 4000, endMs: 10_000 },
      { pageId: 'c', startMs: 10_000, endMs: 15_000 },
    ])
    expect(clock.totalMs).toBe(15_000)
  })

  it('counts a length that is not a positive number as 0', () => {
    const c = buildClock(['a', 'b', 'c'], [NaN, -5, 1000])
    expect(c.pages.map((p) => p.endMs - p.startMs)).toEqual([0, 0, 1000])
  })
})

describe('placeTrack', () => {
  it('starts a design track at its offset on the whole timeline', () => {
    expect(placeTrack(track({ startMs: 1500 }), clock)).toMatchObject({ startMs: 1500, endMs: 3500, scopeStartMs: 0, scopeEndMs: 15_000, windowMs: 2000 })
  })

  it('starts a page track at its offset from the start of that page', () => {
    expect(placeTrack(track({ scope: { type: 'page', pageId: 'b' }, startMs: 500 }), clock)).toMatchObject({ startMs: 4500, endMs: 6500, scopeStartMs: 4000, scopeEndMs: 10_000 })
  })

  it('cuts a page track when its page ends', () => {
    expect(placeTrack(track({ scope: { type: 'page', pageId: 'a' }, startMs: 3000 }), clock)?.endMs).toBe(4000)
  })

  it('ends a track that does not loop after one play-through, and a looping one with its scope', () => {
    expect(placeTrack(track(), clock)?.endMs).toBe(2000)
    expect(placeTrack(track({ loop: true }), clock)?.endMs).toBe(15_000)
    expect(placeTrack(track({ loop: true, scope: { type: 'page', pageId: 'b' } }), clock)?.endMs).toBe(10_000)
  })

  it('plays only the trimmed part', () => {
    expect(placeTrack(track({ trimStartMs: 500, trimEndMs: 1500 }), clock)).toMatchObject({ endMs: 1000, windowMs: 1000 })
  })

  it('does not place a track whose page is missing or that starts after its scope', () => {
    expect(placeTrack(track({ scope: { type: 'page', pageId: 'gone' } }), clock)).toBeNull()
    expect(placeTrack(track({ scope: { type: 'page', pageId: 'a' }, startMs: 4000 }), clock)).toBeNull()
    expect(placeTrack(track({ startMs: 15_000 }), clock)).toBeNull()
  })
})

describe('fades', () => {
  it('rise and fall linearly at the edges of the track', () => {
    const placement = placeTrack(track({ fadeInMs: 500, fadeOutMs: 1000 }), clock)
    expect(placement).not.toBeNull()
    const fade = fadeCurve(placement!)
    expect(fade).toEqual([
      { t: 0, gain: 0 },
      { t: 500, gain: 1 },
      { t: 1000, gain: 1 },
      { t: 2000, gain: 0 },
    ])
    expect(valueAt(fade, 250)).toBeCloseTo(0.5)
    expect(valueAt(fade, 1500)).toBeCloseTo(0.5)
  })

  it('are flat without fades', () => {
    expect(fadeCurve(placeTrack(track(), clock)!).every((p) => p.gain === 1)).toBe(true)
  })

  it('share a short sound in proportion when together they are longer than it', () => {
    expect(fitFades(1000, 3000, 2000)).toEqual({ fadeIn: 500, fadeOut: 1500 })
    expect(fitFades(500, 500, 2000)).toEqual({ fadeIn: 500, fadeOut: 500 })
    expect(fitFades(5000, 0, 2000)).toEqual({ fadeIn: 2000, fadeOut: 0 })
  })

  it('count from where the track is cut by its page, not from where it would have ended', () => {
    const placement = placeTrack(track({ loop: true, fadeOutMs: 1000, scope: { type: 'page', pageId: 'a' } }), clock)!
    expect(valueAt(fadeCurve(placement), 3500)).toBeCloseTo(0.5)
  })
})

describe('ducking', () => {
  it('merges voiceovers that are too close for the level to come back', () => {
    const spans = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1200, endMs: 2000 },
      { startMs: 9000, endMs: 9500 },
    ]
    expect(mergeSpans(spans, DUCK_ATTACK_MS + DUCK_RELEASE_MS)).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 9000, endMs: 9500 },
    ])
    expect(mergeSpans(spans, 0)).toHaveLength(3)
  })

  it('falls over the attack time, holds, and rises over the release time', () => {
    const curve = duckCurve([{ startMs: 2000, endMs: 5000 }], 15_000)
    expect(valueAt(curve, 1999)).toBe(1)
    expect(valueAt(curve, 2000 + DUCK_ATTACK_MS)).toBeCloseTo(DUCK_GAIN)
    expect(valueAt(curve, 3500)).toBeCloseTo(DUCK_GAIN)
    expect(valueAt(curve, 5000 + DUCK_RELEASE_MS / 2)).toBeCloseTo((1 + DUCK_GAIN) / 2)
    expect(valueAt(curve, 5000 + DUCK_RELEASE_MS)).toBe(1)
    expect(valueAt(curve, 14_000)).toBe(1)
  })

  it('handles a voiceover that starts with the video', () => {
    const curve = duckCurve([{ startMs: 0, endMs: 1000 }], 5000)
    expect(valueAt(curve, 0)).toBe(1)
    expect(valueAt(curve, DUCK_ATTACK_MS)).toBeCloseTo(DUCK_GAIN)
  })

  it('lowers music and tracks told to duck, but not other kinds or the voiceover itself', () => {
    const tracks = [
      track({ id: 'music', kind: 'music', loop: true }),
      track({ id: 'sfx', kind: 'sfx' }),
      track({ id: 'sfx-duck', kind: 'sfx', duckUnderVoiceover: true }),
      track({ id: 'music-loud', kind: 'music', duckUnderVoiceover: false }),
      track({ id: 'voice', kind: 'voiceover', startMs: 3000, trimEndMs: 2000, duckUnderVoiceover: true }),
    ]
    const plan = planMix(tracks, clock)
    const ducked = Object.fromEntries(plan.voices.map((v) => [v.track.id, v.duck !== null]))
    expect(ducked).toEqual({ music: true, sfx: false, 'sfx-duck': true, 'music-loud': false, voice: false })
    expect(plan.voiceovers).toEqual([{ startMs: 3000, endMs: 5000 }])
  })

  it('does not duck for a muted voiceover', () => {
    const plan = planMix([track({ id: 'm', kind: 'music', loop: true }), track({ id: 'v', kind: 'voiceover', muted: true })], clock)
    expect(plan.voices.map((v) => v.track.id)).toEqual(['m'])
    expect(plan.voices[0].duck).toBeNull()
  })
})

describe('planMix', () => {
  it('leaves out muted, silent and unplaceable tracks, and can solo one', () => {
    const tracks = [track({ id: 'a' }), track({ id: 'b', muted: true }), track({ id: 'c', volume: 0 }), track({ id: 'd', scope: { type: 'page', pageId: 'gone' } }), track({ id: 'e' })]
    expect(planMix(tracks, clock).voices.map((v) => v.track.id)).toEqual(['a', 'e'])
    expect(planMix(tracks, clock, { soloId: 'e' }).voices.map((v) => v.track.id)).toEqual(['e'])
  })

  it('gives the gain of a voice at a moment: volume x fade x duck, and nothing outside it', () => {
    const plan = planMix([track({ id: 'm', kind: 'music', loop: true, volume: 0.8, fadeInMs: 1000 }), track({ id: 'v', kind: 'voiceover', startMs: 5000 })], clock)
    const music = plan.voices[0]
    expect(voiceGainAt(music, 500)).toBeCloseTo(0.4)
    expect(voiceGainAt(music, 2000)).toBeCloseTo(0.8)
    expect(voiceGainAt(music, 6000)).toBeCloseTo(0.8 * DUCK_GAIN)
    expect(voiceGainAt(music, 15_000)).toBe(0)
  })
})

describe('sourcePositionMs', () => {
  it('walks through the trimmed part and wraps while looping', () => {
    const loop = placeTrack(track({ loop: true, trimStartMs: 500, trimEndMs: 1500 }), clock)!
    expect(sourcePositionMs(loop, 0)).toBe(500)
    expect(sourcePositionMs(loop, 400)).toBe(900)
    expect(sourcePositionMs(loop, 1000)).toBe(500)
    expect(sourcePositionMs(loop, 2600)).toBe(1100)
    const once = placeTrack(track({ trimStartMs: 500, trimEndMs: 1500 }), clock)!
    expect(sourcePositionMs(once, 5000)).toBe(1500)
  })
})
