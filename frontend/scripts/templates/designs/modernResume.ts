import { DocBuilder, type PageBuilder } from '../kit'
import type { IconName } from '../icons'
import type { TemplateDesign } from '../registry'

// After the most-reviewed resume templates: a round photo, the name in light, widely spaced capitals, the contacts on the
// right with icons, then two columns on either side of a fine timeline (education and skills on the left, profile and
// experience on the right), with small spaced headings in grey.
const W = 794
const H = 1123
const L = 56
const LEFT_W = 196
const LINE_X = 290
const R = 320
const RIGHT_W = W - R - 56
const INK = '#2f3033'
const MUTED = '#5c5f66'
const RULE = '#d7d9dd'
const WHITE = '#ffffff'

interface Job {
  role: string
  company: string
  dates: string
  summary: string
  bullets: string[]
}

const JOBS: Job[] = [
  {
    role: 'Senior product designer',
    company: 'Harbor & Pine Studio',
    dates: '2022 to now',
    summary: 'Design lead for the core product, used by 40,000 customers.',
    bullets: ['Led the redesign that lifted task completion by 18%.', 'Built the design system five product teams now use.', 'Mentored three designers and ran the weekly critique.'],
  },
  {
    role: 'Product designer',
    company: 'Fernlight Software',
    dates: '2019 to 2022',
    summary: 'Mobile and web onboarding for a payments start-up.',
    bullets: ['Shipped an onboarding flow that cut drop-off by a third.', 'Released 30+ accessible components with engineering.'],
  },
  {
    role: 'Junior designer',
    company: 'Studio Quill',
    dates: '2017 to 2019',
    summary: 'Websites and brand identities for more than 20 small businesses.',
    bullets: [],
  },
]

function heading(p: PageBuilder, x: number, y: number, w: number, label: string, dot: boolean): void {
  p.text({ name: `${label} heading`, x, y, w, text: label, font: 'josefin', size: 14, color: INK, on: WHITE, upper: true, spacing: 360, lines: 1 })
  if (dot) p.circle({ name: `${label} dot`, cx: LINE_X, cy: y + 8, r: 6, fill: WHITE, stroke: INK, strokeWidth: 1.4 })
}

