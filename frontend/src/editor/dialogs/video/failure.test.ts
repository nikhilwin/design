import { describe, expect, it } from 'vitest'
import { type VideoErrorCode, VideoExportError } from '../../engine/export/video/errors'
import { t } from '../../strings'
import { describeVideoFailure } from './failure'

const CODES: VideoErrorCode[] = ['invalid-options', 'no-pages', 'too-long', 'unsupported', 'memory', 'gif-too-large', 'encoder', 'render']

describe('describeVideoFailure', () => {
  it('says nothing about a cancellation', () => {
    expect(describeVideoFailure(new DOMException('Export cancelled', 'AbortError'))).toBeNull()
  })

  it.each(CODES)('has a message and something to do about it for %s', (code) => {
    const failure = describeVideoFailure(new VideoExportError(code, 'internal', 'what the browser said'))!
    expect(failure.code).toBe(code)
    expect(failure.message).toBe(t.video.problems[code])
    expect(failure.hint).toBe(t.video.problems[`${code}-hint`])
    expect(failure.message.length).toBeGreaterThan(10)
    expect(failure.hint.length).toBeGreaterThan(10)
    expect(failure.detail).toBe('what the browser said')
  })

  it('offers a retry only for what can pass by itself: an encoder, memory, a picture that did not load', () => {
    const retryable = CODES.filter((code) => describeVideoFailure(new VideoExportError(code, 'x'))!.retryable)
    expect(retryable).toEqual(['memory', 'encoder', 'render'])
  })

  it('treats anything else as a failure to make the file, keeping the browser\'s words for the details', () => {
    expect(describeVideoFailure(new Error('font would not load'))).toMatchObject({ code: 'render', detail: 'font would not load', retryable: true })
    expect(describeVideoFailure('nonsense')).toMatchObject({ code: 'render', detail: null })
  })
})
