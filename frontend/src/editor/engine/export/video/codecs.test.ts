import { describe, expect, it } from 'vitest'
import { type CodecApi, av1Codec, avcCodec, detectCapabilities, planAudio, planEncoding, vp9Codec } from './codecs'

/** A browser that can encode exactly what `video` and `audio` list (by codec string prefix). */
function browser(over: { video?: string[]; audio?: ('aac' | 'opus')[]; encoder?: boolean; recorder?: string[] } = {}): CodecApi & { asked: string[] } {
  const video = over.video ?? []
  const asked: string[] = []
  return {
    asked,
    hasVideoEncoder: () => over.encoder ?? true,
    videoSupported: async (config) => {
      asked.push(config.codec)
      return video.some((prefix) => config.codec.startsWith(prefix))
    },
    audioCodec: async (format) => (over.audio ?? []).includes(format),
    recorderType: (mime) => (over.recorder ?? []).includes(mime),
    hasRecorder: () => (over.recorder ?? []).length > 0,
  }
}

const input = { format: 'mp4' as const, size: { width: 1920, height: 1080 }, fps: 30, quality: 'balanced' as const, audio: true }

describe('codec strings', () => {
  it('names the H.264 level a frame needs', () => {
    expect(avcCodec('high', { width: 640, height: 360 }, 30)).toBe('avc1.64001e')
    expect(avcCodec('high', { width: 1280, height: 720 }, 30)).toBe('avc1.64001f')
    expect(avcCodec('high', { width: 1920, height: 1080 }, 30)).toBe('avc1.640028')
    expect(avcCodec('high', { width: 1920, height: 1080 }, 60)).toBe('avc1.64002a')
    expect(avcCodec('main', { width: 3840, height: 2160 }, 30)).toBe('avc1.4d0033')
    expect(avcCodec('baseline', { width: 854, height: 480 }, 24)).toBe('avc1.42e01e')
  })

  it('names the VP9 and AV1 levels', () => {
    expect(vp9Codec({ width: 854, height: 480 }, 30)).toBe('vp09.00.30.08')
    expect(vp9Codec({ width: 1920, height: 1080 }, 30)).toBe('vp09.00.40.08')
    expect(vp9Codec({ width: 3840, height: 2160 }, 30)).toBe('vp09.00.50.08')
    expect(av1Codec({ width: 1920, height: 1080 }, 30)).toBe('av01.0.08M.08')
    expect(av1Codec({ width: 3840, height: 2160 }, 60)).toBe('av01.0.13M.08')
  })

  it('uses the largest level for a frame no level holds instead of failing', () => {
    expect(avcCodec('high', { width: 8192, height: 8192 }, 60)).toBe('avc1.640034')
  })
})

