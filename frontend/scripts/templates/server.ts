/**
 * A Vite plugin for the template tools: serves the font catalog and woff2 files at /__fonts, the generated template
 * documents at /__templates and the starter photos at /media/templates/photos, so the editor and the generator pages
 * load them like they would from the API.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import type { FontCatalogEntry } from './fonts.ts'

export interface StarterServerOptions {
  fontsDir: string
  catalog: FontCatalogEntry[]
  templatesDir: string
}

export function starterServer(options: StarterServerOptions): Plugin {
  return {
    name: 'starter-template-server',
    configureServer(server) {
      server.middlewares.use('/__fonts', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (name === 'catalog.json') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(options.catalog))
          return
        }
        if (!/^[a-z0-9-]+\.woff2$/.test(name) || !existsSync(join(options.fontsDir, name))) {
          next()
          return
        }
        void readFile(join(options.fontsDir, name)).then((bytes) => {
          res.setHeader('content-type', 'font/woff2')
          res.end(bytes)
        })
      })
      // The starter photos, where the documents point at them (`/media/templates/photos/…`).
      server.middlewares.use('/media/templates/photos', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
        const file = join(options.templatesDir, 'photos', name)
        if (!/^[a-z0-9-]+\.webp$/.test(name) || !existsSync(file)) {
          next()
          return
        }
        void readFile(file).then((bytes) => {
          res.setHeader('content-type', 'image/webp')
          res.end(bytes)
        })
      })
      server.middlewares.use('/__templates', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (!/^[a-z0-9-]+\.json$/.test(name) || !existsSync(join(options.templatesDir, name))) {
          next()
          return
        }
        void readFile(join(options.templatesDir, name)).then((bytes) => {
          res.setHeader('content-type', 'application/json')
          res.end(bytes)
        })
      })
    },
  }
}
