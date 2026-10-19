import { describe, expect, it } from 'vitest'
import { type Container, type ContainerSetup, createContainer, opusHead } from './container'
import { inspectMp4, inspectWebm } from './inspect'
import { bytesOf } from './testing'

/** A minimal AVCDecoderConfigurationRecord (the box a player reads the stream's parameters from). */
const avcC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x01, 0x00, 0x04, 0x68, 0xeb, 0xe3, 0xcb])
const bt709 = { fullRange: false, primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' } as const

const videoMeta = (family: ContainerSetup['family']): EncodedVideoChunkMetadata => ({
  decoderConfig: { codec: family === 'avc' ? 'avc1.640028' : family === 'av1' ? 'av01.0.04M.08' : 'vp09.00.30.08', codedWidth: 320, codedHeight: 180, colorSpace: bt709, ...(family === 'avc' ? { description: avcC } : {}) },
})

const FPS = 24

/** `seconds` of video as fake chunks: a keyframe every 2 s, the rest deltas, with exact timestamps. */
function addVideo(container: Container, family: ContainerSetup['family'], seconds: number): void {
  const frames = seconds * FPS
  for (let i = 0; i < frames; i++) {
    const key = i % (2 * FPS) === 0
    const data = new Uint8Array(key ? 400 : 60).fill(key ? 0x65 : 0x41)
    container.addVideo({ data, key, timestampUs: Math.round((i * 1e6) / FPS), durationUs: Math.round(((i + 1) * 1e6) / FPS) - Math.round((i * 1e6) / FPS) }, i === 0 ? videoMeta(family) : undefined)
  }
}

/** `seconds` of audio as 20 ms Opus-like chunks or 21.33 ms AAC-like chunks. */
function addAudio(container: Container, seconds: number, chunkUs: number): void {
  for (let at = 0; at < seconds * 1e6; at += chunkUs) container.addAudio({ data: new Uint8Array(40).fill(7), timestampUs: at, durationUs: chunkUs })
}

const setup = (over: Partial<ContainerSetup>): ContainerSetup => ({ kind: 'mp4', family: 'avc', width: 320, height: 180, fps: FPS, audio: null, ...over })

describe('MP4', () => {
  it('writes the boxes of an H.264 file: ftyp, an index before the media, one video track of the right size', async () => {
    const container = await createContainer(setup({}))
    addVideo(container, 'avc', 4)
    const bytes = await bytesOf(container.finish())
    const info = inspectMp4(bytes)
    expect(info.brands[0]).toBe('isom')
    expect(info.topLevel).toEqual(['ftyp', 'moov', 'mdat'])
    expect(info.fastStart).toBe(true)
    expect(info.tracks).toHaveLength(1)
    expect(info.tracks[0]).toMatchObject({ handler: 'vide', sampleEntry: 'avc1', width: 320, height: 180, samples: 96 })
    expect(info.durationMs).toBeCloseTo(4000, -1)
    // The codec's own configuration box is there, with the bytes the encoder gave.
    const at = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'avcC')
    expect(at).toBeGreaterThan(0)
    expect([...bytes.subarray(at + 4, at + 4 + avcC.length)]).toEqual([...avcC])
  })

  it('adds an AAC track beside the video, with the AudioSpecificConfig the encoder gave', async () => {
    const description = new Uint8Array([0x11, 0x90])
    const container = await createContainer(setup({ audio: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2, description } }))
    addVideo(container, 'avc', 2)
    addAudio(container, 2, 21_333)
    const info = inspectMp4(await bytesOf(container.finish()))
    expect(info.tracks.map((t) => [t.handler, t.sampleEntry])).toEqual([['vide', 'avc1'], ['soun', 'mp4a']])
    expect(info.tracks[1].samples).toBeGreaterThan(90)
    expect(info.tracks[1].durationMs).toBeCloseTo(2000, -2)
  })

  it('holds VP9 or AV1 video and Opus sound when H.264 and AAC are not there', async () => {
    const vp9 = await createContainer(setup({ family: 'vp9', audio: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 } }))
    addVideo(vp9, 'vp9', 1)
    addAudio(vp9, 1, 20_000)
    expect(inspectMp4(await bytesOf(vp9.finish())).tracks.map((t) => t.sampleEntry)).toEqual(['vp09', 'Opus'])
    const av1 = await createContainer(setup({ family: 'av1' }))
    addVideo(av1, 'av1', 1)
    expect(inspectMp4(await bytesOf(av1.finish())).tracks[0].sampleEntry).toBe('av01')
  })

  it('refuses a codec MP4 cannot hold', async () => {
    await expect(createContainer(setup({ family: 'vp8' }))).rejects.toThrow('VP8')
  })

  it('keeps the frame rate exact: 24 fps is 96 frames in 4 s, not 95 or 97', async () => {
    const container = await createContainer(setup({}))
    addVideo(container, 'avc', 4)
    const info = inspectMp4(await bytesOf(container.finish()))
    expect(info.tracks[0].samples).toBe(96)
    expect(info.tracks[0].durationMs).toBe(4000)
  })
})

describe('WebM', () => {
  it('writes an EBML header, a webm doctype, a VP9 track of the right size, clusters and a duration', async () => {
    const container = await createContainer(setup({ kind: 'webm', family: 'vp9' }))
    addVideo(container, 'vp9', 4)
    const bytes = await bytesOf(container.finish())
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    const info = inspectWebm(bytes)
    expect(info).toMatchObject({ valid: true, docType: 'webm', blocks: 96, hasCues: true })
    expect(info.tracks).toEqual([{ type: 'video', codec: 'V_VP9', width: 320, height: 180, hasCodecPrivate: false }])
    expect(info.clusters).toBeGreaterThanOrEqual(2)
    expect(info.durationMs).toBeCloseTo(4000, -2)
  })

  it('adds an Opus track with its identification header', async () => {
    const container = await createContainer(setup({ kind: 'webm', family: 'vp9', audio: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 } }))
    addVideo(container, 'vp9', 2)
    addAudio(container, 2, 20_000)
    const info = inspectWebm(await bytesOf(container.finish()))
    expect(info.tracks.map((t) => [t.type, t.codec])).toEqual([['video', 'V_VP9'], ['audio', 'A_OPUS']])
    expect(info.tracks[1].hasCodecPrivate).toBe(true)
    expect(info.blocks).toBeGreaterThan(48 + 90)
  })

  it('holds VP8 and AV1 too, and refuses H.264 and AAC', async () => {
    for (const [family, codec] of [['vp8', 'V_VP8'], ['av1', 'V_AV1']] as const) {
      const container = await createContainer(setup({ kind: 'webm', family }))
      addVideo(container, family, 1)
      expect(inspectWebm(await bytesOf(container.finish())).tracks[0].codec).toBe(codec)
    }
    await expect(createContainer(setup({ kind: 'webm', family: 'avc' }))).rejects.toThrow('H.264')
    await expect(createContainer(setup({ kind: 'webm', family: 'vp9', audio: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 } }))).rejects.toThrow('Opus')
  })
})

describe('opusHead', () => {
  it('is the 19-byte identification header of RFC 7845', () => {
    const head = opusHead(2, 48_000)
    expect(head).toHaveLength(19)
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe('OpusHead')
    expect(head[8]).toBe(1)
    expect(head[9]).toBe(2)
    expect(new DataView(head.buffer).getUint16(10, true)).toBe(312)
    expect(new DataView(head.buffer).getUint32(12, true)).toBe(48_000)
    expect(head[18]).toBe(0)
  })
})
