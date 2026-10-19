import type { ApiUser, AppConfig, DesignSummary, TemplateSummary } from '@/types/api'

export function makeUser(overrides: Partial<ApiUser> = {}): ApiUser {
  return {
    id: 'u1',
    email: 'ada@example.com',
    display_name: 'Ada Lovelace',
    name: 'Ada Lovelace',
    avatar_url: null,
    is_email_verified: true,
    has_password: true,
    google_linked: false,
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    google_client_id: '',
    features: { stock_photos: false, server_pdf: false, google_login: false, email_verification: false },
    limits: { max_upload_bytes: 10 * 1024 * 1024, max_pages: 100, max_document_bytes: 12 * 1024 * 1024 },
    ...overrides,
  }
}

export function makeDesign(id: string, overrides: Partial<DesignSummary> = {}): DesignSummary {
  return {
    id,
    title: `Design ${id}`,
    width: 1080,
    height: 1080,
    preset: 'instagram-post',
    page_count: 1,
    thumbnail_url: null,
    folder: null,
    starred: false,
    revision: 1,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    trashed_at: null,
    ...overrides,
  }
}

export function makeTemplate(slug: string, overrides: Partial<TemplateSummary> = {}): TemplateSummary {
  return {
    id: `t-${slug}`,
    slug,
    title: slug.replace(/-/g, ' '),
    category: { id: 'c1', slug: 'social', name: 'Social media' },
    tags: [],
    width: 1080,
    height: 1080,
    orientation: 'square',
    preset: '',
    page_count: 1,
    thumbnail_url: null,
    is_featured: true,
    use_count: 1,
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

export const page = <T,>(results: T[], extra: { next?: string | null; count?: number } = {}) => ({ count: extra.count ?? results.length, next: extra.next ?? null, previous: null, results })
