import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createCanvas } from 'canvas'
import type { Page } from '@playwright/test'

export const ROOT = path.resolve('.')
export const DIST = process.env.BG_DIST ?? path.join(ROOT, 'dist')
/** Where `manage.py sync_models` installs models (the API's MEDIA_ROOT; `backend/media` in development). */
export const MEDIA_ROOT = process.env.BG_MEDIA_ROOT ?? path.resolve(ROOT, '../backend/media')
const MANIFEST = path.resolve(ROOT, '../backend/data/ml_models.json')

interface ManifestModel {
  id: string
  name: string
  file: string
  bytes: number
  sha256: string
  input: Record<string, unknown>
  output: string
}

/** The `/config/` description of `id`, built from the backend manifest the way `apps.core.mlmodels` does. */
export function modelConfig(id = process.env.BG_MODEL ?? 'u2netp'): { model: Record<string, unknown>; file: string; installed: boolean } {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { models: ManifestModel[] }
  const spec = manifest.models.find((m) => m.id === id)
  if (!spec) throw new Error(`Model ${id} is not in ${MANIFEST}`)
  const stem = spec.file.replace(/\.onnx$/, '')
  const relative = `models/${spec.id}/${stem}-${spec.sha256.slice(0, 12)}.onnx`
  return {
    model: { id: spec.id, name: spec.name, url: `/media/${relative}`, bytes: spec.bytes, sha256: spec.sha256, input: spec.input, output: spec.output },
    file: path.join(MEDIA_ROOT, relative),
    installed: existsSync(path.join(MEDIA_ROOT, relative)),
  }
}

export function appConfig(model: Record<string, unknown> | null): Record<string, unknown> {
  return {
    google_client_id: '',
    features: { stock_photos: false, server_pdf: false, google_login: false, email_verification: true, background_removal: model !== null },
    limits: { max_upload_bytes: 25 * 1024 * 1024, max_pages: 100, max_document_bytes: 12 * 1024 * 1024 },
    assets: { background_removal_model: model },
  }
}

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

export type Scene = 'product' | 'portrait' | 'animal'

/**
 * A synthetic photo with a clear subject on a bokeh backdrop: an apple (product), a head and shoulders
 * (portrait) or a furry cat (animal). Drawn with node-canvas, so no image file is committed.
 */
export function scenePng(scene: Scene, width: number, height: number): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const r = random({ product: 5, portrait: 9, animal: 3 }[scene])
  const back = ctx.createLinearGradient(0, 0, width, height)
  back.addColorStop(0, '#9fb4c7')
  back.addColorStop(1, '#d8dee6')
  ctx.fillStyle = back
  ctx.fillRect(0, 0, width, height)
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${150 + r() * 80},${160 + r() * 70},${170 + r() * 60},0.35)`
    ctx.beginPath()
    ctx.arc(r() * width, r() * height, 10 + r() * width * 0.06, 0, 7)
    ctx.fill()
  }
  const cx = width / 2
  const unit = Math.min(width, height)
  if (scene === 'product') {
    const cy = height * 0.55
    const radius = unit * 0.3
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.beginPath()
    ctx.ellipse(cx, cy + radius * 0.95, radius * 0.9, radius * 0.15, 0, 0, 7)
    ctx.fill()
    const body = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.1, cx, cy, radius * 1.1)
    body.addColorStop(0, '#ff6a5c')
    body.addColorStop(0.6, '#c4141c')
    body.addColorStop(1, '#6e0b12')
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.ellipse(cx - radius * 0.25, cy, radius * 0.8, radius, 0, 0, 7)
    ctx.ellipse(cx + radius * 0.25, cy, radius * 0.8, radius, 0, 0, 7)
    ctx.fill()
    ctx.strokeStyle = '#4a3320'
    ctx.lineWidth = radius * 0.08
    ctx.beginPath()
    ctx.moveTo(cx, cy - radius * 0.8)
    ctx.quadraticCurveTo(cx + radius * 0.05, cy - radius * 1.2, cx + radius * 0.2, cy - radius * 1.3)
    ctx.stroke()
    ctx.fillStyle = '#3f8a2f'
    ctx.beginPath()
    ctx.ellipse(cx + radius * 0.45, cy - radius * 1.05, radius * 0.3, radius * 0.14, -0.5, 0, 7)
    ctx.fill()
  } else if (scene === 'portrait') {
    ctx.fillStyle = '#2f4f7f'
    ctx.beginPath()
    ctx.ellipse(cx, height, width * 0.34, height * 0.32, 0, Math.PI, 2 * Math.PI)
    ctx.fill()
    ctx.fillStyle = '#e0ac8a'
    ctx.fillRect(cx - width * 0.05, height * 0.52, width * 0.1, height * 0.2)
    ctx.beginPath()
    ctx.ellipse(cx, height * 0.38, width * 0.15, height * 0.2, 0, 0, 7)
    ctx.fill()
    ctx.fillStyle = '#3b2a20'
    ctx.beginPath()
    ctx.ellipse(cx, height * 0.27, width * 0.16, height * 0.13, 0, Math.PI, 2 * Math.PI)
    ctx.fill()
    ctx.fillStyle = '#222'
    for (const dx of [-0.06, 0.06]) {
      ctx.beginPath()
      ctx.arc(cx + width * dx, height * 0.38, width * 0.012, 0, 7)
      ctx.fill()
    }
  } else {
    const cy = height * 0.58
    const radius = unit * 0.28
    ctx.fillStyle = '#b5772e'
    ctx.beginPath()
    ctx.ellipse(cx, cy + radius * 0.9, radius * 1.1, radius * 0.8, 0, 0, 7)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(cx, cy, radius, radius * 0.9, 0, 0, 7)
    ctx.fill()
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(cx + side * radius * 0.35, cy - radius * 0.75)
      ctx.lineTo(cx + side * radius * 0.95, cy - radius * 1.35)
      ctx.lineTo(cx + side * radius * 0.95, cy - radius * 0.3)
      ctx.closePath()
      ctx.fill()
    }
    for (let i = 0; i < 1500; i++) {
      const angle = r() * 7
      const distance = Math.sqrt(r()) * radius
      ctx.strokeStyle = `rgba(${100 + r() * 90},${60 + r() * 50},20,0.5)`
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance * 0.9)
      ctx.lineTo(cx + Math.cos(angle) * distance + 6, cy + Math.sin(angle) * distance * 0.9 + 4)
      ctx.stroke()
    }
    ctx.fillStyle = '#2a8a3a'
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(cx + side * radius * 0.35, cy - radius * 0.1, radius * 0.14, radius * 0.1, 0, 0, 7)
      ctx.fill()
    }
  }
  return canvas.toBuffer('image/png')
}

/** Puts a one-image guest design into IndexedDB (the way the editor stores it) and returns its id. */
export async function seedImageDesign(page: Page, png: Buffer, width: number, height: number): Promise<string> {
  return page.evaluate(
    ([bytes, w, h]) =>
      new Promise<string>((resolve, reject) => {
        const designId = crypto.randomUUID()
        const assetId = crypto.randomUUID()
        const open = indexedDB.open('doory-local', 1)
        open.onupgradeneeded = () => {
          open.result.createObjectStore('designs', { keyPath: 'id' })
          open.result.createObjectStore('assets', { keyPath: 'id' })
        }
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['designs', 'assets'], 'readwrite')
          const now = Date.now()
          tx.objectStore('assets').put({ id: assetId, blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name: 'photo.png', mime: 'image/png', width: w, height: h, createdAt: now })
          const scale = Math.min(1, 1000 / Math.max(w, h))
          tx.objectStore('designs').put({
            id: designId,
            title: 'Cut-out test',
            createdAt: now,
            updatedAt: now,
            document: {
              schemaVersion: 1,
              width: 1000,
              height: 1000,
              unit: 'px',
              pages: [
                {
                  id: crypto.randomUUID(),
                  background: { type: 'solid', color: '#ffffff' },
                  objects: [{ id: crypto.randomUUID(), type: 'image', src: `idb://${assetId}`, left: 500, top: 500, width: w, height: h, scaleX: scale, scaleY: scale, originX: 'center', originY: 'center' }],
                },
              ],
            },
          })
          tx.oncomplete = () => resolve(designId)
          tx.onerror = () => reject(tx.error)
        }
      }),
    [[...png], width, height] as const,
  )
}

