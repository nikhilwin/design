import { setupServer } from 'msw/node'

/**
 * Opt-in MSW server for tests that talk to the API client.
 * Importing this module registers the lifecycle hooks for the importing test file.
 */
export const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
