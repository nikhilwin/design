import { evaluatePassword } from './password'

describe('evaluatePassword', () => {
  it('scores empty input as too weak with no checks passed', () => {
    const result = evaluatePassword('')
    expect(result.score).toBe(0)
    expect(result.label).toBe('Too weak')
    expect(result.acceptable).toBe(false)
    expect(result.checks.every((check) => !check.passed)).toBe(true)
  })

  it('rejects short, numeric-only and very common passwords', () => {
    expect(evaluatePassword('abc12').acceptable).toBe(false)
    expect(evaluatePassword('12345678').acceptable).toBe(false)
    expect(evaluatePassword('password').acceptable).toBe(false)
  })

  it('accepts reasonable passwords and rewards length and variety', () => {
    expect(evaluatePassword('sunny-days').acceptable).toBe(true)
    expect(evaluatePassword('sunnydays').score).toBe(2)
    expect(evaluatePassword('Sunny-days-42').score).toBe(4)
    expect(evaluatePassword('Sunny-days-42').label).toBe('Strong')
    expect(evaluatePassword('sunny-days1').score).toBe(3)
  })

  it('reports each rule independently', () => {
    const checks = Object.fromEntries(evaluatePassword('abcdefgh').checks.map((check) => [check.id, check.passed]))
    expect(checks).toEqual({ length: true, letters: true, variety: false })
  })
})
