import '@testing-library/jest-dom/vitest'
import { setSizePresetsForTests } from '@/lib/sizePresets/store'

// Components read the size preset catalogue; tests get the built-in one without a request for it.
beforeEach(() => setSizePresetsForTests())
