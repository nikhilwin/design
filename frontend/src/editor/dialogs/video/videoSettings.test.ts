import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultVideoOptions } from '../../engine/export/video/options'
import { LOOP_COUNTS, describeEta, loadVideoSettings, loopChoiceOf, saveVideoSettings } from './videoSettings'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('video settings in storage', () => {
  it('start from the defaults of the format when nothing was saved', () => {
    expect(loadVideoSettings('d1', 'webm')).toEqual(defaultVideoOptions('webm'))
    expect(loadVideoSettings('d1', 'gif')).toEqual(defaultVideoOptions('gif'))
  })

  it('come back as they were saved, for this design only', () => {
    saveVideoSettings('d1', { ...defaultVideoOptions('mp4'), fps: 60, quality: 'high', pageSeconds: 3 })
    expect(loadVideoSettings('d1', 'mp4')).toMatchObject({ fps: 60, quality: 'high', pageSeconds: 3 })
    expect(loadVideoSettings('d2', 'mp4')).toEqual(defaultVideoOptions('mp4'))
  })

  it('follow the format asked for: a saved 60 fps is not offered to a GIF', () => {
    saveVideoSettings('d1', { ...defaultVideoOptions('mp4'), fps: 60, quality: 'high' })
    expect(loadVideoSettings('d1', 'gif')).toMatchObject({ format: 'gif', fps: 15, quality: 'high' })
  })

  it('are read field by field: broken storage gives the defaults', () => {
    localStorage.setItem('doory.editor.video.v1.d1', '{"fps": 999, "quality": "huge", "resolution": 720}')
    expect(loadVideoSettings('d1', 'mp4')).toMatchObject({ fps: 30, quality: 'balanced', resolution: 720 })
    localStorage.setItem('doory.editor.video.v1.d1', 'not json')
    expect(loadVideoSettings('d1', 'mp4')).toEqual(defaultVideoOptions('mp4'))
  })

  it('survive storage that throws, saving and loading alike', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(loadVideoSettings('d1', 'mp4')).toEqual(defaultVideoOptions('mp4'))
    expect(() => saveVideoSettings('d1', defaultVideoOptions('mp4'))).not.toThrow()
  })
})

describe('loop choice', () => {
  it('maps the three choices to counts and back', () => {
    expect(LOOP_COUNTS).toEqual({ forever: 0, once: 1, three: 3 })
    expect([0, 1, 3, 7].map(loopChoiceOf)).toEqual(['forever', 'once', 'three', 'three'])
  })
})

describe('describeEta', () => {
  it('reads as a person would say it', () => {
    expect(describeEta(300)).toBe('under a second')
    expect(describeEta(12_400)).toBe('12 s')
    expect(describeEta(65_000)).toBe('1 min 5 s')
    expect(describeEta(600_000)).toBe('10 min 0 s')
  })
})
