/**
 * Colours shared by the designs. Every design has a palette of its own; each palette has the same eleven steps
 * (50 = lightest, 950 = darkest) at the same lightness as the others, so the contrast checks of a design hold
 * whichever palette it uses.
 */
export type Scale = Readonly<Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950, string>>

export const PALETTES = {
  tangerine: { 50: '#fef2ea', 100: '#fce3d4', 200: '#f9ceb5', 300: '#f3aa80', 400: '#ec7838', 500: '#e1560c', 600: '#c84c0a', 700: '#a63f09', 800: '#8b3507', 900: '#712a06', 950: '#3c1603' },
  violet: { 50: '#f6f2ff', 100: '#ebe5fe', 200: '#dbd0fd', 300: '#c3b0fb', 400: '#a385f9', 500: '#8f6af7', 600: '#7e53f6', 700: '#673ae8', 800: '#5630c4', 900: '#44269f', 950: '#241358' },
  forest: { 50: '#f1f6f0', 100: '#e3eae4', 200: '#cdd9d0', 300: '#acbfb2', 400: '#819f8d', 500: '#698c77', 600: '#567c66', 700: '#3d6950', 800: '#335843', 900: '#274635', 950: '#11251b' },
  emerald: { 50: '#ebf7f3', 100: '#d9ece6', 200: '#bdddd3', 300: '#92c4b5', 400: '#5ca58f', 500: '#3a9278', 600: '#1e8264', 700: '#0e6d51', 800: '#0b5b43', 900: '#094936', 950: '#05271c' },
  teal: { 50: '#eaf7f5', 100: '#d9edea', 200: '#beddd9', 300: '#93c3bf', 400: '#5da39e', 500: '#3c908a', 600: '#218179', 700: '#0e6c64', 800: '#0b5b54', 900: '#094843', 950: '#042724' },
  indigo: { 50: '#f5f3fd', 100: '#eae5f9', 200: '#d9d2f3', 300: '#beb3e9', 400: '#9c8edc', 500: '#8775d4', 600: '#7863cf', 700: '#624bc6', 800: '#513cb0', 900: '#402f8f', 950: '#221752' },
  slate: { 50: '#f1f5f6', 100: '#e3eaec', 200: '#ced7db', 300: '#aebcc3', 400: '#879ca5', 500: '#6f8892', 600: '#5c7784', 700: '#456472', 800: '#335563', 900: '#284350', 950: '#12232c' },
  synth: { 50: '#fef0f8', 100: '#fce1f0', 200: '#f8c9e3', 300: '#f3a1ce', 400: '#eb6ab1', 500: '#e5409b', 600: '#e0218a', 700: '#b31b74', 800: '#971766', 900: '#771357', 950: '#3d0c3b' },
  amber: { 50: '#fdf2e9', 100: '#fae5d7', 200: '#f6cdba', 300: '#eeab8e', 400: '#e47b51', 500: '#dd5925', 600: '#ce450f', 700: '#ab3a0e', 800: '#8f310d', 900: '#73280c', 950: '#3b170b' },
  terracotta: { 50: '#fbf2ef', 100: '#f5e5df', 200: '#ebd1c7', 300: '#ddb1a1', 400: '#ca8872', 500: '#bf6d53', 600: '#b5583a', 700: '#984930', 800: '#803d28', 900: '#67311f', 950: '#37190f' },
  dusk: { 50: '#fff3e8', 100: '#ffe3d0', 200: '#ffcbaf', 300: '#ffa289', 400: '#ef6e85', 500: '#dd4f87', 600: '#ca3c84', 700: '#a4327c', 800: '#7f307b', 900: '#592c72', 950: '#22194d' },
} as const satisfies Record<string, Scale>

export const INK = '#1c1517'
export const MUTED = '#6b6165'
export const WHITE = '#ffffff'
