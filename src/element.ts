/**
 * <furtalk-comments> 自定义元素。
 *
 * 与框架无关，通过 Shadow DOM 实现样式隔离。启动时依次加载 widget 运行时配置、
 * 当前线程与 widget 会话，然后渲染讨论区，包含根/回复编辑器、资料编辑、
 * CAPTCHA 渲染、弹窗授权（认证会话与匿名的管理员邮箱重试）、作者删除以及
 * 各种可恢复状态的处理。
 *
 * 匿名模式是一种不可信归因模型：普通访客仅提交一条携带 email/nickname/网站及
 * 评论验证码的创建请求，整个过程不需要会话、资料更新或预检。
 * 没有有效 widget 凭据的管理员邮箱会从创建端点收到 `need_auth_code`，
 * 该分支运行第一方 popup -> exchange -> probe 流程并重试同一评论。
 *
 * 所有跨域调用都使用 credentials: "include"，以便发送分区 CHIPS cookie。
 * 以服务端的 CORS 与实时源授权为准；运行时配置中的 CAPTCHA 数据仅是渲染提示。
 */

import { ElementRender } from './element-render'

export { defaultServiceOrigin } from './element-model'
export { formatRelativeTime } from './i18n'

export class FurtalkCommentsElement extends ElementRender {}

export type { WidgetState } from './state'
export type { RuntimeConfig } from './types'