export interface AlphaStats {
  width: number
  height: number
  /** Mean alpha, 0..1. */
  coverage: number
  transparent: number
  opaque: number
  partial: number
  centre: number
  corners: number[]
  /** Share of the non-transparent pixels that belong to the largest 4-connected region of them (no speckle). */
  largestRegion: number
}

/** Reads the newest stored `cutout.png` of the guest database and measures its alpha channel. */
export async function readCutout(page: Page): Promise<AlphaStats | null> {
  return page.evaluate(
    () =>
      new Promise<AlphaStats | null>((resolve, reject) => {
        const open = indexedDB.open('doory-local')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const request = open.result.transaction('assets').objectStore('assets').getAll()
          request.onerror = () => reject(request.error)
          request.onsuccess = async () => {
            const rows = (request.result as Array<{ name: string; blob: Blob; createdAt: number }>).filter((row) => row.name === 'cutout.png')
            const row = rows.sort((a, b) => b.createdAt - a.createdAt)[0]
            if (!row) return resolve(null)
            const bitmap = await createImageBitmap(row.blob)
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(bitmap, 0, 0)
            const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
            let sum = 0
            let transparent = 0
            let opaque = 0
            let partial = 0
            const solid = new Uint8Array(width * height)
            let visible = 0
            for (let i = 0; i < width * height; i++) {
              const a = data[i * 4 + 3]
              sum += a
              if (a < 8) transparent++
              else {
                solid[i] = 1
                visible++
                if (a > 247) opaque++
                else partial++
              }
            }
            let largest = 0
            const seen = new Uint8Array(width * height)
            const stack: number[] = []
            for (let start = 0; start < solid.length; start++) {
              if (!solid[start] || seen[start]) continue
              let size = 0
              stack.push(start)
              seen[start] = 1
              while (stack.length) {
                const at = stack.pop()!
                size++
                const x = at % width
                for (const next of [at - width, at + width, x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1]) {
                  if (next >= 0 && next < solid.length && solid[next] && !seen[next]) {
                    seen[next] = 1
                    stack.push(next)
                  }
                }
              }
              largest = Math.max(largest, size)
            }
            const alphaAt = (x: number, y: number): number => data[(y * width + x) * 4 + 3]
            resolve({
              width,
              height,
              coverage: sum / 255 / (width * height),
              transparent: transparent / (width * height),
              opaque: opaque / (width * height),
              partial: partial / (width * height),
              centre: alphaAt(width >> 1, Math.round(height * 0.62)),
              corners: [alphaAt(2, 2), alphaAt(width - 3, 2), alphaAt(2, height - 3), alphaAt(width - 3, height - 3)],
              largestRegion: visible ? largest / visible : 0,
            })
          }
        }
      }),
  )
}
