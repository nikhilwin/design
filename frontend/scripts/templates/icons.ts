/**
 * A small set of line icons drawn for these templates on a 24 x 24 grid (round caps, no fill). They are plain paths, so
 * recolouring is just changing the stroke. Only absolute path commands are used, which `scalePath` can place and size.
 */
export type IconName = 'mail' | 'phone' | 'globe' | 'pin' | 'check' | 'calendar' | 'clock' | 'arrowRight' | 'user' | 'briefcase' | 'cap' | 'link' | 'heart'

export const ICONS: Record<IconName, string> = {
  mail: 'M5 5H19A2 2 0 0 1 21 7V17A2 2 0 0 1 19 19H5A2 2 0 0 1 3 17V7A2 2 0 0 1 5 5Z M3.5 7.5L12 13.5L20.5 7.5',
  phone: 'M8 2.5H16A1.5 1.5 0 0 1 17.5 4V20A1.5 1.5 0 0 1 16 21.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5Z M10.5 18.5H13.5',
  globe: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12Z M3 12H21 M12 3C15.5 6.5 15.5 17.5 12 21C8.5 17.5 8.5 6.5 12 3Z',
  pin: 'M12 21.5C12 21.5 5 15.5 5 9.5A7 7 0 0 1 19 9.5C19 15.5 12 21.5 12 21.5Z M14.5 9.5A2.5 2.5 0 1 1 9.5 9.5A2.5 2.5 0 1 1 14.5 9.5Z',
  check: 'M5 12.5L10 17.5L19 7.5',
  calendar: 'M5 4.5H19A1.5 1.5 0 0 1 20.5 6V19A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z M3.5 9.5H20.5 M8 2.5V6.5 M16 2.5V6.5',
  clock: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12Z M12 6.5V12L15.5 14',
  arrowRight: 'M4 12H19 M13 6L19 12L13 18',
  user: 'M16.5 7.5A4.5 4.5 0 1 1 7.5 7.5A4.5 4.5 0 1 1 16.5 7.5Z M4 21C4 16.5 7.5 14 12 14C16.5 14 20 16.5 20 21',
  briefcase: 'M4 7.5H20A1.5 1.5 0 0 1 21.5 9V19A1.5 1.5 0 0 1 20 20.5H4A1.5 1.5 0 0 1 2.5 19V9A1.5 1.5 0 0 1 4 7.5Z M8.5 7.5V5.5A1.5 1.5 0 0 1 10 4H14A1.5 1.5 0 0 1 15.5 5.5V7.5 M2.5 13H21.5',
  cap: 'M12 4L22 9L12 14L2 9Z M6 11.5V16C6 17.5 8.5 19 12 19C15.5 19 18 17.5 18 16V11.5',
  link: 'M10 14A4 4 0 0 0 15.5 14.5L18.5 11.5A4 4 0 0 0 12.8 5.8L11.5 7 M14 10A4 4 0 0 0 8.5 9.5L5.5 12.5A4 4 0 0 0 11.2 18.2L12.5 17',
  heart: 'M12 20.5C12 20.5 3.5 15 3.5 9A4.5 4.5 0 0 1 12 7.2A4.5 4.5 0 0 1 20.5 9C20.5 15 12 20.5 12 20.5Z',
}

const TOKEN = /([MLHVCSQTAZ])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi

const r2 = (n: number): number => Math.round(n * 100) / 100

/** Scales path data drawn on a 24 grid to `size` and moves it to (x, y). Absolute commands only. */
export function scalePath(d: string, size: number, x: number, y: number): string {
  const k = size / 24
  const tokens = d.match(TOKEN) ?? []
  const out: string[] = []
  let command = ''
  let args: number[] = []
  const flush = (): void => {
    if (!command) return
    const scaled = args.map((n, i) => {
      switch (command) {
        case 'H':
          return r2(n * k + x)
        case 'V':
          return r2(n * k + y)
        case 'A': {
          const slot = i % 7
          if (slot === 0 || slot === 1) return r2(n * k)
          if (slot === 5) return r2(n * k + x)
          if (slot === 6) return r2(n * k + y)
          return n
        }
        default:
          return r2(n * k + (i % 2 === 0 ? x : y))
      }
    })
    out.push(`${command} ${scaled.join(' ')}`.trim())
    args = []
  }
  for (const token of tokens) {
    if (/[A-Za-z]/.test(token)) {
      flush()
      command = token.toUpperCase()
    } else {
      args.push(Number(token))
    }
  }
  flush()
  return out.join(' ')
}
