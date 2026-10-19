import { FabricImage } from 'fabric'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../../dev/memoryAdapter'
import { installImageStub } from '../../test/imageStub'
import { registerBackgroundRemover } from '../bgRemoval'
import type { ModelDescriptor } from '../bgRemoval/model'
import type { WorkerReply, WorkerRequest } from '../bgRemoval/protocol'
import { WorkerBackgroundRemover, type WorkerLike } from '../bgRemoval/remover'
import { EditorEngine } from '../editor'

const model: ModelDescriptor = {
  id: 'm',
  name: 'M',
  url: 'https://doory.example/media/models/m/m.onnx',
  bytes: 8,
  sha256: 'a'.repeat(64),
  input: { name: 'in', size: 64, mean: [0, 0, 0], std: [1, 1, 1], rescale: '255' },
  output: 'out',
}

/** A worker that loads at once and then keeps "processing" until the test answers for it. */
class SlowWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  received: WorkerRequest[] = []
  postMessage(message: WorkerRequest): void {
    this.received.push(message)
    if (message.type === 'init') queueMicrotask(() => this.reply({ type: 'ready' }))
  }
  reply(reply: WorkerReply): void {
    this.onmessage?.({ data: reply } as MessageEvent<WorkerReply>)
  }
  terminate(): void {}
}

async function setup() {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 'd', title: 'T', mode: 'guest' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  await engine.insert.imageFiles([new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' })])
  await vi.waitFor(() => expect(view.canvas.getObjects()).toHaveLength(1))
  return { engine, handle }
}

describe('cancelling StyleApi.removeBackground with the real worker remover', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installImageStub({ width: 200, height: 100 })
    vi.spyOn(FabricImage.prototype, '_render').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['x'], { type: 'image/png' }))))
    URL.createObjectURL = vi.fn(() => 'blob:fake')
  })
  afterEach(async () => {
    registerBackgroundRemover(null)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    restore()
    document.body.innerHTML = ''
  })

  it('stops the worker, applies nothing and resolves false; a late answer changes nothing', async () => {
    const { engine, handle } = await setup()
    const worker = new SlowWorker()
    const remover = new WorkerBackgroundRemover(model, { createWorker: () => worker, wasmUrl: '/ort.wasm', threads: 1, load: async () => new ArrayBuffer(8) })
    registerBackgroundRemover(remover)
    const uploadsBefore = handle.uploads.length
    const doc = engine.state.doc
    const controller = new AbortController()
    const result = engine.style.removeBackground(undefined, controller.signal)
    await vi.waitFor(() => expect(worker.received.some((m) => m.type === 'run')).toBe(true))
    const run = worker.received.find((m): m is Extract<WorkerRequest, { type: 'run' }> => m.type === 'run')
    if (!run) throw new Error('the worker was never asked to run')

    controller.abort()

    expect(await result).toBe(false)
    expect(worker.received.at(-1)).toEqual({ type: 'cancel', id: run.id })
    worker.reply({ type: 'done', id: run.id, png: new Blob(['png'], { type: 'image/png' }) })
    await Promise.resolve()
    expect(handle.uploads).toHaveLength(uploadsBefore)
    expect(engine.state.doc).toBe(doc)
    remover.dispose()
    engine.dispose()
  })

  it('does not start the worker when the signal is already aborted', async () => {
    const { engine, handle } = await setup()
    const worker = new SlowWorker()
    const createWorker = vi.fn(() => worker)
    const remover = new WorkerBackgroundRemover(model, { createWorker, wasmUrl: '/ort.wasm', threads: 1, load: async () => new ArrayBuffer(8) })
    registerBackgroundRemover(remover)
    const uploadsBefore = handle.uploads.length
    const controller = new AbortController()
    controller.abort()
    expect(await engine.style.removeBackground(undefined, controller.signal)).toBe(false)
    expect(createWorker).not.toHaveBeenCalled()
    expect(handle.uploads).toHaveLength(uploadsBefore)
    remover.dispose()
    engine.dispose()
  })
})
