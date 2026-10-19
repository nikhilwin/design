import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import base from './vite.config'

/**
 * A production build of the editor harness (`/editor-harness.html`, in-memory adapter) for `npm run e2e:perf`: minified React
 * and the real chunking, with the test hook (`VITE_E2E=true`) that gives the specs the engine. Profiling the dev server would
 * measure React's development build, which is several times slower.
 */
export default defineConfig({
  ...base,
  build: {
    ...base.build,
    outDir: 'dist-perf',
    manifest: false,
    rollupOptions: { ...base.build?.rollupOptions, input: { harness: fileURLToPath(new URL('./editor-harness.html', import.meta.url)) } },
  },
})
