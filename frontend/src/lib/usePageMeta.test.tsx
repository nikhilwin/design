import { renderHook } from '@testing-library/react'
import { usePageMeta } from './usePageMeta'

const content = (selector: string, attribute = 'content') => document.head.querySelector(selector)?.getAttribute(attribute) ?? null

beforeEach(() => {
  document.head.innerHTML = '<meta name="description" content="Original description"><meta property="og:title" content="Original card title">'
  document.title = 'Original title'
})

describe('usePageMeta', () => {
  it('sets the title, description, canonical address, link-card tags and image for the page', () => {
    renderHook(() => usePageMeta({ title: 'Wedding invitation', description: 'A soft floral invitation.', canonical: '/templates/wedding', image: '/media/templates/wedding.webp' }))
    expect(document.title).toBe('Wedding invitation · Doory')
    expect(content('meta[name="description"]')).toBe('A soft floral invitation.')
    expect(content('meta[property="og:description"]')).toBe('A soft floral invitation.')
    expect(content('meta[name="twitter:description"]')).toBe('A soft floral invitation.')
    expect(content('meta[property="og:title"]')).toBe('Wedding invitation · Doory')
    expect(content('meta[name="twitter:title"]')).toBe('Wedding invitation · Doory')
    expect(content('link[rel="canonical"]', 'href')).toBe(`${window.location.origin}/templates/wedding`)
    expect(content('meta[property="og:url"]')).toBe(`${window.location.origin}/templates/wedding`)
    expect(content('meta[property="og:image"]')).toBe(`${window.location.origin}/media/templates/wedding.webp`)
    expect(content('meta[name="twitter:image"]')).toBe(`${window.location.origin}/media/templates/wedding.webp`)
  })

  it('puts everything back when the page goes away: old values return, tags it added disappear', () => {
    const { unmount } = renderHook(() => usePageMeta({ title: 'Sign up', description: 'Make an account.', canonical: '/signup', noindex: true }))
    expect(content('meta[name="robots"]')).toBe('noindex, nofollow')
    unmount()
    expect(document.title).toBe('Original title')
    expect(content('meta[name="description"]')).toBe('Original description')
    expect(content('meta[property="og:title"]')).toBe('Original card title')
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull()
    expect(document.head.querySelector('meta[property="og:url"]')).toBeNull()
  })

  it('follows changes of its inputs without piling up tags', () => {
    const { rerender } = renderHook(({ title }) => usePageMeta({ title, canonical: '/templates/a' }), { initialProps: { title: 'First' } })
    rerender({ title: 'Second' })
    expect(document.title).toBe('Second · Doory')
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
  })

  it('leaves tags alone that it was not asked about', () => {
    renderHook(() => usePageMeta({ title: 'Only a title' }))
    expect(content('meta[name="description"]')).toBe('Original description')
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
  })
})
