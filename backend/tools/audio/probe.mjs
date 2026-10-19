// Development helper: measurements of a rendered track (not part of the pipeline).
import { MUSIC } from './catalog.mjs'
import { compose } from './moods.mjs'
import { SCALES, NOTE } from './theory.mjs'
import { bands, clippedSamples, correlation, dcOffset, inKeyShare, longestSilence, peaks, seam, tempo } from './analysis.mjs'
import { rms, toDb } from './loudness.mjs'

const id = process.argv[2]
const spec = MUSIC.find((t) => t.id === id)
const { song, mix } = compose(spec)
for (const [name, bus] of Object.entries(song.bus)) console.log(`bus ${name.padEnd(6)} rms ${toDb(rms([bus.l, bus.r])).toFixed(1)} dBFS`)
console.log(`reverb send rms ${toDb(rms([song.revSend.l])).toFixed(1)}`)
const r = song.render(mix)
const ch = [r.audio.l, r.audio.r]
console.log(`LUFS ${r.lufs.toFixed(2)} peak ${r.peakDb.toFixed(2)} tp ${r.truePeakDb.toFixed(2)}`)
const b = bands(ch)
console.log('bands', Object.entries(b.share).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join('  '), 'centroid', b.centroid.toFixed(0))
const cls = SCALES[spec.scale].map((d) => (NOTE[spec.key] + d) % 12)
console.log('tempo', tempo(ch), 'spec', spec.bpm, 'inKey', inKeyShare(ch, cls).toFixed(2), 'seam', JSON.stringify(seam(ch)))
console.log('clipped', clippedSamples(ch), 'dc', dcOffset(ch).toExponential(2), 'silence', longestSilence(ch).toFixed(2), 'corr', correlation(r.audio.l, r.audio.r).toFixed(2))
console.log('peaks', peaks(ch, 24).join(' '))
