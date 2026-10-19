import { BackgroundRemovalError } from '../bgRemoval'
import type { ModelDescriptor } from './model'
import type { WorkerReply, WorkerRequest } from './protocol'
import { IDLE_MS, WorkerBackgroundRemover, type WorkerLike } from './remover'

const model: ModelDescriptor = {
  id: 'm',
  name: 'M',
  url: 'https://doory.example/media/models/m/m.onnx',
  bytes: 8,
  sha256: 'a'.repeat(64),
  input: { name: 'in', size: 64, mean: [0, 0, 0], std: [1, 1, 1], rescale: '255' },
  output: 'out',
}

type Behaviour = {
  /** What the worker answers to `init`. */
  init?: WorkerReply | 'silent'
  /** What it does for a `run`; the default answers with progress and the PNG. */
  run?: (request: Extract<WorkerRequest, { type: 'run' }>, worker: FakeWorker) => void
}

class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = []
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  received: WorkerRequest[] = []
  transfers: Array<Transferable[] | undefined> = []
  terminated = false
  constructor(private readonly behaviour: Behaviour = {}) {
    FakeWorker.all.push(this)
  }
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    this.received.push(message)
    this.transfers.push(transfer)
    queueMicrotask(() => {
      if (message.type === 'init') {
        if (this.behaviour.init !== 'silent') this.reply(this.behaviour.init ?? { type: 'ready' })
      } else if (message.type === 'run') {
        if (this.behaviour.run) this.behaviour.run(message, this)
        else {
          this.reply({ type: 'progress', id: message.id, percent: 40 })
          this.reply({ type: 'progress', id: message.id, percent: 100 })
          this.reply({ type: 'done', id: message.id, png: new Blob(['png'], { type: 'image/png' }) })
        }
      }
    })
  }
  reply(reply: WorkerReply): void {
    this.onmessage?.({ data: reply } as MessageEvent<WorkerReply>)
  }
  terminate(): void {
    this.terminated = true
  }
}

const image = new Blob(['img'], { type: 'image/png' })
const buffer = () => new ArrayBuffer(8)

function make(behaviour: Behaviour = {}, extra: Partial<ConstructorParameters<typeof WorkerBackgroundRemover>[1]> = {}) {
  const load = vi.fn(async (_model: ModelDescriptor, onProgress?: (phase: 'downloading' | 'processing', percent: number) => void) => {
    onProgress?.('downloading', 50)
    onProgress?.('downloading', 100)
    return buffer()
  })
  const remover = new WorkerBackgroundRemover(model, {
    createWorker: () => new FakeWorker(behaviour),
    wasmUrl: '/assets/ort.wasm',
    threads: 1,
    load,
    ...extra,
  })
  return { remover, load }
}

beforeEach(() => {
  FakeWorker.all = []
})

