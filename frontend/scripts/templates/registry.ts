/** What a starter template is: its catalogue facts plus the function that composes its document. */
import type { DocBuilder } from './kit'

export interface TemplateDesign {
  slug: string
  title: string
  /** Slug of a gallery category created by `manage.py seed_gallery`. */
  category: string
  tags: string[]
  description: string
  /** Editor size preset id (`engine/presets.ts`), when the size is one of them. */
  preset?: string
  featured?: boolean
  build(): DocBuilder | Promise<DocBuilder>
}
