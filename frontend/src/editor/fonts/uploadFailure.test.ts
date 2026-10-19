import { ApiError } from '@/lib/api/client'
import { describeFileProblem, describeUploadFailure, isSystemicFailure, withoutFileName } from './uploadFailure'
import { t } from '../strings'

const api = (status: number, code: string, message = 'server words', extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) => new ApiError({ status, code, message, ...extra })

describe('describeUploadFailure', () => {
  it('maps each documented error code to its own message and kind', () => {
    expect(describeUploadFailure(api(409, 'variant_exists'), 'a.ttf')).toEqual({ kind: 'variant-exists', message: t.userFonts.errors.variantExists })
    expect(describeUploadFailure(api(409, 'font_name_taken'), 'a.ttf')).toEqual({ kind: 'name-taken', message: t.userFonts.errors.nameTaken })
    expect(describeUploadFailure(api(403, 'font_limit_reached'), 'a.ttf')).toEqual({ kind: 'limit', message: t.userFonts.errors.limit })
    expect(describeUploadFailure(api(403, 'font_storage_limit'), 'a.ttf')).toEqual({ kind: 'storage', message: t.userFonts.errors.storage })
  })

  it('shows the server message of a validation error without repeating the file name', () => {
    const error = api(400, 'validation_error', 'Invalid input.', { fields: { files: ['brand.ttf: the font has no vector outlines.'] } })
    expect(describeUploadFailure(error, 'brand.ttf')).toEqual({ kind: 'invalid', message: 'The font has no vector outlines.' })
  })

  it('falls back to the family field and then to the message of a validation error', () => {
    expect(describeUploadFailure(api(400, 'validation_error', 'x', { fields: { family: ['The family name has no usable letters or digits.'] } }), 'a.ttf').message).toBe('The family name has no usable letters or digits.')
    expect(describeUploadFailure(api(400, 'validation_error', 'Please fix this.'), 'a.ttf').message).toBe('Please fix this.')
  })

  it('knows connection, session, size and rate problems', () => {
    expect(describeUploadFailure(api(0, 'network_error'), 'a.ttf').kind).toBe('offline')
    expect(describeUploadFailure(api(401, 'not_authenticated'), 'a.ttf').kind).toBe('signed-out')
    expect(describeUploadFailure(api(413, 'http_413'), 'a.ttf').kind).toBe('too-large')
    expect(describeUploadFailure(api(429, 'throttled', 'x', { retryAfter: 12 }), 'a.ttf')).toEqual({ kind: 'rate-limited', message: t.userFonts.errors.rateLimited(12) })
    expect(t.userFonts.errors.rateLimited(null)).toContain('moment')
  })

  it('shows the server message of a server error and a neutral one for anything else', () => {
    expect(describeUploadFailure(api(500, 'server_error', 'Doory had a problem on its side.'), 'a.ttf').message).toBe('Doory had a problem on its side.')
    expect(describeUploadFailure(api(418, 'teapot', 'secret detail'), 'a.ttf').message).toBe(t.userFonts.errors.unknown)
    expect(describeUploadFailure(new Error('boom'), 'a.ttf')).toEqual({ kind: 'unknown', message: t.userFonts.errors.unknown })
  })

  it('stops the queue only for problems that every file would meet', () => {
    const kinds = ['limit', 'storage', 'rate-limited', 'signed-out', 'offline'] as const
    for (const kind of kinds) expect(isSystemicFailure({ kind, message: '' })).toBe(true)
    for (const kind of ['variant-exists', 'name-taken', 'invalid', 'too-large', 'unknown'] as const) expect(isSystemicFailure({ kind, message: '' })).toBe(false)
  })
})

describe('messages', () => {
  it('strips only an exact file-name prefix', () => {
    expect(withoutFileName('a.ttf: the file is empty.', 'a.ttf')).toBe('The file is empty.')
    expect(withoutFileName('b.ttf: the file is empty.', 'a.ttf')).toBe('b.ttf: the file is empty.')
  })
  it('has a message for every local problem', () => {
    for (const problem of ['empty', 'too-large', 'unsupported', 'collection', 'corrupt'] as const) expect(describeFileProblem(problem).length).toBeGreaterThan(10)
  })
})
