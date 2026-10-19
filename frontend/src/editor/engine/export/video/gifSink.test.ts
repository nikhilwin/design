import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGifWriter, type GifWriter } from './gif'
import { type GifReply, type GifRequest, GifTooLargeError } from './gifProtocol'
import { type WorkerLike, createGifSink } from './gifSink'
import { inspectGif } from './inspect'
import { bytesOf } from './testing'

const setup = { width: 8, height: 6, loops: 0, dither: false, maxBytes: 10_000_000 }
const solid = (r: number, g: number, b: number): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(8 * 6 * 4)
  for (let i = 0; i < 48; i++) out.set([r, g, b, 255], i * 4)
  return out
}

/** A worker that runs the real writer in the same thread, a task after each message, the way the real one answers. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<GifReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  maxInFlight = 0
  private inFlight = 0
  private writer: GifWriter | null = null
  constructor(private readonly limit = Number.POSITIVE_INFINITY) {}
  postMessage(message: GifRequest): void {
    if (message.type === 'frame') {
      this.inFlight += 1
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    }
    setTimeout(() => this.handle(message), 1)
  }
  private reply(message: GifReply): void {
    this.onmessage?.({ data: message } as MessageEvent<GifReply>)
  }
  private handle(message: GifRequest): void {
    if (this.terminated) return
    try {
      if (message.type === 'init') {
        this.writer = createGifWriter({ ...message.setup, maxBytes: Math.min(message.setup.maxBytes, this.limit) })
        this.reply({ type: 'ready' })
      } else if (message.type === 'frame') {
        this.inFlight -= 1
        this.writer!.push(new Uint8ClampedArray(message.pixels), message.delayCs, true)
        this.reply({ type: 'ack', bytes: this.writer!.bytes, frames: this.writer!.frames })
      } else if (message.type === 'extend') this.writer!.extend(message.delayCs)
      else {
        const frames = this.writer!.frames
        const bytes = this.writer!.finishBytes()
        this.reply({ type: 'done', buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, frames })
      }
    } catch (error) {
      this.reply({ type: 'error', kind: error instanceof GifTooLargeError ? 'too-large' : 'failed', message: (error as Error).message })
    }
  }
  terminate(): void {
    this.terminated = true
  }
}

afterEach(() => vi.useRealTimers())

describe('the GIF sink with a worker', () => {
  it('writes the same file through the worker as the writer does by itself', async () => {
    const worker = new FakeWorker()
    const sink = await createGifSink(setup, () => worker)
    await sink.push(solid(255, 0, 0), 7)
    sink.extend(30)
    await sink.push(solid(0, 255, 0), 6)
    const { blob, frames } = await sink.finish()
    const info = inspectGif(await bytesOf(blob))
    expect(frames).toBe(2)
    expect(info).toMatchObject({ frames: 2, delaysCs: [37, 6], loop: 0, width: 8, height: 6 })
    sink.dispose()
    expect(worker.terminated).toBe(true)
  })

  it('holds the frames in flight to a few: a slow worker makes the caller wait instead of piling frames up', async () => {
    const worker = new FakeWorker()
    const sink = await createGifSink(setup, () => worker)
    for (let i = 0; i < 12; i++) await sink.push(solid(i * 20, 0, 0), 5)
    expect(worker.maxInFlight).toBeLessThanOrEqual(3)
    const { frames } = await sink.finish()
    expect(frames).toBe(12)
  })

  it('reports the bytes and frames as the worker takes them in', async () => {
    const sink = await createGifSink(setup, () => new FakeWorker())
    expect(sink.bytes).toBe(0)
    await sink.push(solid(1, 2, 3), 5)
    await sink.push(solid(3, 2, 1), 5)
    await sink.push(solid(9, 9, 9), 5)
    await vi.waitFor(() => expect(sink.bytes).toBeGreaterThan(30))
    expect(sink.frames).toBeGreaterThanOrEqual(1)
    sink.dispose()
  })

  it('says a GIF grew too large when the worker does', async () => {
    const sink = await createGifSink({ ...setup, maxBytes: 10 }, () => new FakeWorker(10))
    await sink.push(solid(255, 0, 0), 5)
    await sink.push(solid(0, 255, 0), 5)
    await expect(
      (async () => {
        for (let i = 0; i < 6; i++) await sink.push(solid(i, 1, 1), 5)
        await sink.finish()
      })(),
    ).rejects.toBeInstanceOf(GifTooLargeError)
    sink.dispose()
  })

  it('stops waiting for room when the worker fails', async () => {
    const worker = new FakeWorker()
    const sink = await createGifSink(setup, () => worker)
    worker.onmessage?.({ data: { type: 'error', kind: 'failed', message: 'boom' } } as MessageEvent<GifReply>)
    await expect(sink.push(solid(1, 1, 1), 5)).rejects.toThrow('boom')
    await expect(sink.finish()).rejects.toThrow('boom')
  })
})

describe('the GIF sink without one', () => {
  it('writes on the page\'s own thread when the browser has no worker', async () => {
    const sink = await createGifSink(setup, null)
    await sink.push(solid(255, 0, 0), 10)
    await sink.push(solid(255, 0, 0), 10)
    await sink.push(solid(0, 0, 255), 5)
    const { blob, frames } = await sink.finish()
    expect(frames).toBe(2)
    expect(inspectGif(await bytesOf(blob)).delaysCs).toEqual([20, 5])
  })

  it('falls back when the worker cannot be made', async () => {
    const sink = await createGifSink(setup, () => {
      throw new Error('blocked by the content security policy')
    })
    await sink.push(solid(1, 2, 3), 10)
    expect((await sink.finish()).frames).toBe(1)
  })

  it('falls back when the worker script fails to load', async () => {
    const worker = new FakeWorker()
    worker.postMessage = () => {
      setTimeout(() => worker.onerror?.({} as ErrorEvent), 1)
    }
    const sink = await createGifSink(setup, () => worker)
    await sink.push(solid(1, 2, 3), 10)
    expect((await sink.finish()).frames).toBe(1)
    expect(worker.terminated).toBe(true)
  })

  it('falls back when the worker never says it is ready', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    worker.postMessage = () => undefined
    const pending = createGifSink(setup, () => worker)
    await vi.advanceTimersByTimeAsync(4100)
    const sink = await pending
    await sink.push(solid(1, 2, 3), 10)
    expect((await sink.finish()).frames).toBe(1)
    expect(worker.terminated).toBe(true)
  })
})
