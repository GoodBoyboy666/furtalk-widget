import { mergeConfig, defineConfig } from 'vitest/config'

import viteConfig from './vite.config'

// Merge the production Vite config so the Tailwind CSS transform (including
// the ?inline stylesheet import) is shared between builds and tests instead of
// being duplicated here. `test.css: true` is required for Vitest to run the
// CSS pipeline at all; without it ?inline CSS imports resolve to an empty
// string and the compiled stylesheet assertions fail.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      css: true,
    },
  }),
)
