import { ApiError } from '@/lib/api/client'
import type { FontFamily } from '@/types/api'
import { type UploadEvents, type UploadItem, detectedFamilies, detectedFamily, isBusy, newItem, pendingItems, uploadReducer, uploadSequentially } from './uploadQueue'

const file = (name: string) => new File(['x'], name)
const family = (id: string, name = 'Brand Sans'): FontFamily => ({ id, family: name, category: 'sans-serif', scripts: ['latin'], is_variable: false, is_user_font: true, variants: [], popularity: 9999 })
const info = (name: string | null): UploadItem['info'] => ({ format: 'ttf', family: name, weight: 400, style: 'normal' })

describe('uploadReducer', () => {
  it('walks a file from reading to done', () => {
    let items = uploadReducer([], { type: 'add', items: [newItem('a', file('a.ttf'))] })
    expect(items[0].status).toBe('reading')
    items = uploadReducer(items, { type: 'read', id: 'a', info: info('Brand Sans')!, previewFamily: 'p1' })
    expect(items[0]).toMatchObject({ status: 'ready', previewFamily: 'p1' })
    items = uploadReducer(items, { type: 'start', id: 'a' })
    items = uploadReducer(items, { type: 'progress', id: 'a', fraction: 0.4 })
    expect(items[0]).toMatchObject({ status: 'uploading', progress: 0.4 })
    items = uploadReducer(items, { type: 'progress', id: 'a', fraction: 7 })
    expect(items[0].progress).toBe(1)
    items = uploadReducer(items, { type: 'done', id: 'a', family: family('f1') })
    expect(items[0]).toMatchObject({ status: 'done', progress: 1, result: { id: 'f1' } })
  })

  it('keeps at most five files', () => {
    const six = Array.from({ length: 6 }, (_, i) => newItem(`i${i}`, file(`f${i}.ttf`)))
    expect(uploadReducer([], { type: 'add', items: six })).toHaveLength(5)
  })

  it('removes a file', () => {
    const items = uploadReducer([], { type: 'add', items: [newItem('a', file('a.ttf')), newItem('b', file('b.ttf'))] })
    expect(uploadReducer(items, { type: 'remove', id: 'a' }).map((i) => i.id)).toEqual(['b'])
  })

  it('retry makes failed uploads ready again but leaves refused files refused', () => {
    let items = uploadReducer([], { type: 'add', items: [newItem('a', file('a.ttf')), newItem('b', file('b.pdf'))] })
    items = uploadReducer(items, { type: 'fail', id: 'a', failure: { kind: 'variant-exists', message: 'taken' } })
    items = uploadReducer(items, { type: 'reject', id: 'b', message: 'not a font' })
    items = uploadReducer(items, { type: 'retry' })
    expect(items.map((i) => [i.status, i.failure])).toEqual([
      ['ready', null],
      ['error', 'file'],
    ])
  })

  it('knows what is pending and whether it is busy', () => {
    let items = uploadReducer([], { type: 'add', items: [newItem('a', file('a.ttf')), newItem('b', file('b.ttf')), newItem('c', file('c.ttf'))] })
    expect(isBusy(items)).toBe(true)
    items = uploadReducer(items, { type: 'read', id: 'a', info: info('X')!, previewFamily: null })
    items = uploadReducer(items, { type: 'reject', id: 'b', message: 'bad' })
    items = uploadReducer(items, { type: 'done', id: 'c', family: family('f') })
    expect(isBusy(items)).toBe(false)
    expect(pendingItems(items).map((i) => i.id)).toEqual(['a'])
  })
})

describe('detected families', () => {
  const make = (names: (string | null)[]): UploadItem[] => names.map((n, i) => ({ ...newItem(`i${i}`, file(`f${i}.ttf`)), status: 'ready', info: info(n) }))
  it('agrees on one family or reports the different ones', () => {
    expect(detectedFamily(make(['A', 'A']))).toBe('A')
    expect(detectedFamily(make(['A', 'B']))).toBe('')
    expect(detectedFamily(make([null]))).toBe('')
    expect(detectedFamilies(make(['A', 'B', 'A', null]))).toEqual(['A', 'B'])
  })
  it('ignores refused files', () => {
    const items = make(['A', 'B'])
    items[1] = { ...items[1], status: 'error' }
    expect(detectedFamily(items)).toBe('A')
  })
})

describe('uploadSequentially', () => {
  const recorder = () => {
    const log: string[] = []
    const events: UploadEvents = {
      onStart: (id) => log.push(`start ${id}`),
      onProgress: (id, f) => log.push(`progress ${id} ${f}`),
      onDone: (id, fam) => log.push(`done ${id} ${fam.id}`),
      onFail: (id, failure) => log.push(`fail ${id} ${failure.kind}`),
    }
    return { log, events }
  }
  const items = ['a', 'b', 'c'].map((id) => ({ id, file: file(`${id}.ttf`) }))

  it('sends one request per file, in order, with the family override', async () => {
    const { log, events } = recorder()
    const calls: { files: string[]; family?: string }[] = []
    const stopped = await uploadSequentially(
      items,
      'Brand Sans',
      async (input, options) => {
        calls.push({ files: input.files.map((f) => f.name), family: input.family })
        options.onProgress?.(0.5)
        return family(`fam-${input.files[0].name}`)
      },
      events,
      new AbortController().signal,
    )
    expect(stopped).toBe(false)
    expect(calls).toEqual([
      { files: ['a.ttf'], family: 'Brand Sans' },
      { files: ['b.ttf'], family: 'Brand Sans' },
      { files: ['c.ttf'], family: 'Brand Sans' },
    ])
    expect(log.filter((l) => l.startsWith('done'))).toEqual(['done a fam-a.ttf', 'done b fam-b.ttf', 'done c fam-c.ttf'])
    expect(log).toContain('progress a 0.5')
  })

  it('sends no family field when none was entered', async () => {
    const calls: (string | undefined)[] = []
    await uploadSequentially(items.slice(0, 1), '', async (input) => (calls.push(input.family), family('x')), recorder().events, new AbortController().signal)
    expect(calls).toEqual([undefined])
  })

  it('goes on after a failure that only concerns one file', async () => {
    const { log, events } = recorder()
    const stopped = await uploadSequentially(
      items,
      '',
      async (input) => {
        if (input.files[0].name === 'b.ttf') throw new ApiError({ status: 409, code: 'variant_exists', message: 'exists' })
        return family('ok')
      },
      events,
      new AbortController().signal,
    )
    expect(stopped).toBe(false)
    expect(log.filter((l) => l.startsWith('fail') || l.startsWith('done'))).toEqual(['done a ok', 'fail b variant-exists', 'done c ok'])
  })

  it('stops at a failure every file would meet and leaves the rest untouched', async () => {
    const { log, events } = recorder()
    const stopped = await uploadSequentially(items, '', async () => Promise.reject(new ApiError({ status: 403, code: 'font_limit_reached', message: 'limit' })), events, new AbortController().signal)
    expect(stopped).toBe(true)
    expect(log).toEqual(['start a', 'fail a limit'])
  })

  it('stops quietly when aborted', async () => {
    const { log, events } = recorder()
    const abort = new AbortController()
    const stopped = await uploadSequentially(
      items,
      '',
      async () => {
        abort.abort()
        throw new DOMException('Aborted', 'AbortError')
      },
      events,
      abort.signal,
    )
    expect(stopped).toBe(true)
    expect(log).toEqual(['start a'])
  })
})
