// ---- 静态 Tailwind 展示常量 ----------------------------------------------
// 组件的样式以完整的 Tailwind 工具类直接写在渲染元素上（见 design.md）。
// 下面这些常量只把确实重复的基础部分归在一起；每个候选类都保持字面书写、可直接扫描。

/** 资料行：三列等宽，窄屏折叠为单列。 */
export const PROFILE_ROW =
  'grid grid-cols-3 [border-bottom:1px_solid_var(--furtalk-border)] [@media(max-width:480px)]:grid-cols-1'

/** 相邻资料字段之间的分隔线（桌面在左，窄屏在上）。 */
export const FIELD_DIVIDER =
  '[border-left:1px_solid_var(--furtalk-border)] [@media(max-width:480px)]:[border-left:0] [@media(max-width:480px)]:[border-top:1px_solid_var(--furtalk-border)]'

/** 评论操作行（横向铺开；窄屏时纵向堆叠）。 */
export const ACTIONS_ROW =
  'flex flex-wrap items-center justify-between gap-2 [@media(max-width:480px)]:flex-col [@media(max-width:480px)]:items-stretch [@media(max-width:480px)]:gap-2'

/** 根评论下面按层级排列的回复列表。 */
export const CHILDREN_LIST =
  'ft-children list-none m-0 mt-3 pl-3.5 [border-left:2px_solid_var(--furtalk-border)] flex flex-col gap-2 [@media(max-width:480px)]:pl-2.5'

/** 折叠后外层区域容器的完整 Tailwind 候选。 */
export const CONTENT_COLLAPSED = 'max-h-[300px] overflow-hidden'
export const CHILDREN_COLLAPSED = 'max-h-[400px] overflow-hidden'

/** 通用按钮骨架（尺寸、焦点环）；颜色/背景按类型区分。 */
export const BASE_BUTTON =
  'border border-solid rounded-(--furtalk-radius) px-3.5 py-1.5 cursor-pointer [font:inherit] text-[13px] font-medium leading-5 transition-all duration-150 disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** 默认按钮：带边框、弱背景，继承主题文本色。 */
export const DEFAULT_BUTTON =
  BASE_BUTTON +
  ' border-(--furtalk-border) bg-(--furtalk-bg) text-(--furtalk-text-muted) hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted) active:scale-[0.98] shadow-2xs'

/** 单向展开控件的通用展示。 */
export const READ_MORE_BUTTON =
  DEFAULT_BUTTON +
  ' ft-read-more mt-2 text-(--furtalk-accent) border-(--furtalk-border) bg-(--furtalk-bg) hover:bg-(--furtalk-bg-muted)'

/** 让子树的展开按钮与现有平铺回复列表对齐。 */
export const CHILDREN_READ_MORE_OFFSET = 'ml-11 [@media(max-width:480px)]:ml-0'

/** 主要操作按钮：强调色填充配白色文本。 */
export const PRIMARY_BUTTON =
  BASE_BUTTON +
  ' border-(--furtalk-accent) bg-(--furtalk-accent) text-white hover:bg-(--furtalk-accent)/90 active:scale-[0.98] shadow-2xs'

/** 幽灵按钮的无边框/透明外观。 */
export const GHOST_BUTTON =
  'border-0 bg-transparent rounded-(--furtalk-radius) cursor-pointer [font:inherit] font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** 危险外观（红字、无边框）；尺寸按上下文另行追加。 */
export const DANGER_CHROME =
  'border-0 bg-transparent text-(--furtalk-danger) rounded-(--furtalk-radius) cursor-pointer [font:inherit] font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-default enabled:hover:bg-(--furtalk-bg-muted) focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** 评论操作行之外的危险按钮（如退出登录）。 */
export const DANGER_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[13px] px-3 py-1.5 leading-5 enabled:hover:text-(--furtalk-danger) enabled:hover:bg-(--furtalk-bg-muted) active:scale-[0.98]'

/** 评论操作行内的危险按钮（紧凑尺寸）。 */
export const ACTION_DANGER_BUTTON = DANGER_CHROME + ' text-[12px] px-1.5 py-0.5'

/** 评论列表操作按钮（回复 / 取消）。 */
export const ACTION_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[12px] px-1.5 py-0.5 rounded-md enabled:hover:bg-(--furtalk-bg-muted) enabled:hover:text-(--furtalk-text)'

