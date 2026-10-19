import type { EditorServices, UserFontsService } from '@/types/adapter'
import type { FontFamily } from '@/types/api'
import { FontManager } from '../engine/fonts'
import { UserFonts } from './userFonts'

const family = (name: string, id = name): FontFamily => ({ id, family: name, category: 'sans-serif', scripts: ['latin'], is_variable: false, is_user_font: true, variants: [{ weight: 400, style: 'normal', url: `/media/fonts/user/1/${id}.ttf` }], popularity: 9999 })
const none = async () => ({ count: 0, next: null, previous: null, results: [] })

function servicesWith(mine: UserFontsService | null, provided?: FontFamily[]): EditorServices['fonts'] {
  return { list: none, mine, provided }
}

function fakeService(initial: FontFamily[] = []): { service: UserFontsService; list: ReturnType<typeof vi.fn>; upload: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => initial)
  const upload = vi.fn(async (): Promise<FontFamily> => family('Added'))
  const remove = vi.fn(async () => undefined)
  return { service: { list, upload, remove }, list, upload, remove }
}

describe('UserFonts', () => {
  it('has nothing for guests', () => {
    const store = new UserFonts(new FontManager(null))
    store.attach(servicesWith(null))
    expect(store.getSnapshot()).toEqual({ status: 'ready', families: [], error: null, canManage: false, source: 'none' })
  })

  it('serves the fonts of a shared design without a library', () => {
    const manager = new FontManager(null)
    const store = new UserFonts(manager)
    store.attach(servicesWith(null, [family('Zed'), family('Alpha')]))
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', canManage: false, source: 'shared' })
    expect(store.getSnapshot().families.map((f) => f.family)).toEqual(['Alpha', 'Zed'])
    expect(manager.isUserFont('Alpha')).toBe(true)
  })

  it('fetches the library once, however many parts of the UI ask', async () => {
    const { service, list } = fakeService([family('Brand Sans')])
    const manager = new FontManager(null)
    const store = new UserFonts(manager)
    store.attach(servicesWith(service))
    expect(store.getSnapshot().status).toBe('idle')
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
    await store.ensureLoaded()
    expect(list).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', canManage: true, source: 'mine' })
    expect(manager.isUserFont('Brand Sans')).toBe(true)
  })

  it('lets the font manager wait for the library before it gives up on a family', async () => {
    const { service } = fakeService([family('Brand Sans')])
    const manager = new FontManager(none)
    const store = new UserFonts(manager)
    store.attach(servicesWith(service))
    expect((await manager.lookup('Brand Sans'))?.family).toBe('Brand Sans')
  })

  it('notifies subscribers while loading and when done', async () => {
    const { service } = fakeService([family('Brand Sans')])
    const store = new UserFonts(new FontManager(null))
    store.attach(servicesWith(service))
    const seen: string[] = []
    store.subscribe(() => seen.push(store.getSnapshot().status))
    await store.ensureLoaded()
    expect(seen).toEqual(['loading', 'ready'])
  })

  it('reports a failure with the message it came with and recovers with reload', async () => {
    let fail = true
    const service: UserFontsService = {
      list: async () => {
        if (fail) throw new Error('The library is down.')
        return [family('Brand Sans')]
      },
      upload: async () => family('x'),
      remove: async () => undefined,
    }
    const store = new UserFonts(new FontManager(null))
    store.attach(servicesWith(service))
    await store.ensureLoaded()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: 'The library is down.' })
    fail = false
    await store.reload()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(store.getSnapshot().families).toHaveLength(1)
  })

  it('keeps the library sorted when an upload adds or extends a family, and never lists a family twice', async () => {
    const { service, upload } = fakeService([family('Brand Sans', 'b'), family('Zed', 'z')])
    const store = new UserFonts(new FontManager(null))
    store.attach(servicesWith(service))
    await store.ensureLoaded()
    upload.mockResolvedValueOnce(family('Alpha', 'a'))
    await store.upload({ files: [new File(['x'], 'a.ttf')] })
    upload.mockResolvedValueOnce({ ...family('Brand Sans', 'b'), variants: [...family('Brand Sans', 'b').variants, { weight: 700, style: 'normal', url: '/media/fonts/user/1/b-bold.ttf' }] })
    await store.upload({ files: [new File(['x'], 'b.ttf')] })
    const families = store.getSnapshot().families
    expect(families.map((f) => f.family)).toEqual(['Alpha', 'Brand Sans', 'Zed'])
    expect(families[1].variants).toHaveLength(2)
  })

  it('leaves the library alone when the upload fails', async () => {
    const { service, upload } = fakeService([family('Brand Sans')])
    const store = new UserFonts(new FontManager(null))
    store.attach(servicesWith(service))
    await store.ensureLoaded()
    upload.mockRejectedValueOnce(new Error('nope'))
    await expect(store.upload({ files: [new File(['x'], 'a.ttf')] })).rejects.toThrow('nope')
    expect(store.getSnapshot().families).toHaveLength(1)
  })

  it('removes a family from the library and from the font manager once the server agrees', async () => {
    const { service, remove } = fakeService([family('Brand Sans', 'b')])
    const manager = new FontManager(null)
    const store = new UserFonts(manager)
    store.attach(servicesWith(service))
    await store.ensureLoaded()
    remove.mockRejectedValueOnce(new Error('server'))
    await expect(store.remove(family('Brand Sans', 'b'))).rejects.toThrow('server')
    expect(manager.isUserFont('Brand Sans')).toBe(true)
    await store.remove(family('Brand Sans', 'b'))
    expect(remove).toHaveBeenLastCalledWith('b')
    expect(store.getSnapshot().families).toEqual([])
    expect(manager.isUserFont('Brand Sans')).toBe(false)
  })

  it('refuses to upload or delete where there is no library', async () => {
    const store = new UserFonts(new FontManager(null))
    store.attach(servicesWith(null))
    await expect(store.upload({ files: [] })).rejects.toThrow()
    await expect(store.remove(family('x'))).rejects.toThrow()
  })

  it('ignores a late answer after the adapter changed, and keeps its state when the same services are attached again', async () => {
    let release: (f: FontFamily[]) => void = () => undefined
    const slow: UserFontsService = {
      list: () => new Promise<FontFamily[]>((resolve) => (release = resolve)),
      upload: async () => family('x'),
      remove: async () => undefined,
    }
    const store = new UserFonts(new FontManager(null))
    const fonts = servicesWith(slow)
    store.attach(fonts)
    const loading = store.ensureLoaded()
    store.attach(fonts)
    expect(store.getSnapshot().status).toBe('loading')
    store.attach(servicesWith(null))
    release([family('Stale')])
    await loading
    expect(store.getSnapshot()).toMatchObject({ source: 'none', families: [] })
  })
})
