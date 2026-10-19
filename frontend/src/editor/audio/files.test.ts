import { describe, expect, it } from 'vitest'
import { AudioFileError, audioFilesFrom, looksLikeAudio, nameFromFile, nextVoiceoverName, validateAudioFile } from './files'

const file = (name: string, type: string, size = 1000): Pick<File, 'name' | 'type' | 'size'> => ({ name, type, size })

describe('looksLikeAudio', () => {
  it.each([
    ['a.mp3', 'audio/mpeg', true],
    ['a.wav', 'audio/x-wav', true],
    ['a.m4a', 'audio/mp4', true],
    ['a.ogg', 'audio/ogg', true],
    ['a.webm', 'audio/webm;codecs=opus', true],
    ['voice.weba', 'video/webm', true],
    ['a.mp3', '', true],
    ['a.opus', '', true],
    ['a.png', 'image/png', false],
    ['a.mp4', 'video/mp4', false],
    ['a.txt', '', false],
    ['song', '', false],
    ['a.svg', 'image/svg+xml', false],
  ])('%s (%s) -> %s', (name, type, ok) => {
    expect(looksLikeAudio({ name, type })).toBe(ok)
  })
})

describe('validateAudioFile', () => {
  it('accepts audio up to 25 MB', () => {
    expect(() => validateAudioFile(file('a.mp3', 'audio/mpeg', 25 * 1024 * 1024))).not.toThrow()
  })

  it('says why a file is refused', () => {
    expect(() => validateAudioFile(file('a.png', 'image/png'))).toThrow(AudioFileError)
    expect(() => validateAudioFile(file('a.png', 'image/png'))).toThrow(/MP3, OGG, WAV, M4A or WebM/)
    expect(() => validateAudioFile(file('a.mp3', 'audio/mpeg', 26 * 1024 * 1024))).toThrow(/25 MB/)
    expect(() => validateAudioFile(file('a.mp3', 'audio/mpeg', 0))).toThrow(/empty/)
  })
})

describe('audioFilesFrom', () => {
  it('keeps only the audio of a drop', () => {
    const list = { files: [new File(['x'], 'a.mp3', { type: 'audio/mpeg' }), new File(['x'], 'b.png', { type: 'image/png' })] } as unknown as DataTransfer
    expect(audioFilesFrom(list).map((f) => f.name)).toEqual(['a.mp3'])
    expect(audioFilesFrom(null)).toEqual([])
  })
})

describe('names', () => {
  it('uses the file name without its extension', () => {
    expect(nameFromFile({ name: 'My Song.final.mp3' })).toBe('My Song.final')
    expect(nameFromFile({ name: 'C:\\music\\theme.wav' })).toBe('theme')
    expect(nameFromFile({ name: '.mp3' })).toBe('.mp3')
    expect(nameFromFile({ name: '' })).toBe('Audio')
  })

  it('numbers voiceovers', () => {
    expect(nextVoiceoverName([])).toBe('Voiceover 1')
    expect(nextVoiceoverName(['Voiceover 1', 'Voiceover 3'])).toBe('Voiceover 2')
  })
})
