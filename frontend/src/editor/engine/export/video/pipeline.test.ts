import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocPage, DoryDocument } from '@/types/document'
import type { EncodedAudio } from '../../../audio/encoder'
import type { LoadContext } from '../../serialization'
import type { CodecApi } from './codecs'
import { VideoExportError } from './errors'
import { inspectGif, inspectMp4, inspectWebm } from './inspect'
import { defaultVideoOptions, type VideoOptions } from './options'
import { prepare, runVideoExport } from './pipeline'
import { frameTimestampUs } from './schedule'
import { bytesOf, doc, page, rect } from './testing'
import type { Deps, VideoJob, VideoProgress } from './types'

const loadContext: LoadContext = { resolveSrc: async (s) => s, ensureFonts: async () => undefined }

/* ---- a browser without WebCodecs: the parts the pipeline calls, recording what it was given ---- */

interface Seen {
  timestamp: number
  duration: number
  key: boolean
  /** Colour of a few pixels of the frame: the centre, and near the top-left corner. */
  centre: number[]
  corner: number[]
}

const avcC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x01, 0x00, 0x04, 0x68, 0xeb, 0xe3, 0xcb])

const state = { seen: [] as Seen[], opened: 0, closedEncoders: 0, closedFrames: 0, configured: null as VideoEncoderConfig | null, failAt: -1, maxQueue: 0 }

class FakeVideoFrame {
  readonly timestamp: number
  readonly duration: number
  readonly centre: number[]
  readonly corner: number[]
  constructor(source: HTMLCanvasElement, init: { timestamp: number; duration: number }) {
    this.timestamp = init.timestamp
    this.duration = init.duration
    const ctx = source.getContext('2d')!
    this.centre = [...ctx.getImageData(Math.floor(source.width / 2), Math.floor(source.height / 2), 1, 1).data]
    this.corner = [...ctx.getImageData(6, 6, 1, 1).data]
  }
  close(): void {
    state.closedFrames += 1
  }
}

