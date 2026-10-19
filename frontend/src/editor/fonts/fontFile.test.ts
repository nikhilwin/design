import { asFile, buildSfnt, buildWoff } from '../test/fontBuilder'
import { FontFileError, MAX_FONT_BYTES, cleanFamilyName, fontExtension, formatBytes, normaliseWeight, readFontInfo, sniffFormat, variantLabel } from './fontFile'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

describe('sniffFormat', () => {
  it('recognises the containers by their first four bytes, never by name', () => {
    expect(sniffFormat(bytes(0, 1, 0, 0))).toBe('ttf')
    expect(sniffFormat(bytes(0x74, 0x72, 0x75, 0x65))).toBe('ttf')
    expect(sniffFormat(bytes(0x4f, 0x54, 0x54, 0x4f))).toBe('otf')
    expect(sniffFormat(bytes(0x77, 0x4f, 0x46, 0x46))).toBe('woff')
    expect(sniffFormat(bytes(0x77, 0x4f, 0x46, 0x32))).toBe('woff2')
    expect(sniffFormat(bytes(0x74, 0x74, 0x63, 0x66))).toBe('collection')
  })
  it('returns null for anything else and for short input', () => {
    expect(sniffFormat(bytes(0x25, 0x50, 0x44, 0x46))).toBeNull()
    expect(sniffFormat(bytes(0, 1))).toBeNull()
  })
})

describe('readFontInfo', () => {
  it('reads family, weight and style from a TrueType file', async () => {
    const info = await readFontInfo(buildSfnt({ family: 'Brand Sans', weightClass: 700, italicSelection: true }))
    expect(info).toEqual({ format: 'ttf', family: 'Brand Sans', weight: 700, style: 'italic' })
  })

  it('reads an OpenType file and prefers the typographic family over the style-linked one', async () => {
    const info = await readFontInfo(buildSfnt({ family: 'Brand Sans Light', typographicFamily: 'Brand Sans', weightClass: 300 }, 'otf'))
    expect(info).toEqual({ format: 'otf', family: 'Brand Sans', weight: 300, style: 'normal' })
  })

  it('reads Mac Roman names', async () => {
    expect((await readFontInfo(buildSfnt({ family: 'Old School', platform: 'mac' }))).family).toBe('Old School')
  })

  it('treats the head macStyle bits and a slanted post table as bold and italic, like the server', async () => {
    expect(await readFontInfo(buildSfnt({ family: 'A', weightClass: 0, macStyle: 1 }))).toMatchObject({ weight: 700, style: 'normal' })
    expect(await readFontInfo(buildSfnt({ family: 'A', macStyle: 2 }))).toMatchObject({ style: 'italic' })
    expect(await readFontInfo(buildSfnt({ family: 'A', italicAngle: -12 }))).toMatchObject({ style: 'italic' })
  })

  it('unpacks the tables of a compressed WOFF file', async () => {
    const info = await readFontInfo(buildWoff({ family: 'Web Face', weightClass: 600 }))
    expect(info).toEqual({ format: 'woff', family: 'Web Face', weight: 600, style: 'normal' })
  })

  it('reads a WOFF file whose tables are stored uncompressed', async () => {
    expect(await readFontInfo(buildWoff({ family: 'Plain Web', weightClass: 500 }, false))).toMatchObject({ family: 'Plain Web', weight: 500 })
  })

  it('leaves WOFF2 to the server: the platform cannot unpack Brotli', async () => {
    const buffer = new Uint8Array(64)
    buffer.set([0x77, 0x4f, 0x46, 0x32], 0)
    expect(await readFontInfo(buffer.buffer)).toEqual({ format: 'woff2', family: null, weight: null, style: null })
  })

  it('applies the server rules to the family name', async () => {
    expect((await readFontInfo(buildSfnt({ family: '  <Brand>  Sans!! ' }))).family).toBe('Brand Sans')
  })

  const reason = async (buffer: ArrayBuffer): Promise<string> => {
    try {
      await readFontInfo(buffer)
    } catch (error) {
      return error instanceof FontFileError ? error.problem : `other: ${String(error)}`
    }
    return 'accepted'
  }

  it('rejects empty, oversized, unknown and collection files', async () => {
    expect(await reason(new ArrayBuffer(0))).toBe('empty')
    expect(await reason(new ArrayBuffer(MAX_FONT_BYTES + 1))).toBe('too-large')
    expect(await reason(new TextEncoder().encode('%PDF-1.7 not a font').buffer as ArrayBuffer)).toBe('unsupported')
    expect(await reason(Uint8Array.from([0x74, 0x74, 0x63, 0x66, 0, 0, 0, 0]).buffer)).toBe('collection')
  })

  it('rejects truncated and inconsistent files instead of reading out of bounds', async () => {
    const good = buildSfnt({ family: 'Brand Sans' })
    expect(await reason(good.slice(0, 20))).toBe('corrupt')
    expect(await reason(good.slice(0, good.byteLength - 40))).toBe('corrupt')
    const noTables = Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(await reason(noTables.buffer)).toBe('corrupt')
    const woff = new Uint8Array(buildWoff({ family: 'X' }))
    new DataView(woff.buffer).setUint32(44 + 4, 0x7fffffff)
    expect(await reason(woff.buffer)).toBe('corrupt')
  })

  it('refuses to inflate a table that claims to be huge', async () => {
    const woff = new Uint8Array(buildWoff({ family: 'X' }))
    const view = new DataView(woff.buffer)
    for (let i = 0; i < view.getUint16(12); i++) view.setUint32(44 + i * 20 + 12, 64 * 1024 * 1024)
    expect(await reason(woff.buffer)).toBe('corrupt')
  })

  it('rejects a font without a readable family name', async () => {
    expect(await reason(buildSfnt({ family: '' }))).toBe('corrupt')
  })
})

describe('naming helpers', () => {
  it('cleans family names the way the server does', () => {
    expect(cleanFamilyName('  Fira  Code (Retina)_ ')).toBe('Fira Code (Retina)')
    expect(cleanFamilyName('Ünï "quoted" <b>')).toBe('Ünï quoted b')
    expect(cleanFamilyName('---')).toBe('')
    expect(cleanFamilyName('x'.repeat(300))).toHaveLength(100)
  })
  it('rounds weights to hundreds inside 100..900', () => {
    expect(normaliseWeight(450, false)).toBe(500)
    expect(normaliseWeight(950, false)).toBe(900)
    expect(normaliseWeight(0, true)).toBe(700)
    expect(normaliseWeight(0, false)).toBe(400)
    expect(normaliseWeight(1200, false)).toBe(400)
  })
  it('names variants', () => {
    expect(variantLabel(400, 'normal')).toBe('Regular')
    expect(variantLabel(400, 'italic')).toBe('Italic')
    expect(variantLabel(700, 'italic')).toBe('Bold Italic')
    expect(variantLabel(300, 'normal')).toBe('Light')
    expect(variantLabel(250, 'normal')).toBe('Light')
  })
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })
  it('accepts the four extensions in any case', () => {
    expect(fontExtension('Brand.TTF')).toBe('ttf')
    expect(fontExtension('a.b.woff2')).toBe('woff2')
    expect(fontExtension('brand.pdf')).toBeNull()
    expect(fontExtension('brand')).toBeNull()
  })
  it('builds files for the dialog tests', () => {
    expect(asFile(buildSfnt({ family: 'A' }), 'a.ttf').name).toBe('a.ttf')
  })
})
