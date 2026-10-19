// Development helper: octave-band levels of an encoded file (dB relative to the loudest band).
import { spectrum } from './analysis.mjs'
import { decode } from './media.mjs'
const [file, channels = '2'] = process.argv.slice(2)
const ch = decode(file, Number(channels))
const { power, binHz } = spectrum(ch, 8192)
const centres = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const levels = centres.map((c) => {
  let sum = 0
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz
    if (f >= c / Math.SQRT2 && f < c * Math.SQRT2) sum += power[k]
  }
  return 10 * Math.log10(sum + 1e-20)
})
const top = Math.max(...levels)
console.log(file.split('/').pop().padEnd(26), levels.map((l, i) => `${centres[i]}:${(l - top).toFixed(0)}`).join('  '))
