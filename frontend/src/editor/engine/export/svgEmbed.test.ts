import { SvgEmbedError, embedImages, externalHrefs } from './svgEmbed'

const svg = (...hrefs: string[]): string => `<svg>${hrefs.map((h) => `<image xlink:href="${h}" width="1" height="1"/>`).join('')}</svg>`

describe('svg image embedding', () => {
  it('lists external hrefs once and skips data: and fragment refs', () => {
    const s = svg('https://x/a.png', 'https://x/a.png', 'data:image/png;base64,AAAA', '#frag', '/media/b.jpg')
    expect(externalHrefs(s)).toEqual(['https://x/a.png', '/media/b.jpg'])
  })

  it('inlines every external image as a data URI', async () => {
    const fetchBlob = vi.fn(async (url: string) => new Blob([url], { type: 'image/png' }))
    const out = await embedImages(svg('https://x/a.png', '/media/b.jpg', 'https://x/a.png'), fetchBlob)
    expect(fetchBlob).toHaveBeenCalledTimes(2)
    expect(externalHrefs(out)).toEqual([])
    expect(out.match(/data:image\/png;base64,/g)).toHaveLength(3)
  })

  it('leaves already-embedded SVGs untouched', async () => {
    const s = svg('data:image/png;base64,AAAA')
    const fetchBlob = vi.fn()
    expect(await embedImages(s, fetchBlob)).toBe(s)
    expect(fetchBlob).not.toHaveBeenCalled()
  })

  it('decodes XML entities in urls before fetching', async () => {
    const fetchBlob = vi.fn(async () => new Blob(['x'], { type: 'image/png' }))
    await embedImages(svg('https://x/a.png?a=1&amp;b=2'), fetchBlob)
    expect(fetchBlob).toHaveBeenCalledWith('https://x/a.png?a=1&b=2')
  })

  it('fails loudly when an image cannot be fetched', async () => {
    const fetchBlob = async (): Promise<Blob> => {
      throw new Error('nope')
    }
    await expect(embedImages(svg('https://x/a.png'), fetchBlob)).rejects.toBeInstanceOf(SvgEmbedError)
  })
})
