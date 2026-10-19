import type { TemplateDesign } from '../registry'
import { youtubeThumbnail } from './youtubeThumbnail'
import { businessCard } from './businessCard'
import { botanicalInvitation } from './botanicalInvitation'
import { concertPoster } from './concertPoster'
import { eventStory } from './eventStory'
import { grandOpeningFlyer } from './grandOpeningFlyer'
import { modernResume } from './modernResume'
import { pitchDeck } from './pitchDeck'
import { quoteCard } from './quoteCard'
import { saleAnnouncement } from './saleAnnouncement'

/** The starter templates, in gallery order. */
export const DESIGNS: readonly TemplateDesign[] = [saleAnnouncement, quoteCard, eventStory, pitchDeck, concertPoster, grandOpeningFlyer, botanicalInvitation, modernResume, youtubeThumbnail, businessCard]