export const modernResume: TemplateDesign = {
  slug: 'modern-resume',
  title: 'Modern resume',
  category: 'resumes',
  tags: ['resume', 'cv', 'job', 'career', 'a4', 'photo', 'minimal', 'two column'],
  description: 'An elegant two-column A4 resume with a round photo: the name in spaced capitals, contacts with icons, and experience along a fine timeline.',
  preset: 'a4',
  async build() {
    const doc = new DocBuilder(this.slug, { width: W, height: H, unit: 'mm', presetId: 'a4' })
    const p = doc.page('Resume', { type: 'solid', color: WHITE })

    // Header: photo, name, title, contacts.
    await p.photo({ name: 'Photo', file: 'resume-portrait.webp', x: L, y: 48, w: 152, h: 152, mask: 'circle', focusX: 0.52, focusY: 0.1, zoom: 2.4 })
    p.text({ name: 'Name', x: 236, y: 62, w: 330, text: 'Jordan\nEllis', font: 'josefin', size: 40, color: INK, on: WHITE, upper: true, spacing: 420, lh: 1.15, lines: 2 })
    p.text({ name: 'Job title', x: 238, y: 168, w: 330, text: 'Product designer', font: 'josefin', size: 12, color: MUTED, on: WHITE, upper: true, spacing: 400, lines: 1 })
    const contacts: { icon: IconName; text: string }[] = [
      { icon: 'phone', text: '+1 555 0142' },
      { icon: 'mail', text: 'jordan@yourmail.example' },
      { icon: 'link', text: 'yourportfolio.example' },
      { icon: 'pin', text: 'Lakeside, NY' },
    ]
    contacts.forEach((c, i) => {
      const y = 72 + i * 30
      p.text({ name: c.text, x: 520, y, w: 190, text: c.text, font: 'inter', size: 10.5, color: MUTED, on: WHITE, align: 'right', lines: 1 })
      p.icon({ name: `${c.text} icon`, icon: c.icon, x: 720, y: y - 1, size: 15, color: INK, width: 1.8 })
    })
    p.rect({ name: 'Header band', x: 0, y: 230, w: W, h: 8, fill: '#ececee' })

    // The timeline between the columns.
    p.line({ name: 'Timeline', x1: LINE_X, y1: 282, x2: LINE_X, y2: 1000, color: RULE, width: 1.2 })

    // Left column.
    let ly = 280
    heading(p, L, ly, LEFT_W, 'Education', false)
    ly += 40
    const degrees = [
      { degree: 'BA Interaction Design', school: 'Lakeshore University', years: '2013 to 2017' },
      { degree: 'UX Research Certificate', school: 'Northgate Institute', years: '2020' },
    ]
    degrees.forEach((d, i) => {
      p.text({ name: `Degree ${i + 1}`, x: L, y: ly, w: LEFT_W, text: d.degree, font: 'inter', bold: true, size: 10.5, color: INK, on: WHITE, upper: true, lines: 1 })
      p.text({ name: `School ${i + 1}`, x: L, y: ly + 18, w: LEFT_W, text: d.school, font: 'inter', size: 10.5, color: MUTED, on: WHITE, lines: 1 })
      p.text({ name: `Years ${i + 1}`, x: L, y: ly + 34, w: LEFT_W, text: d.years, font: 'inter', size: 10.5, color: MUTED, on: WHITE, lines: 1 })
      ly += 66
    })

    ly += 20
    heading(p, L, ly, LEFT_W, 'Skills', false)
    ly += 40
    const skills = [
      { group: 'Design', items: 'Product strategy\nUser research\nPrototyping\nDesign systems\nFacilitation' },
      { group: 'Tools', items: 'Figma\nHTML and CSS\nMaze\nNotion' },
    ]
    skills.forEach((s, i) => {
      p.line({ name: `Skill marker ${i + 1}`, x1: L, y1: ly + 2, x2: L, y2: ly + 15, color: INK, width: 2 })
      p.text({ name: `Skill group ${i + 1}`, x: L + 10, y: ly, w: LEFT_W - 10, text: s.group, font: 'inter', bold: true, size: 10.5, color: INK, on: WHITE, lines: 1 })
      const t = p.text({ name: `Skills ${i + 1}`, x: L, y: ly + 22, w: LEFT_W, text: s.items, font: 'inter', size: 10.5, color: MUTED, on: WHITE, lh: 1.6 })
      ly = t.bottom + 18
    })

    ly += 6
    heading(p, L, ly, LEFT_W, 'Languages', false)
    ly += 40
    p.text({ name: 'Languages', x: L, y: ly, w: LEFT_W, text: 'English, native\nSpanish, fluent\nFrench, conversational', font: 'inter', size: 10.5, color: MUTED, on: WHITE, lh: 1.6, lines: 3 })
    ly += 92

    heading(p, L, ly, LEFT_W, 'Interests', false)
    p.text({ name: 'Interests', x: L, y: ly + 40, w: LEFT_W, text: 'Type design\nTrail running\nFilm photography', font: 'inter', size: 10.5, color: MUTED, on: WHITE, lh: 1.6, lines: 3 })

    // Right column.
    let ry = 280
    heading(p, R, ry, RIGHT_W, 'Profile', true)
    ry += 40
    const profile = p.text({ name: 'Profile text', x: R, y: ry, w: RIGHT_W, text: 'Designer with seven years of experience turning complex problems into simple, accessible products. I work closely with research and engineering, and I care about clear writing and consistent systems.', font: 'inter', size: 10.5, color: MUTED, on: WHITE, lh: 1.7 })
    ry = profile.bottom + 36

    heading(p, R, ry, RIGHT_W, 'Work experience', true)
    ry += 40
    JOBS.forEach((job, i) => {
      p.text({ name: `Role ${i + 1}`, x: R, y: ry, w: RIGHT_W, text: job.role, font: 'inter', bold: true, size: 11, color: INK, on: WHITE, upper: true, spacing: 60, lines: 1 })
      p.text({ name: `Company ${i + 1}`, x: R, y: ry + 19, w: RIGHT_W, text: `${job.company}  |  ${job.dates}`, font: 'inter', size: 10.5, color: MUTED, on: WHITE, lines: 1 })
      const summary = p.text({ name: `Summary ${i + 1}`, x: R, y: ry + 42, w: RIGHT_W, text: job.summary, font: 'inter', size: 10.5, color: MUTED, on: WHITE, lh: 1.6 })
      ry = summary.bottom + 4
      job.bullets.forEach((bullet, k) => {
        p.circle({ name: `Bullet ${i + 1}.${k + 1}`, cx: R + 4, cy: ry + 8.5, r: 2, fill: INK })
        const t = p.text({ name: `Achievement ${i + 1}.${k + 1}`, x: R + 14, y: ry, w: RIGHT_W - 14, text: bullet, font: 'inter', size: 10.5, color: MUTED, on: WHITE, lh: 1.6 })
        ry = t.bottom + 2
      })
      ry += 22
    })

    heading(p, R, ry + 4, RIGHT_W, 'Selected projects', true)
    ry += 44
    const projects = [
      { name: 'Harbor design system', text: 'Tokens, 120 components and the docs site; adopted by five teams in one quarter.' },
      { name: 'Accessible checkout', text: 'Rebuilt the checkout to WCAG AA; support tickets about payment fell by 40%.' },
    ]
    projects.forEach((pr, i) => {
      p.text({ name: `Project ${i + 1}`, x: R, y: ry, w: RIGHT_W, text: pr.name, font: 'inter', bold: true, size: 11, color: INK, on: WHITE, upper: true, spacing: 60, lines: 1 })
      const t = p.text({ name: `Project ${i + 1} text`, x: R, y: ry + 20, w: RIGHT_W, text: pr.text, font: 'inter', size: 10.5, color: MUTED, on: WHITE, lh: 1.6 })
      ry = t.bottom + 16
    })

    heading(p, R, ry + 10, RIGHT_W, 'References', true)
    p.text({ name: 'References', x: R, y: ry + 50, w: RIGHT_W, text: 'Available on request.', font: 'inter', size: 10.5, color: MUTED, on: WHITE, lines: 1 })
    return doc
  },
}
