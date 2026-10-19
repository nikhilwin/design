import { isApiError } from '@/lib/api'
import { asFile, buildSfnt } from '../test/fontBuilder'
import { createMemoryUserFonts } from './memoryFonts'

const file = (family: string, weightClass: number, name = `${family}-${weightClass}.ttf`) => asFile(buildSfnt({ family, weightClass }), name)

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:font')
})

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (isApiError(error)) return { status: error.status, code: error.code }
  }
  return null
}

describe('in-memory user fonts', () => {
  it('stores a family with the weight and style read from the file and extends it with the next upload', async () => {
    const fonts = createMemoryUserFonts()
    const first = await fonts.upload({ files: [file('Brand Sans', 400)] })
    expect(first.family).toBe('Brand Sans')
    expect(first.variants.map((v) => v.weight)).toEqual([400])
    const second = await fonts.upload({ files: [file('Brand Sans', 700)] })
    expect(second.id).toBe(first.id)
    expect(second.variants.map((v) => v.weight)).toEqual([400, 700])
    expect(await fonts.list()).toHaveLength(1)
  })

  it('answers with the codes of the server: taken names, existing variants, the family limit', async () => {
    const fonts = createMemoryUserFonts({ reserved: ['Inter'] })
    expect(await failure(fonts.upload({ files: [file('Inter', 400)] }))).toEqual({ status: 409, code: 'font_name_taken' })
    expect((await fonts.upload({ files: [file('Inter', 400)], family: 'My Inter' })).family).toBe('My Inter')
    await fonts.upload({ files: [file('Brand Sans', 400)] })
    expect(await failure(fonts.upload({ files: [file('Brand Sans', 400, 'again.ttf')] }))).toEqual({ status: 409, code: 'variant_exists' })
    for (let i = 0; i < 48; i++) await fonts.upload({ files: [file(`Family ${i}`, 400)] })
    expect(await failure(fonts.upload({ files: [file('One Too Many', 400)] }))).toEqual({ status: 403, code: 'font_limit_reached' })
  })

  it('rejects a file that is not a font as a validation error and removes families', async () => {
    const fonts = createMemoryUserFonts()
    expect(await failure(fonts.upload({ files: [new File(['nope'], 'x.ttf')] }))).toEqual({ status: 400, code: 'validation_error' })
    const family = await fonts.upload({ files: [file('Brand Sans', 400)] })
    await fonts.remove(family.id)
    expect(await fonts.list()).toEqual([])
  })
})
