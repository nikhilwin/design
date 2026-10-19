// Development helper: render one music track and print its measurements.
//   node render-music.mjs sunrise-run [--wav out.wav]
import { writeFileSync } from 'node:fs'
import { MUSIC } from './catalog.mjs'
import { compose } from './moods.mjs'
import { floatWav } from './wav.mjs'

const id = process.argv[2]
const wav = process.argv.includes('--wav') ? process.argv[process.argv.indexOf('--wav') + 1] : null
const spec = MUSIC.find((t) => t.id === id)
if (!spec) throw new Error(`unknown track ${id}`)
const started = Date.now()
const { song, mix } = compose(spec)
const composed = Date.now()
const result = song.render(mix)
console.log(`${id}: ${song.seconds.toFixed(2)} s, ${song.length} samples; composed in ${composed - started} ms, mixed in ${Date.now() - composed} ms`)
console.log(`LUFS ${result.lufs.toFixed(2)}  peak ${result.peakDb.toFixed(2)} dBFS  true peak ${result.truePeakDb.toFixed(2)} dBTP`)
if (wav) writeFileSync(wav, floatWav([result.audio.l, result.audio.r]))