describe('planEncoding', () => {
  it('uses H.264 and AAC for MP4 when the browser has both', async () => {
    const api = browser({ video: ['avc1'], audio: ['aac', 'opus'] })
    const plan = await planEncoding(input, api)
    expect(plan).toMatchObject({ engine: 'webcodecs', video: { family: 'avc', label: 'H.264' }, audio: { format: 'aac' }, notes: [] })
    if (plan.engine === 'webcodecs') expect(plan.video.config).toMatchObject({ width: 1920, height: 1080, framerate: 30, avc: { format: 'avc' } })
  })

  it('tries the H.264 profiles best first and stops at the first the browser accepts', async () => {
    const api = browser({ video: ['avc1.42e0'], audio: ['aac'] })
    const plan = await planEncoding(input, api)
    expect(api.asked).toEqual(['avc1.640028', 'avc1.4d0028', 'avc1.42e028'])
    expect(plan).toMatchObject({ engine: 'webcodecs', video: { family: 'avc', codec: 'avc1.42e028' }, notes: [] })
  })

  it('falls back to VP9 in the MP4 when there is no H.264 encoder, and says so', async () => {
    const plan = await planEncoding(input, browser({ video: ['vp09'], audio: ['opus'] }))
    expect(plan).toMatchObject({ engine: 'webcodecs', video: { family: 'vp9', label: 'VP9' }, audio: { format: 'opus' }, notes: ['video-fallback', 'audio-fallback'] })
  })

  it('falls back to AV1 when it is all there is', async () => {
    const plan = await planEncoding(input, browser({ video: ['av01'] }))
    expect(plan).toMatchObject({ engine: 'webcodecs', video: { family: 'av1' }, audio: null, notes: ['video-fallback', 'no-audio'] })
  })

  it('makes WebM with VP9 and Opus first, VP8 then AV1 after', async () => {
    expect(await planEncoding({ ...input, format: 'webm' }, browser({ video: ['vp09', 'vp8'], audio: ['opus'] }))).toMatchObject({ video: { family: 'vp9' }, audio: { format: 'opus' }, notes: [] })
    expect(await planEncoding({ ...input, format: 'webm' }, browser({ video: ['vp8'], audio: ['opus'] }))).toMatchObject({ video: { family: 'vp8' }, notes: ['video-fallback'] })
    expect(await planEncoding({ ...input, format: 'webm' }, browser({ video: ['av01'], audio: ['opus'] }))).toMatchObject({ video: { family: 'av1' }, notes: ['video-fallback'] })
  })

  it('asks for no sound when the design has none', async () => {
    const plan = await planEncoding({ ...input, audio: false }, browser({ video: ['avc1'], audio: ['aac'] }))
    expect(plan).toMatchObject({ audio: null, notes: [] })
  })

  it('says so when the browser has no audio encoder at all', async () => {
    const plan = await planEncoding(input, browser({ video: ['avc1'] }))
    expect(plan).toMatchObject({ audio: null, notes: ['no-audio'] })
  })

  it('records in real time when there is no video encoder but there is a recorder', async () => {
    const api = browser({ encoder: false, recorder: ['video/webm;codecs=vp9,opus'] })
    expect(await planEncoding({ ...input, format: 'webm' }, api)).toEqual({ engine: 'recorder', mime: 'video/webm;codecs=vp9,opus', notes: [] })
  })

  it('records when an encoder exists but accepts none of the codecs and a recorder is there', async () => {
    const api = browser({ video: [], recorder: ['video/mp4'] })
    expect(await planEncoding(input, api)).toMatchObject({ engine: 'recorder', mime: 'video/mp4' })
  })

  it('has no plan when the browser can do neither, and says which of the two it lacks', async () => {
    expect(await planEncoding(input, browser({ encoder: false }))).toEqual({ engine: 'none', reason: 'no-encoder' })
    expect(await planEncoding(input, browser({ video: [] }))).toEqual({ engine: 'none', reason: 'no-codec' })
  })

  it('gives the encoder a bitrate that follows the codec and the quality', async () => {
    const small = await planEncoding({ ...input, quality: 'small' }, browser({ video: ['avc1'] }))
    const high = await planEncoding({ ...input, quality: 'high' }, browser({ video: ['avc1'] }))
    if (small.engine !== 'webcodecs' || high.engine !== 'webcodecs') throw new Error('expected plans')
    expect(high.video.config.bitrate).toBeGreaterThan(small.video.config.bitrate ?? 0)
  })
})

describe('planAudio and the capability table', () => {
  it('prefers AAC for MP4 and takes only Opus for WebM', async () => {
    expect(await planAudio('mp4', browser({ audio: ['aac', 'opus'] }))).toEqual({ format: 'aac', label: 'AAC' })
    expect(await planAudio('mp4', browser({ audio: ['opus'] }))).toEqual({ format: 'opus', label: 'Opus' })
    expect(await planAudio('webm', browser({ audio: ['aac'] }))).toBeNull()
  })

  it('tabulates what a browser makes of each container', async () => {
    const chromium = await detectCapabilities(browser({ video: ['vp09', 'vp8', 'av01'], audio: ['opus'], recorder: ['video/webm'] }))
    expect(chromium).toEqual({
      webCodecs: true,
      recorder: true,
      mp4: { engine: 'webcodecs', video: 'VP9', audio: 'Opus', notes: ['video-fallback', 'audio-fallback'] },
      webm: { engine: 'webcodecs', video: 'VP9', audio: 'Opus', notes: [] },
    })
    const firefoxOld = await detectCapabilities(browser({ encoder: false, recorder: ['video/webm'] }))
    expect(firefoxOld).toMatchObject({ webCodecs: false, mp4: { engine: null }, webm: { engine: 'recorder', video: 'video/webm' } })
  })
})
