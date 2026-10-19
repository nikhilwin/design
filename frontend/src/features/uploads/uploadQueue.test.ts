import { ApiError } from '@/lib/api'
import type { Asset } from '@/types/api'
import { UploadQueue, validateUpload, type Uploader } from './uploadQueue'
import { parseTags } from './tags'

const MB = 1024 * 1024
const file = (name: string, type = 'image/png', size = 100) => new File([new Uint8Array(size)], name, { type })
const asset = (name: string): Asset => ({ id: name, kind: 'image', name, url: '', thumb_url: '', width: 1, height: 1, size: 1, mime: 'image/png', tags: [], attribution: null, created_at: '' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('validateUpload', () => {
  it('accepts supported images and svg by extension', () => {
    expect(validateUpload({ name: 'a.png', type: 'image/png', size: 10 }, MB)).toBeNull()
    expect(validateUpload({ name: 'logo.svg', type: '', size: 10 }, MB)).toBeNull()
  })

  it('rejects other types, empty files and oversized files with readable messages', () => {
    expect(validateUpload({ name: 'a.pdf', type: 'application/pdf', size: 10 }, MB)).toMatch(/Only PNG/)
    expect(validateUpload({ name: 'a.png', type: 'image/png', size: 0 }, MB)).toMatch(/empty/)
    expect(validateUpload({ name: 'a.png', type: 'image/png', size: 5 * MB }, MB)).toBe('This file is 5 MB. The limit is 1 MB.')
  })
})

describe('UploadQueue', () => {
  it('runs at most `concurrency` uploads at once and starts the next when one finishes', async () => {
    const gates = [deferred<Asset>(), deferred<Asset>(), deferred<Asset>()]
    let started = 0
    const uploader: Uploader = () => gates[started++].promise
    const queue = new UploadQueue({ uploader, maxBytes: MB, concurrency: 2 })
    queue.add([file('a.png'), file('b.png'), file('c.png')])
    expect(queue.getSnapshot().map((item) => item.status)).toEqual(['uploading', 'uploading', 'queued'])
    gates[0].resolve(asset('a'))
    await vi.waitFor(() => expect(queue.getSnapshot().map((item) => item.status)).toEqual(['done', 'uploading', 'uploading']))
    gates[1].resolve(asset('b'))
    gates[2].resolve(asset('c'))
    await vi.waitFor(() => expect(queue.getSnapshot().every((item) => item.status === 'done')).toBe(true))
  })

  it('reports per-file progress clamped to 0..1 and notifies on completion', async () => {
    const gate = deferred<Asset>()
    const onUploaded = vi.fn()
    const queue = new UploadQueue({
      uploader: (_file, { onProgress }) => {
        onProgress(0.4)
        onProgress(7)
        return gate.promise
      },
      maxBytes: MB,
      onUploaded,
    })
    queue.add([file('a.png')])
    expect(queue.getSnapshot()[0].progress).toBe(1)
    gate.resolve(asset('a'))
    await vi.waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1))
  })

  it('marks invalid files as errors immediately and never uploads them', () => {
    const uploader = vi.fn<Uploader>()
    const queue = new UploadQueue({ uploader, maxBytes: 10, concurrency: 2 })
    queue.add([file('a.pdf', 'application/pdf'), file('big.png', 'image/png', 50)])
    expect(queue.getSnapshot().map((item) => item.status)).toEqual(['error', 'error'])
    expect(uploader).not.toHaveBeenCalled()
  })

  it('surfaces server errors, lets the user retry, and then succeeds', async () => {
    let attempt = 0
    const queue = new UploadQueue({
      uploader: async () => {
        attempt += 1
        if (attempt === 1) throw new ApiError({ status: 400, code: 'invalid_image', message: 'Not a valid image.' })
        return asset('a')
      },
      maxBytes: MB,
    })
    queue.add([file('a.png')])
    await vi.waitFor(() => expect(queue.getSnapshot()[0].status).toBe('error'))
    expect(queue.getSnapshot()[0].error).toBe('Not a valid image.')
    queue.retry(queue.getSnapshot()[0].id)
    await vi.waitFor(() => expect(queue.getSnapshot()[0].status).toBe('done'))
  })

  it('describes dropped connections without technical jargon', async () => {
    const queue = new UploadQueue({ uploader: async () => { throw new ApiError({ status: 0, code: 'network_error', message: 'x' }) }, maxBytes: MB })
    queue.add([file('a.png')])
    await vi.waitFor(() => expect(queue.getSnapshot()[0].error).toBe('The connection dropped. Try again.'))
  })

  it('cancelling aborts the in-flight request and removes the entry', async () => {
    let signal: AbortSignal | undefined
    const queue = new UploadQueue({
      uploader: (_file, handlers) => {
        signal = handlers.signal
        return new Promise<Asset>((_resolve, reject) => handlers.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
      },
      maxBytes: MB,
    })
    queue.add([file('a.png')])
    queue.remove(queue.getSnapshot()[0].id)
    expect(signal?.aborted).toBe(true)
    expect(queue.getSnapshot()).toEqual([])
  })

  it('clears finished entries but keeps active ones, and notifies subscribers', async () => {
    const gate = deferred<Asset>()
    let call = 0
    const queue = new UploadQueue({ uploader: () => (call++ === 0 ? Promise.resolve(asset('a')) : gate.promise), maxBytes: MB, concurrency: 2 })
    const listener = vi.fn()
    queue.subscribe(listener)
    queue.add([file('a.png'), file('b.png')])
    await vi.waitFor(() => expect(queue.getSnapshot()[0].status).toBe('done'))
    queue.clearFinished()
    expect(queue.getSnapshot().map((item) => item.name)).toEqual(['b.png'])
    expect(listener).toHaveBeenCalled()
    gate.resolve(asset('b'))
  })
})

describe('parseTags', () => {
  it('lower-cases, trims, de-duplicates and caps tags', () => {
    expect(parseTags(' Logo, brand ,LOGO,, dark ')).toEqual(['logo', 'brand', 'dark'])
    expect(parseTags('')).toEqual([])
    expect(parseTags('x'.repeat(50))[0]).toHaveLength(32)
    expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(','))).toHaveLength(20)
  })
})
