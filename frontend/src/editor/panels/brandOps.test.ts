import { describe, expect, it } from 'vitest'
import type { Asset, BrandKit } from '@/types/api'
import { MAX_BRAND_COLORS, MAX_BRAND_LOGOS, emptyKit, fontOf, pickKit, refToAsset, upsertKit, withColor, withFont, withLogo, withoutColor, withoutLogo } from './brandOps'

const kit = (over: Partial<BrandKit> = {}): BrandKit => ({ ...emptyKit('Acme', false), id: 'k1', ...over })
const logo = (id: string): Asset => ({ id, kind: 'image', name: id, url: `/media/${id}.png`, thumb_url: `/media/${id}.png`, width: 10, height: 10, size: 1, mime: 'image/png', tags: [], attribution: null, created_at: '' })

describe('brand kits', () => {
  it('starts empty with a trimmed name', () => {
    expect(emptyKit('  Acme  ', true)).toMatchObject({ id: '', name: 'Acme', is_default: true, colors: [], fonts: [], logos: [] })
  })

  it('picks the default kit, otherwise the first', () => {
    expect(pickKit([])).toBeNull()
    expect(pickKit([kit({ id: 'a' }), kit({ id: 'b', is_default: true })])?.id).toBe('b')
    expect(pickKit([kit({ id: 'a' }), kit({ id: 'b' })])?.id).toBe('a')
  })

  it('adds a colour once, normalised, and respects the limit', () => {
    const a = withColor(kit(), '#E11D48')
    expect(a.colors.map((c) => c.hex)).toEqual(['#e11d48'])
    expect(withColor(a, '#e11d48')).toBe(a)
    let full = kit()
    for (let i = 0; i < MAX_BRAND_COLORS + 3; i++) full = withColor(full, `#${(i + 16).toString(16).padStart(2, '0')}0000`)
    expect(full.colors).toHaveLength(MAX_BRAND_COLORS)
  })

  it('removes a colour by id without touching the input', () => {
    const a = withColor(withColor(kit(), '#111111'), '#222222')
    const b = withoutColor(a, a.colors[0].id)
    expect(b.colors.map((c) => c.hex)).toEqual(['#222222'])
    expect(a.colors).toHaveLength(2)
  })

  it('sets one font per role', () => {
    const a = withFont(withFont(kit(), 'heading', 'Lora'), 'body', 'Inter')
    const b = withFont(a, 'heading', 'Playfair Display')
    expect(fontOf(b, 'heading')).toBe('Playfair Display')
    expect(fontOf(b, 'body')).toBe('Inter')
    expect(fontOf(b, 'subheading')).toBeNull()
    expect(b.fonts).toHaveLength(2)
  })

  it('adds and removes logos, ignoring duplicates and the limit', () => {
    const a = withLogo(kit(), logo('a'))
    expect(withLogo(a, logo('a'))).toBe(a)
    expect(withoutLogo(a, 'a').logos).toEqual([])
    let full = kit()
    for (let i = 0; i < MAX_BRAND_LOGOS + 2; i++) full = withLogo(full, logo(`l${i}`))
    expect(full.logos).toHaveLength(MAX_BRAND_LOGOS)
  })

  it('describes an uploaded file as an asset by its id', () => {
    const asset = refToAsset({ id: 'u1', url: 'idb://u1', thumbUrl: 'idb://u1', width: 4, height: 3, name: 'logo.png', kind: 'image' })
    expect(asset).toMatchObject({ id: 'u1', name: 'logo.png', thumb_url: 'idb://u1', width: 4, height: 3 })
  })

  it('replaces a kit by id and keeps a single default', () => {
    const a = kit({ id: 'a', is_default: true })
    const b = kit({ id: 'b' })
    const next = upsertKit([a, b], { ...b, is_default: true, name: 'B' })
    expect(next.map((k) => [k.id, k.is_default])).toEqual([['a', false], ['b', true]])
    expect(upsertKit(next, kit({ id: 'c' }))).toHaveLength(3)
  })
})
