import { beforeAll, describe, expect, it } from 'vitest'
import { inspectWebm } from './inspect'
import { bytesOf } from './testing'
import { patchWebmDuration, withDuration } from './webmDuration'

// jsdom's Blob has no arrayBuffer(); the browsers all do.
beforeAll(() => {
  if (typeof Blob.prototype.arrayBuffer !== 'function') Blob.prototype.arrayBuffer = function (this: Blob) { return bytesOf(this).then((bytes) => bytes.buffer as ArrayBuffer) }
})

/** An element: id bytes, a one-byte size (fine up to 126), payload. */
const el = (id: number[], payload: number[]): number[] => [...id, 0x80 | payload.length, ...payload]
const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [...el([0x42, 0x82], [...'webm'].map((c) => c.charCodeAt(0)))])
const timecodeScale = el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])
const info = (extra: number[] = []): number[] => el([0x15, 0x49, 0xa9, 0x66], [...timecodeScale, ...el([0x4d, 0x80], [0x61, 0x62]), ...extra])
const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], [...el([0x86], [...'V_VP8'].map((c) => c.charCodeAt(0))), ...el([0x83], [1])]))
const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], [0]))
/** A recording as Chromium writes it: a Segment of unknown size, no SeekHead, an Info without a duration. */
const live = (): Uint8Array => new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info(), ...tracks, ...cluster])

describe('withDuration', () => {
  it('puts a Duration of the right length into the Info element of a live recording and leaves the rest as it was', async () => {
    const original = live()
    const patched = withDuration(original, 21_500)
    expect(patched).not.toBeNull()
    const file = new Uint8Array([...patched!.bytes, ...original.subarray(patched!.end)])
    const after = inspectWebm(file)
    expect(after.durationMs).toBeCloseTo(21_500, 3)
    expect(after.tracks[0].codec).toBe('V_VP8')
    expect(after.clusters).toBe(1)
    expect(file.length).toBe(original.length + 11)
  })

  it('scales the duration by the file\'s timecode scale', () => {
    const scaled = new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], [0x00, 0x0f, 0x42, 0x40, 0x00].slice(0, 4))), ...tracks])
    const patched = withDuration(scaled, 2000)!
    const file = new Uint8Array([...patched.bytes, ...scaled.subarray(patched.end)])
    expect(inspectWebm(file).durationMs).toBeCloseTo(2000, 3)
  })

  it('grows a Segment whose size is known by what it added', () => {
    const body = [...info(), ...tracks, ...cluster]
    const known = new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, 0x80 | body.length, ...body])
    const patched = withDuration(known, 1000)!
    const file = new Uint8Array([...patched.bytes, ...known.subarray(patched.end)])
    expect(file[ebml.length + 4]).toBe(0x80 | (body.length + 11))
    expect(inspectWebm(file).durationMs).toBeCloseTo(1000, 3)
  })

  it('leaves a file alone that already has a duration, has an index to keep right, or is not a WebM', () => {
    expect(withDuration(new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info(el([0x44, 0x89], [0x40, 0x59, 0, 0, 0, 0, 0, 0]))]), 5000)).toBeNull()
    expect(withDuration(new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...el([0x11, 0x4d, 0x9b, 0x74], [0x00]), ...info()]), 5000)).toBeNull()
    expect(withDuration(new Uint8Array([1, 2, 3, 4, 5, 6]), 5000)).toBeNull()
    expect(withDuration(new Uint8Array(0), 5000)).toBeNull()
  })

  it('does not read past a truncated head', () => {
    expect(withDuration(live().subarray(0, 30), 5000)).toBeNull()
  })
})

describe('patchWebmDuration', () => {
  it('returns a Blob with the duration and the clusters after the head intact', async () => {
    const original = live()
    const blob = await patchWebmDuration(new Blob([original as Uint8Array<ArrayBuffer>], { type: 'video/webm' }), 12_345)
    const bytes = await bytesOf(blob)
    expect(blob.type).toBe('video/webm')
    expect(inspectWebm(bytes).durationMs).toBeCloseTo(12_345, 3)
    expect([...bytes.subarray(bytes.length - cluster.length)]).toEqual(cluster)
  })

  it('returns the same Blob when there is nothing to patch', async () => {
    const blob = new Blob(['not a webm'])
    expect(await patchWebmDuration(blob, 1000)).toBe(blob)
    expect(await patchWebmDuration(new Blob([live() as Uint8Array<ArrayBuffer>]), 0)).toBeInstanceOf(Blob)
  })
})