/** 分段栏内的排序控件按钮；按下态套用激活标签样式。 */
export const SORT_BUTTON =
  'border-0 bg-transparent text-(--furtalk-text-muted) text-[12px] leading-4 px-2.5 py-1 rounded-[calc(var(--furtalk-radius)-2px)] cursor-pointer [font:inherit] font-medium transition-all duration-150 hover:text-(--furtalk-text) aria-pressed:bg-(--furtalk-bg) aria-pressed:text-(--furtalk-accent) aria-pressed:font-semibold aria-pressed:shadow-2xs focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** 表情分类页签按钮；选中页签切换为强调色填充。 */
export const EMOJI_TAB_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[12px] px-2.5 py-[4px] hover:bg-(--furtalk-bg-muted) hover:text-(--furtalk-text) aria-selected:bg-(--furtalk-accent) aria-selected:text-white aria-selected:font-medium'

/** 表情条目按钮。 */
export const EMOJI_ITEM_BUTTON =
  'inline-flex items-center justify-start min-h-8 max-w-full px-2 py-1 border-0 bg-transparent text-(--furtalk-text) text-[14px] leading-none whitespace-nowrap cursor-pointer [font:inherit] rounded-md transition-colors hover:bg-(--furtalk-bg)'

/** 表情选择器触发按钮。 */
export const EMOJI_TRIGGER_BUTTON =
  'inline-flex items-center p-1.5 border-0 bg-transparent text-(--furtalk-text-muted) rounded-(--furtalk-radius) cursor-pointer [font:inherit] transition-colors hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted) aria-expanded:text-(--furtalk-accent) aria-expanded:bg-(--furtalk-bg-muted) focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** 加载更多按钮。 */
export const LOAD_MORE_BUTTON =
  GHOST_BUTTON +
  ' mx-auto text-(--furtalk-text-muted) text-[13px] px-4 py-2 border border-solid border-(--furtalk-border) bg-(--furtalk-bg) hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted)'

/** 弱化辅助说明文字。 */
export const NOTE_TEXT = 'text-(--furtalk-text-muted) text-[13px]'

/** 中性居中状态框（加载 / 空态）。 */
export const STATE_TEXT =
  'ft-state px-4 py-8 text-center text-(--furtalk-text-muted) text-[14px]'

/** 错误状态框（保留 ft-state 与 ft-error 两个类名）。 */
export const STATE_ERROR =
  'ft-state ft-error border border-solid border-[#fecaca] bg-[#fef2f2] text-[#b91c1c] p-3.5 rounded-(--furtalk-radius) text-center text-[14px]'

/** 文本框与 textarea 的基线样式。 */
export const INPUT_TEXT =
  '[font:inherit] border-0 rounded-none px-3 py-2 bg-(--furtalk-bg) text-(--furtalk-text) min-w-0 w-full outline-none focus:outline-none'

/** 根 widget 表面。 */
export const WIDGET_ROOT =
  'ft-widget bg-(--furtalk-bg) rounded-(--furtalk-radius) text-[15px]'

/** 入口链接旁只显示图标的语言切换按钮。 */
export const LANG_TRIGGER_BUTTON =
  'ft-lang-trigger inline-flex items-center p-1.5 border-0 bg-transparent text-(--furtalk-text-muted) rounded-(--furtalk-radius) cursor-pointer [font:inherit] transition-colors hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted) aria-expanded:text-(--furtalk-accent) aria-expanded:bg-(--furtalk-bg-muted) focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** 锚定在触发按钮下方的语言菜单面板。 */
export const LANG_MENU =
  'ft-lang-menu absolute right-0 top-full mt-1 z-20 min-w-[8rem] rounded-(--furtalk-radius) p-1 bg-(--furtalk-bg) border border-solid border-(--furtalk-border) shadow-[0_4px_20px_rgba(0,0,0,0.08)]'

/** 单选样式语言菜单项。 */
export const LANG_MENU_ITEM =
  'block w-full text-left px-3 py-1.5 border-0 bg-transparent text-(--furtalk-text) text-[13px] rounded-md cursor-pointer [font:inherit] hover:bg-(--furtalk-bg-muted) aria-checked:text-(--furtalk-accent) aria-checked:font-semibold focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'
