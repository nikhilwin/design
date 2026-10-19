import { safeNextPath, scrollToFragment } from './navigation'

describe('safeNextPath', () => {
  it('keeps in-app paths including query and hash', () => {
    expect(safeNextPath('/design/abc')).toBe('/design/abc')
    expect(safeNextPath('/dashboard/designs?q=logo#top')).toBe('/dashboard/designs?q=logo#top')
  })

  it('falls back for empty values', () => {
    expect(safeNextPath(null)).toBe('/dashboard')
    expect(safeNextPath('')).toBe('/dashboard')
    expect(safeNextPath(undefined, '/x')).toBe('/x')
  })

  it('blocks open redirects', () => {
    for (const bad of ['//evil.test', 'https://evil.test/a', 'javascript:alert(1)', '/\\evil.test', 'evil.test', '/ok\n//evil.test']) {
      expect(safeNextPath(bad)).toBe('/dashboard')
    }
  })
})

describe('scrollToFragment', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    scrollIntoView.mockReset()
    Element.prototype.scrollIntoView = scrollIntoView
    document.body.innerHTML = ''
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  })

  const section = (id: string) => {
    const element = document.createElement('section')
    element.id = id
    document.body.appendChild(element)
    return element
  }

  it('scrolls to the element the fragment names, smoothly', () => {
    const faq = section('faq')
    scrollToFragment('#faq')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(faq)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('does not animate for visitors who asked for less motion', () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    section('features')
    scrollToFragment('#features')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })

  it('waits for a page that is still loading, and scrolls once the element appears', async () => {
    scrollToFragment('#faq')
    expect(scrollIntoView).not.toHaveBeenCalled()
    section('faq')
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  })

  it('stops looking when told to, and gives up after the timeout', async () => {
    const stop = scrollToFragment('#late')
    stop()
    section('late')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scrollIntoView).not.toHaveBeenCalled()
    scrollToFragment('#never', 10)
    await new Promise((resolve) => setTimeout(resolve, 40))
    section('never')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('ignores an empty fragment and decodes an encoded one', () => {
    scrollToFragment('#')
    scrollToFragment('')
    expect(scrollIntoView).not.toHaveBeenCalled()
    section('my section')
    scrollToFragment('#my%20section')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})
