import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export const sharedConfig = defineConfig({
  plugins: [tailwindcss()],
})

// widget 构建为 widget/dist 下的独立浏览器 ES 模块，部署方上传到自己的 CDN 并通过
// embed <script> 标签（或 widget 的 service-origin 属性）引用。
// 非压缩构建先运行并清空 dist；压缩构建随后写在同一目录下。
// 生成的产物已被 git 忽略（见 .gitignore）。
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