class FakeVideoEncoder {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured'
  encodeQueueSize = 0
  private first = true
  private encoded = 0
  constructor(private readonly init: VideoEncoderInit) {
    state.opened += 1
  }
  configure(config: VideoEncoderConfig): void {
    state.configured = config
    this.state = 'configured'
  }
  encode(frame: FakeVideoFrame, options?: VideoEncoderEncodeOptions): void {
    state.seen.push({ timestamp: frame.timestamp, duration: frame.duration, key: options?.keyFrame === true, centre: frame.centre, corner: frame.corner })
    this.encodeQueueSize += 1
    state.maxQueue = Math.max(state.maxQueue, this.encodeQueueSize)
    const index = this.encoded++
    const first = this.first
    this.first = false
    queueMicrotask(() => {
      this.encodeQueueSize -= 1
      if (state.failAt === index) {
        this.init.error(Object.assign(new Error('The encoder broke'), { name: 'EncodingError' }) as unknown as DOMException)
        return
      }
      const data = new Uint8Array(options?.keyFrame ? 300 : 40).fill(options?.keyFrame ? 0x65 : 0x41)
      const chunk = { type: options?.keyFrame ? 'key' : 'delta', timestamp: frame.timestamp, duration: frame.duration, byteLength: data.length, copyTo: (target: Uint8Array) => target.set(data) }
      const meta = first ? { decoderConfig: { codec: state.configured!.codec, codedWidth: 100, codedHeight: 100, description: avcC, colorSpace: { fullRange: false, primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' } } } : undefined
      this.init.output(chunk as unknown as EncodedVideoChunk, meta as EncodedVideoChunkMetadata)
    })
  }
  async flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  close(): void {
    this.state = 'closed'
    state.closedEncoders += 1
  }
  addEventListener(_type: string, listener: () => void): void {
    queueMicrotask(listener)
  }
}

const codecs = (over: Partial<CodecApi> = {}): CodecApi => ({
  hasVideoEncoder: () => true,
  videoSupported: async (config) => config.codec.startsWith('avc1') || config.codec.startsWith('vp09'),
  audioCodec: async () => true,
  recorderType: () => false,
  hasRecorder: () => false,
  ...over,
})

const encodedSound = (seconds: number): EncodedAudio => ({
  requested: 'aac',
  format: 'aac',
  mime: 'audio/mp4; codecs="mp4a.40.2"',
  codec: 'mp4a.40.2',
  sampleRate: 48_000,
  numberOfChannels: 2,
  durationMs: seconds * 1000,
  description: new Uint8Array([0x11, 0x90]),
  chunks: Array.from({ length: Math.floor((seconds * 1e6) / 21_333) }, (_, i) => ({ data: new Uint8Array(30).fill(9), timestampUs: i * 21_333, durationUs: 21_333 })),
})

beforeEach(() => {
  Object.assign(state, { seen: [], opened: 0, closedEncoders: 0, closedFrames: 0, configured: null, failAt: -1, maxQueue: 0 })
  vi.stubGlobal('VideoEncoder', FakeVideoEncoder)
  vi.stubGlobal('VideoFrame', FakeVideoFrame)
})
afterEach(() => vi.unstubAllGlobals())

/* ---- a design: a red page for 1 s, then a blue page that fades in over 1 s and stays 1 s ---- */

const red: DocPage = page('red', { durationSec: 1, background: { type: 'solid', color: '#ff0000' } })
const blue: DocPage = page('blue', { durationSec: 1, background: { type: 'solid', color: '#0000ff' }, transition: { preset: 'fade', durationMs: 1000, easing: 'linear' } })
const design = (): DoryDocument => doc([red, blue])

function job(over: Omit<Partial<VideoJob>, 'options'> & { options?: Partial<VideoOptions> } = {}): VideoJob {
  const document = over.document ?? design()
  return {
    host: { loadContext, loadSound: async () => { throw new Error('no sound expected') } },
    document,
    pages: document.pages.map((p, index) => ({ page: p, index })),
    title: 'My Design',
    signal: new AbortController().signal,
    deps: { codecs: codecs(), now: () => performance.now() },
    ...over,
    options: { ...defaultVideoOptions('mp4'), resolution: 'design', fps: 24, audio: false, ...over.options },
  }
}

describe('prepare', () => {
  it('works out the timeline, the frame and the number of frames', () => {
    const document = design()
    const prepared = prepare(document, document.pages.map((p, index) => ({ page: p, index })), { ...defaultVideoOptions('mp4'), fps: 24 })
    expect(prepared.timeline.totalMs).toBe(3000)
    expect(prepared.frame).toEqual({ width: 100, height: 100 })
    expect(prepared.frames).toBe(72)
    expect(prepared.hasSound).toBe(false)
  })

  it('refuses options the format does not offer, no pages, and a video that is too long', () => {
    const document = design()
    const pages = document.pages.map((p, index) => ({ page: p, index }))
    const fail = (fn: () => unknown): string => {
      try {
        fn()
      } catch (error) {
        return (error as VideoExportError).code
      }
      return 'none'
    }
    expect(fail(() => prepare(document, pages, { ...defaultVideoOptions('gif'), fps: 60 }))).toBe('invalid-options')
    expect(fail(() => prepare(document, [], defaultVideoOptions('mp4')))).toBe('no-pages')
    expect(fail(() => prepare(document, pages, { ...defaultVideoOptions('mp4'), pageSeconds: 600 }))).toBe('too-long')
    expect(fail(() => prepare(document, pages, { ...defaultVideoOptions('gif'), pageSeconds: 100 }))).toBe('too-long')
  })

  it('counts sound only for a video whose design has an audible track', () => {
    const document = { ...design(), audioTracks: [{ id: 't', kind: 'music', name: 'm', src: '/x.ogg', scope: { type: 'design' }, startMs: 0, trimStartMs: 0, trimEndMs: 5000, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false, muted: false }] } as DoryDocument
    const pages = document.pages.map((p, index) => ({ page: p, index }))
    expect(prepare(document, pages, { ...defaultVideoOptions('mp4'), audio: true }).hasSound).toBe(true)
    expect(prepare(document, pages, { ...defaultVideoOptions('mp4'), audio: false }).hasSound).toBe(false)
    expect(prepare(document, pages, { ...defaultVideoOptions('gif') }).hasSound).toBe(false)
    const muted = { ...document, audioTracks: [{ ...document.audioTracks![0], muted: true }] }
    expect(prepare(muted, pages, defaultVideoOptions('mp4')).hasSound).toBe(false)
  })
})

describe('an MP4 export', () => {
  it('draws every frame at its exact time and hands it to the encoder, closing each', async () => {
    const result = await runVideoExport(job())
    expect(state.seen).toHaveLength(72)
    expect(state.closedFrames).toBe(72)
    expect(state.seen.map((f) => f.timestamp)).toEqual(Array.from({ length: 72 }, (_, i) => frameTimestampUs(i, 24)))
    // Every frame lasts until the next starts; together they cover the whole video.
    const last = state.seen[71]
    expect(last.timestamp + last.duration).toBe(3_000_000)
    expect(result).toMatchObject({ format: 'mp4', width: 100, height: 100, fps: 24, frames: 72, durationMs: 3000, filename: 'My-Design.mp4', video: 'H.264', audio: null, warnings: [] })
  })

  it('asks for a keyframe every two seconds and for the codec the plan chose, sized and timed as the frames are', async () => {
    await runVideoExport(job())
    expect(state.seen.filter((f) => f.key).map((f) => f.timestamp)).toEqual([0, 2_000_000])
    expect(state.configured).toMatchObject({ width: 100, height: 100, framerate: 24, avc: { format: 'avc' } })
    expect(state.configured?.codec).toMatch(/^avc1\./)
  })

  it('shows the first page, then the cross-fade into the second, then the second', async () => {
    await runVideoExport(job())
    // 24 fps: frames 0-23 are the red page (1 s), 24-47 the fade (1 s), 48-71 the blue page.
    expect(state.seen[0].centre.slice(0, 3)).toEqual([255, 0, 0])
    expect(state.seen[23].centre.slice(0, 3)).toEqual([255, 0, 0])
    expect(state.seen[24].centre.slice(0, 3)).toEqual([255, 0, 0])
    const middle = state.seen[36].centre
    expect(middle[0]).toBeGreaterThan(100)
    expect(middle[0]).toBeLessThan(155)
    expect(middle[2]).toBeGreaterThan(100)
    expect(middle[2]).toBeLessThan(155)
    // The fade moves one way only.
    const reds = state.seen.slice(24, 48).map((f) => f.centre[0])
    expect([...reds].sort((a, b) => b - a)).toEqual(reds)
    expect(state.seen[48].centre.slice(0, 3)).toEqual([0, 0, 255])
    expect(state.seen[71].centre.slice(0, 3)).toEqual([0, 0, 255])
  })

  it('writes an MP4 with an H.264 track of the right size, as many samples as frames, and the right length', async () => {
    const result = await runVideoExport(job())
    const info = inspectMp4(await bytesOf(result.blob))
    expect(info.fastStart).toBe(true)
    expect(info.tracks).toHaveLength(1)
    expect(info.tracks[0]).toMatchObject({ handler: 'vide', sampleEntry: 'avc1', width: 100, height: 100, samples: 72 })
    expect(info.durationMs).toBeCloseTo(3000, -1)
  })

  it('holds the encoder\'s queue short instead of piling frames up', async () => {
    await runVideoExport(job())
    expect(state.maxQueue).toBeLessThanOrEqual(6)
  })

  it('reports progress that only goes forward, ends at 100 % and names the stage', async () => {
    const seen: VideoProgress[] = []
    await runVideoExport(job({ onProgress: (p) => seen.push(p) }))
    expect(seen.length).toBeGreaterThan(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i].fraction).toBeGreaterThanOrEqual(seen[i - 1].fraction)
    expect(seen.at(-1)).toMatchObject({ stage: 'finishing', fraction: 1, frame: 72, frames: 72 })
    expect(seen.some((p) => p.stage === 'frames' && p.frames === 72)).toBe(true)
  })

  /** A 16:9 page, then a square one that is one red rectangle on a green page. */
  const mixedDesign = (): DoryDocument => {
    const wide = page('wide', { durationSec: 1, background: { type: 'solid', color: '#0000ff' } })
    const square = page('square', { durationSec: 1, width: 200, height: 200, background: { type: 'solid', color: '#00ff00' }, objects: [{ ...rect('r'), left: 100, top: 100, width: 200, height: 200, fill: '#ff0000' }] })
    return doc([wide, square], 192, 108)
  }

  it('letterboxes a page of another shape in the frame, with bars in the page\'s colour', async () => {
    const document = mixedDesign()
    const result = await runVideoExport(job({ document }))
    expect(result).toMatchObject({ width: 192, height: 108 })
    // The second page starts at frame 24. Fit: the square page is 108 px wide in the middle, the bars are the page's green.
    expect(state.seen[24].corner.slice(0, 3)).toEqual([0, 255, 0])
    expect(state.seen[24].centre.slice(0, 3)).toEqual([255, 0, 0])
    expect(state.seen[0].corner.slice(0, 3)).toEqual([0, 0, 255])
  })

  it('fills the frame with a page of another shape when asked, cropping it', async () => {
    await runVideoExport(job({ document: mixedDesign(), options: { fit: 'fill' } }))
    expect(state.seen[24].corner.slice(0, 3)).toEqual([255, 0, 0])
    expect(state.seen[24].centre.slice(0, 3)).toEqual([255, 0, 0])
  })

  it('exports only the chosen pages, in the order given', async () => {
    const document = design()
    const result = await runVideoExport(job({ document, pages: [{ page: document.pages[1], index: 1 }] }))
    // A single page has no page before it, so its transition does not play: 1 s of the blue page.
    expect(result.durationMs).toBe(1000)
    expect(state.seen).toHaveLength(24)
    expect(state.seen[0].centre.slice(0, 3)).toEqual([0, 0, 255])
  })

  it('holds a page for the fixed time the person chose', async () => {
    const result = await runVideoExport(job({ options: { pageSeconds: 2 } }))
    expect(result.durationMs).toBe(2000 + 1000 + 2000)
  })
})

describe('sound', () => {
  const withTrack = (): DoryDocument =>
    ({ ...design(), audioTracks: [{ id: 't', kind: 'music', name: 'm', src: '/x.ogg', scope: { type: 'design' }, startMs: 0, trimStartMs: 0, trimEndMs: 5000, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: true, muted: false }] }) as DoryDocument

  it('mixes the design over the pages\' slots, encodes it and puts an AAC track beside the video', async () => {
    const mix = vi.fn(async (..._args: unknown[]) => ({}) as AudioBuffer)
    const encodeSound = vi.fn(async (..._args: unknown[]) => encodedSound(3))
    const result = await runVideoExport(job({ document: withTrack(), options: { audio: true }, deps: { codecs: codecs(), mix: mix as unknown as Deps['mix'], encodeSound: encodeSound as unknown as Deps['encodeSound'], now: () => performance.now() } }))
    expect(mix).toHaveBeenCalledOnce()
    expect(mix.mock.calls[0][1]).toEqual([1000, 2000])
    expect(mix.mock.calls[0][2]).toBe(48_000)
    expect(encodeSound.mock.calls[0][1]).toBe('aac')
    const info = inspectMp4(await bytesOf(result.blob))
    expect(info.tracks.map((t) => t.sampleEntry)).toEqual(['avc1', 'mp4a'])
    expect(info.tracks[1].samples).toBe(encodedSound(3).chunks.length)
    expect(result.audio).toBe('AAC')
  })

  it('makes a WebM with Opus', async () => {
    const result = await runVideoExport(
      job({
        document: withTrack(),
        options: { format: 'webm', audio: true },
        deps: { codecs: codecs(), mix: async () => ({}) as AudioBuffer, encodeSound: async () => ({ ...encodedSound(3), requested: 'opus', format: 'opus', codec: 'opus', description: undefined }), now: () => performance.now() },
      }),
    )
    const info = inspectWebm(await bytesOf(result.blob))
    expect(info.tracks.map((t) => t.codec)).toEqual(['V_VP9', 'A_OPUS'])
    expect(result.audio).toBe('Opus')
  })

  it('goes on without sound, and says so, when the browser handed back a WAVE file instead of a codec', async () => {
    const result = await runVideoExport(job({ document: withTrack(), options: { audio: true }, deps: { codecs: codecs(), mix: async () => ({}) as AudioBuffer, encodeSound: async () => ({ ...encodedSound(3), format: 'wav' }), now: () => performance.now() } }))
    expect(result.audio).toBeNull()
    expect(result.warnings).toContain('no-audio')
    expect(inspectMp4(await bytesOf(result.blob)).tracks).toHaveLength(1)
  })

  it('says so when this browser has no audio encoder at all, and still makes the video', async () => {
    const result = await runVideoExport(job({ document: withTrack(), options: { audio: true }, deps: { codecs: codecs({ audioCodec: async () => false }), now: () => performance.now() } }))
    expect(result.warnings).toEqual(['no-audio'])
    expect(result.audio).toBeNull()
  })

  it('does not mix anything for a design without sound', async () => {
    const mix = vi.fn()
    await runVideoExport(job({ options: { audio: true }, deps: { codecs: codecs(), mix, now: () => performance.now() } }))
    expect(mix).not.toHaveBeenCalled()
  })
})

describe('what the browser can do', () => {
  it('uses VP9 inside the MP4 when there is no H.264 encoder, and warns', async () => {
    const result = await runVideoExport(job({ deps: { codecs: codecs({ videoSupported: async (c) => c.codec.startsWith('vp09') }), now: () => performance.now() } }))
    expect(result).toMatchObject({ video: 'VP9', warnings: ['video-fallback'] })
    expect(inspectMp4(await bytesOf(result.blob)).tracks[0].sampleEntry).toBe('vp09')
  })

  it('says the browser cannot make video when it has no encoder and no recorder', async () => {
    await expect(runVideoExport(job({ deps: { codecs: codecs({ hasVideoEncoder: () => false }), now: () => performance.now() } }))).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('cancel and failure', () => {
  it('stops at the next frame when cancelled, closes the encoder, and produces nothing', async () => {
    const controller = new AbortController()
    let frames = 0
    let clock = 0
    const promise = runVideoExport(
      job({
        signal: controller.signal,
        deps: { codecs: codecs(), now: () => (clock += 150) },
        onProgress: (p) => {
          frames = p.frame
          if (p.frame >= 10) controller.abort()
        },
      }),
    )
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(frames).toBeLessThan(72)
    expect(state.seen.length).toBeLessThan(72)
    expect(state.closedEncoders).toBe(1)
    expect(state.closedFrames).toBe(state.seen.length)
  })

  it('does not start when it is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runVideoExport(job({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.opened).toBe(0)
  })

  it('names an encoder that fails part-way, and closes it', async () => {
    state.failAt = 20
    await expect(runVideoExport(job())).rejects.toMatchObject({ code: 'encoder' })
    expect(state.closedEncoders).toBe(1)
  })

  it('maps a browser that is out of memory to a memory error', async () => {
    vi.stubGlobal(
      'VideoEncoder',
      class extends FakeVideoEncoder {
        override encode(): void {
          throw new RangeError('Array buffer allocation failed')
        }
      },
    )
    await expect(runVideoExport(job())).rejects.toMatchObject({ code: 'memory' })
  })

  it('rejects a bad setting before anything is made', async () => {
    await expect(runVideoExport(job({ options: { fps: 25 } }))).rejects.toMatchObject({ code: 'invalid-options' })
    expect(state.opened).toBe(0)
  })
})

describe('a GIF export', () => {
  const gifOptions: Partial<VideoOptions> = { format: 'gif', resolution: 240, fps: 10, loops: 0, dither: false }

  it('stores a still page as one frame with the whole page time as its delay, and adds up to the length of the design', async () => {
    const result = await runVideoExport(job({ options: gifOptions }))
    const info = inspectGif(await bytesOf(result.blob))
    expect(result).toMatchObject({ format: 'gif', mime: 'image/gif', filename: 'My-Design.gif', video: 'GIF', audio: null })
    expect(info.width).toBe(result.width)
    expect(info.totalCs).toBe(300)
    expect(info.loop).toBe(0)
    // The red page for 1 s is one frame, and the first frame of the fade still shows it, so that frame is held for 1.1 s; the other nine
    // frames of the fade are one each; the blue page for 1 s is one frame.
    expect(info.frames).toBe(11)
    expect(info.delaysCs).toEqual([110, 10, 10, 10, 10, 10, 10, 10, 10, 10, 100])
    expect(result.frames).toBe(11)
  })

  it('does not need a video encoder at all', async () => {
    vi.unstubAllGlobals()
    const result = await runVideoExport(job({ options: gifOptions }))
    expect(result.format).toBe('gif')
  })

  it('plays once when asked: no loop block', async () => {
    const result = await runVideoExport(job({ options: { ...gifOptions, loops: 1 } }))
    expect(inspectGif(await bytesOf(result.blob)).loop).toBeNull()
  })

  it('can be cancelled between frames', async () => {
    const controller = new AbortController()
    let clock = 0
    await expect(runVideoExport(job({ options: gifOptions, signal: controller.signal, deps: { codecs: codecs(), now: () => (clock += 150) }, onProgress: (p) => p.frame >= 5 && controller.abort() }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports the bytes so far', async () => {
    const seen: VideoProgress[] = []
    await runVideoExport(job({ options: gifOptions, onProgress: (p) => seen.push(p) }))
    expect(seen.at(-1)?.bytes).toBeGreaterThan(100)
  })
})
