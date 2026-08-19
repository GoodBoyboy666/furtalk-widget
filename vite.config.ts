import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export const sharedConfig = defineConfig({
  plugins: [tailwindcss()],
})

// The widget builds to standalone browser ES modules under widget/dist, which
// deployments upload to their own CDN and reference via the embed <script>
// tag (or the widget's service-origin attribute). The unminified build runs
// first and clears dist; the minified build then writes alongside it.
// Generated artifacts are git-ignored (see .gitignore).
export default defineConfig(({ mode }) => {
  const minified = mode === 'minified'

  return {
    ...sharedConfig,
    build: {
      lib: {
        entry: resolve(import.meta.dirname, 'src/index.ts'),
        name: 'FurtalkWidget',
        formats: ['es'],
        fileName: () => (minified ? 'furtalk.min.js' : 'furtalk.js'),
      },
      outDir: resolve(import.meta.dirname, 'dist'),
      emptyOutDir: !minified,
      minify: minified,
      sourcemap: true,
      target: 'es2022',
      cssCodeSplit: false,
    },
  }
})
