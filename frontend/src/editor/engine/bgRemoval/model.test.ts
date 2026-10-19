import { MAX_MODEL_BYTES, parseModelDescriptor, sameModel } from './model'

const ORIGIN = 'https://doory.example'

const valid = () => ({
  id: 'u2netp',
  name: 'U²-Net (small)',
  url: '/media/models/u2netp/u2netp-309c8469258d.onnx',
  bytes: 4574861,
  sha256: 'a'.repeat(64),
  input: { name: 'input.1', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], rescale: 'max' },
  output: '1959',
})

describe('parseModelDescriptor', () => {
  it('accepts the server description and makes the URL absolute on the page origin', () => {
    const model = parseModelDescriptor(valid(), ORIGIN)
    expect(model).toEqual({
      id: 'u2netp',
      name: 'U²-Net (small)',
      url: 'https://doory.example/media/models/u2netp/u2netp-309c8469258d.onnx',
      bytes: 4574861,
      sha256: 'a'.repeat(64),
      input: { name: 'input.1', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], rescale: 'max' },
      output: '1959',
    })
  })

  it('accepts an absolute URL on the same origin', () => {
    const model = parseModelDescriptor({ ...valid(), url: 'https://doory.example/media/m.onnx' }, ORIGIN)
    expect(model?.url).toBe('https://doory.example/media/m.onnx')
  })

  it.each([
    ['another origin', { url: 'https://cdn.example/m.onnx' }],
    ['another port', { url: 'https://doory.example:8443/m.onnx' }],
    ['a protocol-relative URL to another host', { url: '//cdn.example/m.onnx' }],
    ['a javascript: URL', { url: 'javascript:alert(1)' }],
    ['a data: URL', { url: 'data:application/octet-stream;base64,AAAA' }],
    ['a blob: URL', { url: 'blob:https://doory.example/1234' }],
    ['credentials in the URL', { url: 'https://user:pw@doory.example/m.onnx' }],
    ['an empty URL', { url: '' }],
    ['a non-string URL', { url: 42 }],
    ['an overlong URL', { url: `/${'a'.repeat(3000)}` }],
    ['a missing id', { id: '' }],
    ['a non-string name', { name: 1 }],
    ['a malformed hash', { sha256: 'ABC' }],
    ['an upper-case hash', { sha256: 'A'.repeat(64) }],
    ['zero bytes', { bytes: 0 }],
    ['a fractional size', { bytes: 12.5 }],
    ['an absurd size', { bytes: MAX_MODEL_BYTES + 1 }],
    ['a string size', { bytes: '100' }],
    ['a bad output name', { output: 'out put!' }],
    ['no output', { output: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(parseModelDescriptor({ ...valid(), ...patch }, ORIGIN)).toBeNull()
  })

  it.each([
    ['a tiny input size', { size: 8 }],
    ['a huge input size', { size: 100000 }],
    ['a fractional input size', { size: 320.5 }],
    ['a bad tensor name', { name: 'a b' }],
    ['two means', { mean: [0.5, 0.5] }],
    ['a mean above 1', { mean: [0.5, 2, 0.5] }],
    ['a non-numeric mean', { mean: [0.5, '0.5', 0.5] }],
    ['NaN in the mean', { mean: [0.5, Number.NaN, 0.5] }],
    ['a zero std', { std: [1, 0, 1] }],
    ['an infinite std', { std: [1, Infinity, 1] }],
    ['an unknown rescale', { rescale: 'none' }],
  ])('rejects %s', (_label, patch) => {
    expect(parseModelDescriptor({ ...valid(), input: { ...valid().input, ...patch } }, ORIGIN)).toBeNull()
  })

  it.each([null, undefined, 'model', 42, [], { ...valid(), input: undefined }, { ...valid(), input: [] }])('rejects %j', (raw) => {
    expect(parseModelDescriptor(raw, ORIGIN)).toBeNull()
  })

  it('does not copy unknown fields into the descriptor', () => {
    const model = parseModelDescriptor({ ...valid(), evil: 'x', input: { ...valid().input, extra: 1 } }, ORIGIN)
    expect(model).not.toBeNull()
    expect(Object.keys(model ?? {}).sort()).toEqual(['bytes', 'id', 'input', 'name', 'output', 'sha256', 'url'])
    expect(Object.keys(model?.input ?? {}).sort()).toEqual(['mean', 'name', 'rescale', 'size', 'std'])
  })

  it('defaults to the page origin', () => {
    expect(parseModelDescriptor(valid())?.url).toBe(`${location.origin}/media/models/u2netp/u2netp-309c8469258d.onnx`)
  })
})

describe('sameModel', () => {
  it('compares id, URL and hash', () => {
    const a = parseModelDescriptor(valid(), ORIGIN)!
    expect(sameModel(a, { ...a })).toBe(true)
    expect(sameModel(a, { ...a, id: 'other' })).toBe(false)
    expect(sameModel(a, { ...a, url: `${a.url}2` })).toBe(false)
    expect(sameModel(a, { ...a, sha256: 'b'.repeat(64) })).toBe(false)
    expect(sameModel(a, { ...a, name: 'renamed' })).toBe(true)
  })
})
