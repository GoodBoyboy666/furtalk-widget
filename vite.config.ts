import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The widget builds to a standalone single browser ES module under
// widget/dist, which deployments upload to their own CDN and reference via
// the embed <script> tag (or the widget's service-origin attribute).
// Generated artifacts are git-ignored (see .gitignore).
export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'FurtalkWidget',
      formats: ['es'],
      fileName: () => 'furtalk.js',
    },
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    cssCodeSplit: false,
  },
})
