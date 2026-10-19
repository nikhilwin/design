import type { Page } from '@playwright/test'

/** Reads the guest designs stored in IndexedDB straight from the page. */
export async function readLocalDesigns(page: Page): Promise<Array<{ id: string; title: string; width: number; height: number; assetIds: string[] }>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('doory-local')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('designs')) {
            resolve([])
            return
          }
          const request = db.transaction('designs').objectStore('designs').getAll()
          request.onsuccess = () =>
            resolve(
              (request.result as Array<{ id: string; title: string; document: { width: number; height: number } }>).map((design) => ({
                id: design.id,
                title: design.title,
                width: design.document.width,
                height: design.document.height,
                assetIds: [...JSON.stringify(design.document).matchAll(/idb:\/\/([0-9a-f-]{36})/g)].map((match) => match[1]),
              })),
            )
          request.onerror = () => reject(request.error)
        }
      }),
  )
}

/** Seeds a guest design that references one locally stored PNG, the way the editor would after an upload. */
export async function seedLocalDesignWithImage(page: Page): Promise<{ designId: string; assetId: string }> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
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
          tx.objectStore('assets').put({ id: assetId, blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), name: 'photo.png', mime: 'image/png', width: 400, height: 300, createdAt: now })
          tx.objectStore('designs').put({
            id: designId,
            title: 'Seeded with a photo',
            createdAt: now,
            updatedAt: now,
            document: {
              schemaVersion: 1,
              width: 800,
              height: 600,
              unit: 'px',
              pages: [{ id: crypto.randomUUID(), background: { type: 'solid', color: '#ffffff' }, objects: [{ id: crypto.randomUUID(), type: 'image', src: `idb://${assetId}` }] }],
            },
          })
          tx.oncomplete = () => resolve({ designId, assetId })
          tx.onerror = () => reject(tx.error)
        }
      }),
  )
}

export async function e2eHook(page: Page, name: string): Promise<void> {
  await page.evaluate((hookName) => {
    const hooks = (window as unknown as { __doory_e2e?: Record<string, () => unknown> }).__doory_e2e
    if (!hooks?.[hookName]) throw new Error(`e2e hook "${hookName}" is not registered (run Vite with VITE_E2E=true)`)
    void hooks[hookName]()
  }, name)
}
