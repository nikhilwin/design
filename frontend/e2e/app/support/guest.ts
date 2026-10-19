import type { Page } from '@playwright/test'
import { makePng } from './png'

export interface LocalSeed {
  title: string
  width?: number
  height?: number
  /** Number of images (each a distinct generated PNG stored in IndexedDB, referenced as `idb://<id>`). */
  images?: number
  /** Number of plain rectangles added to the page (for a large document). */
  rects?: number
  text?: string
}

/** Writes a guest design (and its images) straight into the page's IndexedDB, the way the editor would have stored it. */
export async function seedLocalDesign(page: Page, seed: LocalSeed): Promise<{ designId: string; assetIds: string[] }> {
  const pictures = Array.from({ length: seed.images ?? 0 }, (_, index) => makePng(320 + index * 8, 240, index + 1).toString('base64'))
  return page.evaluate(
    ({ title, width, height, rects, text, pictures: images }) =>
      new Promise<{ designId: string; assetIds: string[] }>((resolve, reject) => {
        const designId = crypto.randomUUID()
        const assetIds = images.map(() => crypto.randomUUID())
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
          images.forEach((base64, index) => {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
            tx.objectStore('assets').put({ id: assetIds[index], blob: new Blob([bytes], { type: 'image/png' }), name: `photo-${index + 1}.png`, mime: 'image/png', width: 320 + index * 8, height: 240, createdAt: now })
          })
          const objects: Record<string, unknown>[] = [
            { id: crypto.randomUUID(), type: 'textbox', left: width / 2, top: 80, width: width * 0.8, height: 60, text, fontSize: 48, fontFamily: 'Inter, sans-serif', fontWeight: 700, fill: '#1c1517', textAlign: 'center', originX: 'center', originY: 'center', angle: 0, scaleX: 1, scaleY: 1 },
            ...assetIds.map((id, index) => ({ id: crypto.randomUUID(), type: 'image', src: `idb://${id}`, left: 120 + index * 40, top: 240 + index * 30, width: 160, height: 120, originX: 'left', originY: 'top', angle: 0, scaleX: 1, scaleY: 1 })),
            ...Array.from({ length: rects }, (_, index) => ({ id: crypto.randomUUID(), type: 'rect', left: (index * 37) % (width - 40), top: (index * 53) % (height - 40), width: 30, height: 30, fill: '#e11d48', originX: 'left', originY: 'top', angle: 0, scaleX: 1, scaleY: 1 })),
          ]
          tx.objectStore('designs').put({
            id: designId,
            title,
            createdAt: now,
            updatedAt: now,
            document: { schemaVersion: 1, width, height, unit: 'px', pages: [{ id: crypto.randomUUID(), background: { type: 'solid', color: '#ffffff' }, objects }] },
          })
          tx.oncomplete = () => resolve({ designId, assetIds })
          tx.onerror = () => reject(tx.error)
        }
      }),
    { title: seed.title, width: seed.width ?? 1080, height: seed.height ?? 1080, rects: seed.rects ?? 0, text: seed.text ?? seed.title, pictures },
  )
}

/** The titles of the guest designs stored in the page's IndexedDB. */
export async function localTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('doory-local')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('designs')) return resolve([])
          const request = db.transaction('designs').objectStore('designs').getAll()
          request.onsuccess = () => resolve((request.result as { title: string }[]).map((design) => design.title))
          request.onerror = () => reject(request.error)
        }
      }),
  )
}

/** How many guest images are stored in the page's IndexedDB. */
export async function localAssetCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('doory-local')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('assets')) return resolve(0)
          const request = db.transaction('assets').objectStore('assets').count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        }
      }),
  )
}

/** The guest designs of the page's IndexedDB as one JSON text (for "has this text been stored yet" polls). */
export async function localDesignsJson(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('doory-local')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('designs')) return resolve('[]')
          const request = db.transaction('designs').objectStore('designs').getAll()
          request.onsuccess = () => resolve(JSON.stringify(request.result))
          request.onerror = () => reject(request.error)
        }
      }),
  )
}
