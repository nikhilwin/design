import type { Api } from './stack'
import { makePng } from './png'

export interface DesignSummary {
  id: string
  title: string
  folder: string | null
  starred: boolean
  trashed_at: string | null
  revision: number
}

export interface Asset {
  id: string
  name: string
  url: string
}

const SIZES = [
  { width: 1080, height: 1080, preset: 'instagram-post' },
  { width: 1920, height: 1080, preset: 'presentation' },
  { width: 1080, height: 1920, preset: 'instagram-story' },
  { width: 1280, height: 720, preset: 'youtube-thumbnail' },
  { width: 794, height: 1123, preset: 'a4-document' },
] as const

/** A one-page document with a rectangle and a headline, the smallest thing the editor opens as a real design. */
export function simpleDocument(title: string, width = 800, height = 600): Record<string, unknown> {
  return {
    schemaVersion: 1,
    width,
    height,
    unit: 'px',
    pages: [
      {
        id: 'page-1',
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          { id: 'rect-1', type: 'rect', left: width / 2, top: height / 2, width: width / 2, height: height / 3, fill: '#e11d48', originX: 'center', originY: 'center', angle: 0, scaleX: 1, scaleY: 1 },
          { id: 'text-1', type: 'textbox', left: width / 2, top: height / 4, width: width * 0.7, height: 60, text: title, fontSize: 48, fontFamily: 'Inter, sans-serif', fontWeight: 700, fill: '#1c1517', textAlign: 'center', originX: 'center', originY: 'center', angle: 0, scaleX: 1, scaleY: 1 },
        ],
      },
    ],
  }
}

/** Creates `count` designs titled `<prefix> 1…count` (varied sizes), each with a generated thumbnail, oldest first. */
export async function seedDesigns(api: Api, count: number, options: { prefix?: string; thumbnails?: boolean } = {}): Promise<DesignSummary[]> {
  const prefix = options.prefix ?? 'Design'
  const created: DesignSummary[] = []
  for (let index = 1; index <= count; index++) {
    const size = SIZES[index % SIZES.length] as (typeof SIZES)[number]
    const title = `${prefix} ${index}`
    const design = await api.call<DesignSummary>('post', '/designs/', { title, ...size, document: simpleDocument(title, size.width, size.height) }, 201)
    if (options.thumbnails !== false) {
      const tall = size.width <= size.height
      await api.upload(`/designs/${design.id}/thumbnail/`, 'thumb.png', 'image/png', makePng(tall ? 360 : 480, tall ? 480 : 270, index), { field: 'image', method: 'put' })
    }
    created.push(design)
  }
  return created
}

/** Uploads `count` generated PNGs to the account's library. */
export async function seedAssets(api: Api, count: number, options: { prefix?: string } = {}): Promise<Asset[]> {
  const out: Asset[] = []
  for (let index = 1; index <= count; index++) {
    out.push((await api.upload('/assets/', `${options.prefix ?? 'photo'}-${index}.png`, 'image/png', makePng(640 + index * 8, 480, index + 3))) as Asset)
  }
  return out
}
