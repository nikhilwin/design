import { describe, expect, it } from 'vitest'
import { absoluteUrl, expiryDate, linkStatus, validPassword } from './shareOps'

const NOW = Date.parse('2026-03-10T12:00:00Z')

describe('share links', () => {
  it('computes the expiry timestamp of a preset', () => {
    expect(expiryDate('never', NOW)).toBeNull()
    expect(expiryDate('1d', NOW)).toBe('2026-03-11T12:00:00.000Z')
    expect(expiryDate('7d', NOW)).toBe('2026-03-17T12:00:00.000Z')
    expect(expiryDate('30d', NOW)).toBe('2026-04-09T12:00:00.000Z')
  })

  it('makes the address absolute against the page origin', () => {
    expect(absoluteUrl('/s/abc', 'https://doory.example')).toBe('https://doory.example/s/abc')
    expect(absoluteUrl('https://other.example/s/abc', 'https://doory.example')).toBe('https://other.example/s/abc')
  })

  it('reports expired before off before active', () => {
    expect(linkStatus({ is_active: true, expires_at: null }, NOW)).toBe('active')
    expect(linkStatus({ is_active: false, expires_at: null }, NOW)).toBe('off')
    expect(linkStatus({ is_active: true, expires_at: '2026-03-10T11:59:59Z' }, NOW)).toBe('expired')
    expect(linkStatus({ is_active: false, expires_at: '2026-03-10T11:59:59Z' }, NOW)).toBe('expired')
    expect(linkStatus({ is_active: true, expires_at: '2026-03-10T12:00:01Z' }, NOW)).toBe('active')
  })

  it('accepts printable-ASCII passwords of 6 to 128 characters', () => {
    expect(validPassword('12345')).toBe(false)
    expect(validPassword('123456')).toBe(true)
    expect(validPassword('x'.repeat(128))).toBe(true)
    expect(validPassword('x'.repeat(129))).toBe(false)
    expect(validPassword('pässword')).toBe(false)
    expect(validPassword('pass word!')).toBe(true)
  })
})