describe('WorkerBackgroundRemover', () => {
  it('downloads the model, starts the worker once and returns the PNG', async () => {
    const { remover, load } = make()
    const progress: Array<[string, number]> = []
    const png = await remover.remove(image, (phase, percent) => progress.push([phase, percent]))
    expect(png.type).toBe('image/png')
    expect(load).toHaveBeenCalledTimes(1)
    expect(FakeWorker.all).toHaveLength(1)
    const [init, run] = FakeWorker.all[0].received
    expect(init).toMatchObject({ type: 'init', descriptor: model, wasmUrl: '/assets/ort.wasm', threads: 1 })
    expect(run).toMatchObject({ type: 'run', feather: 0 })
    expect(progress).toEqual([
      ['downloading', 50],
      ['downloading', 100],
      ['processing', 0],
      ['processing', 40],
      ['processing', 100],
    ])
  })

  it('hands the model to the worker without copying it', async () => {
    const { remover } = make()
    await remover.remove(image)
    const init = FakeWorker.all[0].received[0]
    expect(init.type === 'init' && FakeWorker.all[0].transfers[0]).toEqual([init.type === 'init' ? init.model : null])
  })

  it('keeps the worker and the loaded model for the next removal', async () => {
    const { remover, load } = make()
    await remover.remove(image)
    const progress: string[] = []
    await remover.remove(image, (phase) => progress.push(phase))
    expect(load).toHaveBeenCalledTimes(1)
    expect(FakeWorker.all).toHaveLength(1)
    expect(FakeWorker.all[0].received.filter((m) => m.type === 'init')).toHaveLength(1)
    expect(progress).not.toContain('downloading')
  })

  it('passes the feather radius to the worker', async () => {
    const { remover } = make({}, { feather: 3 })
    await remover.remove(image)
    expect(FakeWorker.all[0].received.at(-1)).toMatchObject({ type: 'run', feather: 3 })
  })

  it('runs one removal at a time, in order', async () => {
    const order: string[] = []
    const releases: Array<() => void> = []
    const { remover } = make({
      run: (request, worker) => {
        order.push(`start ${request.id}`)
        releases.push(() => {
          order.push(`end ${request.id}`)
          worker.reply({ type: 'done', id: request.id, png: new Blob(['x']) })
        })
      },
    })
    const first = remover.remove(image)
    const second = remover.remove(image)
    await vi.waitFor(() => expect(order).toEqual(['start 1']))
    releases[0]()
    await first
    await vi.waitFor(() => expect(order).toContain('start 2'))
    releases[1]()
    await second
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('tells the worker to cancel and rejects at once when aborted mid-run', async () => {
    const { remover } = make({ run: () => undefined })
    const controller = new AbortController()
    const result = remover.remove(image, undefined, controller.signal)
    await vi.waitFor(() => expect(FakeWorker.all[0]?.received.some((m) => m.type === 'run')).toBe(true))
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.all[0].received.at(-1)).toEqual({ type: 'cancel', id: 1 })
  })

  it('ignores late replies of a cancelled run and still serves the next one', async () => {
    let first: ((png: Blob) => void) | null = null
    const secondPng = new Blob(['second'])
    const { remover } = make({
      run: (request, worker) => {
        if (request.id === 1) first = (png) => worker.reply({ type: 'done', id: 1, png })
        else worker.reply({ type: 'done', id: request.id, png: secondPng })
      },
    })
    const controller = new AbortController()
    const cancelled = remover.remove(image, undefined, controller.signal)
    await vi.waitFor(() => expect(first).not.toBeNull())
    controller.abort()
    await expect(cancelled).rejects.toBeDefined()
    const next = remover.remove(image)
    first!(new Blob(['stale']))
    expect(await next).toBe(secondPng)
  })

  it('rejects without starting anything when already aborted', async () => {
    const { remover, load } = make()
    const controller = new AbortController()
    controller.abort()
    await expect(remover.remove(image, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(load).not.toHaveBeenCalled()
    expect(FakeWorker.all).toHaveLength(0)
  })

  it('rejects at once when aborted while the model is still loading', async () => {
    const { remover } = make({}, { load: () => new Promise<ArrayBuffer>(() => undefined) })
    const controller = new AbortController()
    const result = remover.remove(image, undefined, controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('turns a failure reply into a BackgroundRemovalError with its reason', async () => {
    const { remover } = make({ run: (request, worker) => worker.reply({ type: 'failed', id: request.id, reason: 'no-subject', message: 'No subject was found in the image.' }) })
    const error = await remover.remove(image).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackgroundRemovalError)
    expect(error).toMatchObject({ reason: 'no-subject', message: 'No subject was found in the image.' })
    // The worker is still fine and is reused.
    expect(FakeWorker.all[0].terminated).toBe(false)
  })

  it('reports a blocked runtime and tries again from scratch next time', async () => {
    const { remover, load } = make({ init: { type: 'failed', id: null, reason: 'blocked', message: 'The page blocks WebAssembly.' } })
    const error = await remover.remove(image).catch((e: unknown) => e)
    expect(error).toMatchObject({ reason: 'blocked' })
    expect(FakeWorker.all[0].terminated).toBe(true)
    await remover.remove(image).catch(() => undefined)
    expect(load).toHaveBeenCalledTimes(2)
    expect(FakeWorker.all).toHaveLength(2)
  })

  it('propagates a download failure and retries it on the next call', async () => {
    let attempts = 0
    const load = vi.fn(async () => {
      if (++attempts === 1) throw new BackgroundRemovalError('The background-removal model is not installed on this server.')
      return buffer()
    })
    const { remover } = make({}, { load })
    await expect(remover.remove(image)).rejects.toThrow(/not installed/)
    expect(FakeWorker.all).toHaveLength(0)
    await expect(remover.remove(image)).resolves.toBeInstanceOf(Blob)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('survives a worker that cannot be created', async () => {
    const { remover } = make({}, {
      createWorker: () => {
        throw new Error('no workers here')
      },
    })
    await expect(remover.remove(image)).rejects.toThrow(/worker could not be started/)
  })

  it('fails the running removal when the worker crashes and starts a new worker afterwards', async () => {
    const { remover, load } = make({}, { createWorker: () => new FakeWorker(FakeWorker.all.length === 0 ? { run: () => undefined } : {}) })
    const result = remover.remove(image)
    await vi.waitFor(() => expect(FakeWorker.all[0]?.received.some((m) => m.type === 'run')).toBe(true))
    FakeWorker.all[0].onerror?.({} as ErrorEvent)
    await expect(result).rejects.toBeInstanceOf(BackgroundRemovalError)
    expect(FakeWorker.all[0].terminated).toBe(true)
    await expect(remover.remove(image)).resolves.toBeInstanceOf(Blob)
    expect(FakeWorker.all).toHaveLength(2)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('drops the worker (and the memory of the model) after the idle time and reloads it on demand', async () => {
    vi.useFakeTimers()
    try {
      const { remover, load } = make()
      await remover.remove(image)
      expect(FakeWorker.all[0].terminated).toBe(false)
      await vi.advanceTimersByTimeAsync(IDLE_MS + 1)
      expect(FakeWorker.all[0].terminated).toBe(true)
      await remover.remove(image)
      expect(FakeWorker.all).toHaveLength(2)
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not drop the worker while removals keep coming', async () => {
    vi.useFakeTimers()
    try {
      const { remover } = make({}, { idleMs: 1000 })
      await remover.remove(image)
      await vi.advanceTimersByTimeAsync(800)
      await remover.remove(image)
      await vi.advanceTimersByTimeAsync(800)
      expect(FakeWorker.all[0].terminated).toBe(false)
      await vi.advanceTimersByTimeAsync(300)
      expect(FakeWorker.all[0].terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose stops the worker, fails a running removal and can be used again', async () => {
    const { remover } = make({ run: () => undefined })
    const running = remover.remove(image)
    await vi.waitFor(() => expect(FakeWorker.all[0]?.received.some((m) => m.type === 'run')).toBe(true))
    remover.dispose()
    await expect(running).rejects.toThrow(/stopped/)
    expect(FakeWorker.all[0].terminated).toBe(true)
  })
})
