import { captureFetch } from '@/test/utils'
import { resetClientState } from './client'
import { exportsApi } from './exports'

beforeEach(() => {
  resetClientState()
  document.cookie = 'csrftoken=tok; path=/'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const pdf = () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })
const one = [new Blob(['<svg/>'])]

describe('exportsApi.pdf print options', () => {
  it('sends the bleed, the crop marks, the language and the sizes as form fields', async () => {
    const calls = captureFetch(pdf)
    await exportsApi.pdf({ pages: [...one, ...one], width: 1080, height: 1080, sizes: [{ width: 1080, height: 1080 }, { width: 794, height: 1123 }], bleedMm: 3, cropMarks: true, title: 'Menu', lang: 'de-CH' })
    const form = calls[0].body as FormData
    expect(form.get('bleed_mm')).toBe('3')
    expect(form.get('crop_marks')).toBe('true')
    expect(form.get('lang')).toBe('de-CH')
    expect(form.get('title')).toBe('Menu')
    expect(JSON.parse(form.get('sizes') as string)).toEqual([{ width: 1080, height: 1080 }, { width: 794, height: 1123 }])
  })

  it('sends a zero bleed and no marks as they are, and no language when none is given', async () => {
    const calls = captureFetch(pdf)
    await exportsApi.pdf({ pages: one, width: 100, height: 100, bleedMm: 0, cropMarks: false })
    const form = calls[0].body as FormData
    expect(form.get('bleed_mm')).toBe('0')
    expect(form.get('crop_marks')).toBe('false')
    expect(form.has('lang')).toBe(false)
  })

  it('stops the request when the signal aborts', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init: RequestInit = {}) => {
      signals.push(init.signal)
      return Promise.resolve(pdf())
    })
    const controller = new AbortController()
    await exportsApi.pdf({ pages: one, width: 100, height: 100, signal: controller.signal })
    expect(signals).toEqual([controller.signal])
  })
})
