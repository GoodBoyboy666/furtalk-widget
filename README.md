# Furtalk 评论组件（Widget）

Furtalk 评论组件。基于 Lit + Shadow DOM + Vite 构建，独立浏览器 ES module，样式通过 Shadow DOM 隔离。

使用时只需加载托管的 ES module 并挂载自定义元素：

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/furtalk-widget/dist/furtalk.js"></script>
<furtalk-comments site-id="123" page-key="article-2026-08" service-origin="https://comments.example.com"></furtalk-comments>
```

## 开发

```bash
pnpm install
pnpm dev
```

## 构建与质量检查

```bash
pnpm build        # 生产构建（单个 ES module + sourcemap）
pnpm test         # 单元测试（vitest）
pnpm lint         # ESLint
pnpm typecheck    # TypeScript 类型检查
pnpm format       # Prettier 写入 + ESLint --fix
pnpm check        # Prettier 格式检查
```

## 挂载属性

| 属性 | 必填 | 说明 |
| --- | --- | --- |
| `site-id` | 是 | 站点 ID（正十进制 int64）。 |
| `page-key` | 是 | 页面键；特殊值 `location` 由 `location.pathname + location.search` 推导，超过 512 字符返回 422。 |
| `page-url` | 否 | 页面 URL，默认取宿主文档值。 |
| `page-title` | 否 | 页面标题，默认取宿主文档值。 |
| `service-origin` | 否 | Furtalk 服务源，默认从 `import.meta.url` 推导（开发 / CDN 布局可覆盖），必须是绝对 https origin（本地 http localhost 允许用于开发）。 |

## 源码结构

- `src/element.ts` — `<furtalk-comments>` 自定义元素（Lit + Shadow DOM）。
- `src/index.ts` — 入口：注册自定义元素并 re-export 公共 API / 类型。
- `src/api.ts` / `src/auth.ts` / `src/popup.ts` — API 客户端与授权弹窗流程。
- `src/captcha.ts` — CAPTCHA provider 渲染。
- `src/comments.ts` / `src/state.ts` / `src/storage.ts` — 评论树、状态 reducer
  与 profile 本地存储。
- `src/owo.ts` / `src/markdown.ts` / `src/insertion.ts` — 远程表情目录、
  Markdown 渲染与文本插入。
- `src/styles.css` — Tailwind 样式入口，经 Vite 编译后以字符串内联进 Shadow DOM。
