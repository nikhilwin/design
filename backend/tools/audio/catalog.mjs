// The library: 24 loopable music tracks (eight moods, three each) and the sound effects. Names, tempos, keys
// and chord progressions are original; the music is synthesised by moods.mjs, the effects by effects.mjs.

const M = 'maj'
const m = 'min'

/** [semitones above the tonic, chord type] */
const prog = (...chords) => chords

export const MUSIC = [
  // ---- upbeat
  { id: 'sunrise-run', title: 'Sunrise Run', mood: 'upbeat', genre: 'pop', tags: ['happy', 'energetic', 'intro', 'summer'], bpm: 124, bars: 16, key: 'C', scale: 'major', prog: prog([0, M], [7, M], [9, m], [5, M]), lead: 'square', bass: 'saw', leadLow: 67 },
  { id: 'good-morning-energy', title: 'Good Morning Energy', mood: 'upbeat', genre: 'pop', tags: ['positive', 'bright', 'vlog', 'morning'], bpm: 120, bars: 16, key: 'G', scale: 'major', prog: prog([9, m], [5, M], [0, M], [7, M]), lead: 'saw', bass: 'saw', shaker: true, leadLow: 69, arp: [0, 1, 2, 3, 2, 1, 3, 2] },
  { id: 'bright-side', title: 'Bright Side', mood: 'upbeat', genre: 'dance', tags: ['feel good', 'party', 'dance', 'promo'], bpm: 128, bars: 16, key: 'D', scale: 'major', prog: prog([0, M], [5, M], [9, m], [7, M]), lead: 'saw', bass: 'saw', shaker: true, leadLow: 69, arp: [0, 2, 3, 1, 3, 2, 1, 2] },
  // ---- calm
  { id: 'still-water', title: 'Still Water', mood: 'calm', genre: 'ambient', tags: ['peaceful', 'piano', 'relax', 'meditation'], bpm: 68, bars: 12, key: 'C', scale: 'major', prog: prog([0, 'maj7'], [9, 'min7'], [5, 'maj7'], [7, 'dom7']), keys: 'piano', mallet: 'glock' },
  { id: 'morning-mist', title: 'Morning Mist', mood: 'calm', genre: 'ambient', tags: ['soft', 'dreamy', 'wellness', 'slow'], bpm: 72, bars: 12, key: 'F', scale: 'lydian', prog: prog([0, 'maj9'], [9, 'min7'], [2, 'min7'], [7, 'sus4']), keys: 'epiano', mallet: 'kalimba' },
  { id: 'gentle-tide', title: 'Gentle Tide', mood: 'calm', genre: 'ambient', tags: ['harp', 'gentle', 'spa', 'sleep'], bpm: 64, bars: 12, key: 'A', scale: 'minor', prog: prog([0, 'min9'], [8, 'maj7'], [3, M], [10, M]), keys: 'harp', mallet: 'vibes' },
  // ---- cinematic
  { id: 'rising-horizon', title: 'Rising Horizon', mood: 'cinematic', genre: 'orchestral', tags: ['epic', 'trailer', 'drums', 'build'], bpm: 90, bars: 16, key: 'D', scale: 'minor', prog: prog([0, m], [8, M], [3, M], [10, M]), taiko: 58, ostinato: 0.42 },
  { id: 'epic-journey', title: 'Epic Journey', mood: 'cinematic', genre: 'orchestral', tags: ['adventure', 'heroic', 'film', 'bells'], bpm: 100, bars: 16, key: 'E', scale: 'minor', prog: prog([0, m], [8, M], [10, M], [7, m]), taiko: 55, melody: 'bell', ostinato: 0.38 },
  { id: 'vast-skies', title: 'Vast Skies', mood: 'cinematic', genre: 'ambient', tags: ['atmospheric', 'documentary', 'wide', 'slow'], bpm: 80, bars: 16, key: 'A', scale: 'dorian', prog: prog([0, m], [5, M], [8, M], [3, M]), taiko: 52, melody: 'bell', ostinato: 0.3 },
  // ---- lofi
  { id: 'rainy-window', title: 'Rainy Window', mood: 'lofi', genre: 'lo-fi hip hop', tags: ['chill', 'study', 'jazzy', 'vinyl'], bpm: 76, bars: 16, key: 'C', scale: 'major', prog: prog([2, 'min7'], [7, 'dom7'], [0, 'maj7'], [9, 'min7']), swing: 0.6, keys: 'epiano', lead: 'epiano' },
  { id: 'late-night-study', title: 'Late Night Study', mood: 'lofi', genre: 'lo-fi hip hop', tags: ['focus', 'guitar', 'night', 'mellow'], bpm: 82, bars: 16, key: 'F', scale: 'major', prog: prog([2, 'min7'], [7, 'dom7'], [0, 'maj9'], [5, 'maj7']), swing: 0.55, keys: 'guitar', lead: 'kalimba', comp: [0, 2.5] },
  { id: 'coffee-break', title: 'Coffee Break', mood: 'lofi', genre: 'lo-fi jazz', tags: ['cafe', 'relaxed', 'warm', 'tape'], bpm: 88, bars: 16, key: 'Eb', scale: 'major', prog: prog([0, 'maj7'], [9, 'min7'], [2, 'min7'], [7, 'dom7']), swing: 0.5, keys: 'epiano', lead: 'epiano', comp: [0.5, 2], crackle: 8 },
  // ---- corporate
  { id: 'forward-motion', title: 'Forward Motion', mood: 'corporate', genre: 'corporate pop', tags: ['business', 'presentation', 'success', 'positive'], bpm: 108, bars: 16, key: 'C', scale: 'major', prog: prog([0, M], [7, M], [9, m], [5, M]), arp: 'synth', lead: 'vibes', melodyLow: 69 },
  { id: 'clear-vision', title: 'Clear Vision', mood: 'corporate', genre: 'tech', tags: ['technology', 'innovation', 'startup', 'clean'], bpm: 100, bars: 16, key: 'E', scale: 'major', prog: prog([0, M], [9, m], [5, M], [7, M]), arp: 'synth', lead: 'marimba', melodyLow: 71 },
  { id: 'team-spirit', title: 'Team Spirit', mood: 'corporate', genre: 'acoustic pop', tags: ['teamwork', 'inspiring', 'piano', 'explainer'], bpm: 112, bars: 16, key: 'Bb', scale: 'major', prog: prog([0, M], [5, M], [9, m], [7, M]), arp: 'piano', lead: 'vibes', melodyLow: 70 },
  // ---- playful
  { id: 'jelly-bounce', title: 'Jelly Bounce', mood: 'playful', genre: 'quirky', tags: ['fun', 'kids', 'cartoon', 'bouncy'], bpm: 116, bars: 16, key: 'C', scale: 'major', prog: prog([0, M], [5, M], [0, M], [7, 'dom7']), lead: 'marimba' },
  { id: 'pogo-parade', title: 'Pogo Parade', mood: 'playful', genre: 'quirky', tags: ['happy', 'toys', 'upbeat', 'cheeky'], bpm: 126, bars: 16, key: 'F', scale: 'major', prog: prog([0, M], [9, m], [2, m], [7, 'dom7']), lead: 'glock' },
  { id: 'tiny-circus', title: 'Tiny Circus', mood: 'playful', genre: 'polka', tags: ['circus', 'silly', 'comedy', 'march'], bpm: 132, bars: 20, key: 'G', scale: 'major', prog: prog([0, M], [7, 'dom7']), polka: true, lead: 'marimba' },
  // ---- romantic
  { id: 'candlelight', title: 'Candlelight', mood: 'romantic', genre: 'ballad', tags: ['love', 'wedding', 'piano', 'tender'], bpm: 66, bars: 12, key: 'F', scale: 'major', prog: prog([0, M], [4, m], [5, M], [7, M]), keys: 'piano', lead: 'sine' },
  { id: 'slow-dance', title: 'Slow Dance', mood: 'romantic', genre: 'soul', tags: ['smooth', 'evening', 'warm', 'anniversary'], bpm: 72, bars: 12, key: 'Eb', scale: 'major', prog: prog([9, 'min7'], [5, 'maj7'], [0, M], [7, 'dom7']), keys: 'epiano', lead: 'tri' },
  { id: 'first-kiss', title: 'First Kiss', mood: 'romantic', genre: 'cinematic romance', tags: ['harp', 'sweet', 'dreamy', 'slow'], bpm: 60, bars: 12, key: 'D', scale: 'major', prog: prog([0, M], [7, M], [9, m], [4, m]), keys: 'harp', lead: 'sine' },
  // ---- dramatic
  { id: 'tension-rising', title: 'Tension Rising', mood: 'dramatic', genre: 'thriller', tags: ['suspense', 'urgent', 'trailer', 'strings'], bpm: 110, bars: 16, key: 'C', scale: 'harmonicMinor', prog: prog([0, m], [8, M], [5, m], [7, M]) },
  { id: 'final-stand', title: 'Final Stand', mood: 'dramatic', genre: 'action', tags: ['battle', 'intense', 'drums', 'power'], bpm: 120, bars: 16, key: 'A', scale: 'minor', prog: prog([0, m], [8, M], [3, M], [10, M]), pulse: 'offbeat', pulseGain: 0.42 },
  { id: 'dark-pulse', title: 'Dark Pulse', mood: 'dramatic', genre: 'dark electronic', tags: ['mystery', 'night', 'tech', 'heavy'], bpm: 100, bars: 16, key: 'F#', scale: 'minor', prog: prog([0, m], [10, M], [8, M], [10, M]) },
]

export const MOODS = ['upbeat', 'calm', 'cinematic', 'lofi', 'corporate', 'playful', 'romantic', 'dramatic']
