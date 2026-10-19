import { describe, expect, it } from 'vitest'
import type { AudioTrack, TrackCredit } from '@/types/document'
import { creditLine, creditsText, requiredCredits } from './credits'
import { normalizeCredit, normalizeTrack } from './model'

const BY: TrackCredit = { source: 'freesound', id: '5', title: 'Rainy Lo-fi', author: 'jdoe', url: 'https://freesound.org/people/jdoe/sounds/5/', license: 'CC BY 4.0', required: true }
const CC0: TrackCredit = { source: 'freesound', id: '6', title: 'Click', author: 'x', url: '', license: 'CC0 1.0', required: false }

const track = (id: string, kind: AudioTrack['kind'], credit?: TrackCredit): AudioTrack => ({
  id,
  kind,
  name: id,
  src: `/media/${id}.ogg`,
  scope: { type: 'design' },
  startMs: 0,
  trimStartMs: 0,
  trimEndMs: 1000,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  muted: false,
  ...(credit ? { credit } : {}),
})

describe('credits', () => {
  it('writes the same line as the server', () => {
    expect(creditLine(BY, 'music')).toBe('Music: "Rainy Lo-fi" by jdoe (freesound.org/people/jdoe/sounds/5), CC BY 4.0')
    expect(creditLine({ ...BY, author: '', url: '' }, 'sfx')).toBe('Sound: "Rainy Lo-fi", CC BY 4.0')
  })

  it('lists each required credit once, in track order, and skips CC0', () => {
    const tracks = [track('a', 'sfx', CC0), track('b', 'music', BY), track('c', 'music', BY), track('d', 'upload')]
    expect(requiredCredits(tracks).map((c) => c.credit.id)).toEqual(['5'])
    expect(creditsText(tracks)).toBe(creditLine(BY, 'music'))
    expect(creditsText([track('a', 'sfx', CC0)])).toBe('')
  })

  it('keeps a valid credit on a track and drops a broken or unsafe one', () => {
    expect(normalizeTrack(track('a', 'music', BY))?.credit).toEqual(BY)
    expect(normalizeCredit({ title: 'X' })).toBeNull()
    expect(normalizeCredit('nope')).toBeNull()
    const odd = normalizeCredit({ ...BY, url: 'javascript:alert(1)', required: 'yes' })
    expect(odd).toMatchObject({ url: '', required: false })
  })
})
