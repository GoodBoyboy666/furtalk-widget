import { mergeConfig, defineConfig } from 'vitest/config'

import { sharedConfig } from './vite.config'

// 合并生产 Vite 配置，使 Tailwind CSS 变换（包括 ?inline 样式表导入）在构建与测试
// 间共享，而不在此重复。
// `test.css: true` 是 Vitest 运行 CSS 管线的必要条件；缺少它时 ?inline CSS 导入
// 会解析为空字符串，导致编译后样式表的断言失败。
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      css: true,
    },
  }),
)
