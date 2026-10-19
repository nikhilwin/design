import { describe, expect, it } from 'vitest'
import { MAX_PEAKS, MIN_PEAKS, barsFor, clearPeakCache, computePeaks, displayGain, peakCount, peakLevel, peaksFor, peaksFromCatalogue } from './peaks'

const pcm = (channels: number[][], sampleRate = 1000) => ({ sampleRate, numberOfChannels: channels.length, length: channels[0].length, getChannelData: (c: number) => Float32Array.from(channels[c]) })

describe('peakCount', () => {
  it('is 20 per second between 64 and 6000', () => {
    expect(peakCount(30_000)).toBe(600)
    expect(peakCount(100)).toBe(MIN_PEAKS)
    expect(peakCount(10 * 3_600_000)).toBe(MAX_PEAKS)
  })
})

describe('computePeaks', () => {
  it('takes the loudest absolute sample of each slice, over all channels', () => {
    const left = [0, 0.1, 0, 0, -0.8, 0, 0, 0]
    const right = [0.3, 0, 0, 0, 0, 0, 0, -0.2]
    return computePeaks(pcm([left, right]), 4).then((peaks) => {
      expect(Array.from(peaks.values)).toEqual([expect.closeTo(0.3), 0, expect.closeTo(0.8), expect.closeTo(0.2)])
      expect(peaks.durationMs).toBe(8)
    })
  })

  it('yields a value for every slice even when there are fewer samples than slices', async () => {
    const peaks = await computePeaks(pcm([[0.5, 0.25]]), 8)
    expect(peaks.values).toHaveLength(8)
    expect(Math.max(...peaks.values)).toBeCloseTo(0.5)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const big = { sampleRate: 48000, numberOfChannels: 1, length: 3_000_000, getChannelData: () => new Float32Array(3_000_000).fill(0.1) }
    await expect(computePeaks(big, 600, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('barsFor', () => {
  const peaks = { values: Float32Array.from([0.1, 0.9, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]), durationMs: 800 }

  it('draws the whole sound in the bars it is given', () => {
    expect(Array.from(barsFor(peaks, 0, 800, 4))).toEqual([expect.closeTo(0.9), expect.closeTo(0.3), expect.closeTo(0.5), expect.closeTo(0.7)])
  })

  it('draws a part of it', () => {
    expect(Array.from(barsFor(peaks, 400, 800, 2))).toEqual([expect.closeTo(0.5), expect.closeTo(0.7)])
  })

  it('is flat for an empty sound', () => {
    expect(Array.from(barsFor({ values: new Float32Array(), durationMs: 0 }, 0, 100, 3))).toEqual([0, 0, 0])
  })
})

describe('peaksFromCatalogue', () => {
  it('turns 0-100 values into 0-1 peaks', () => {
    const p = peaksFromCatalogue([0, 50, 100, 250], 4000)
    expect(Array.from(p.values)).toEqual([0, 0.5, 1, 1])
    expect(p.durationMs).toBe(4000)
  })
})

describe('peaksFor', () => {
  it('computes once per key, also for simultaneous requests', async () => {
    clearPeakCache()
    let calls = 0
    const decode = async () => {
      calls++
      return pcm([Array.from({ length: 4000 }, (_, i) => Math.sin(i))])
    }
    const [a, b] = await Promise.all([peaksFor('k1', decode), peaksFor('k1', decode)])
    expect(a).toBe(b)
    await peaksFor('k1', decode)
    expect(calls).toBe(1)
    await peaksFor('k2', decode)
    expect(calls).toBe(2)
  })

  it('lets a failed decode be tried again', async () => {
    clearPeakCache()
    let n = 0
    const decode = async () => {
      if (n++ === 0) throw new Error('boom')
      return pcm([[0.5, 0.5]])
    }
    await expect(peaksFor('bad', decode)).rejects.toThrow('boom')
    await expect(peaksFor('bad', decode)).resolves.toMatchObject({ durationMs: 2 })
  })
})

describe('displayGain', () => {
  const peaks = (values: number[]) => ({ values: Float32Array.from(values), durationMs: 1000 })

  it('leaves a loud sound as it is and makes a quiet one readable', () => {
    expect(peakLevel(peaks([0.1, 0.9, 0.3]))).toBeCloseTo(0.9, 6)
    expect(displayGain(peaks([0.1, 1, 0.3]))).toBe(1)
    expect(displayGain(peaks([0.1, 0.5, 0.3]))).toBeCloseTo(2, 6)
  })

  it('never makes a near-silent sound loud', () => {
    expect(displayGain(peaks([0.01, 0.02]))).toBe(5)
    expect(displayGain(peaks([]))).toBe(5)
  })
})
