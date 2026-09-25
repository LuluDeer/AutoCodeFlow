/**
 * UI-01：设计系统令牌——单一常量源（design-system/autocodeflow/MASTER.md 的
 * 程序化镜像）。antd ConfigProvider token 与 index.css 的 CSS 变量均从本文件
 * 消费，防止两处手写漂移。
 *
 * 主题分面：MASTER.md 定义的是暗色 OLED dashboard 色板；亮色主题复用同一套
 * 强调色/字体/间距，仅背景/前景/边框三面切换为可读亮色（对比度 ≥4.5:1）。
 */

/** MASTER.md §Color Palette 原值（暗色面） */
export const DESIGN_TOKENS = {
  /** Accent/CTA #22C55E——antd colorPrimary 与强调色共源 */
  accent: '#22C55E',
  /** Primary #0F172A（MASTER 语义=深色结构色；亮色主题用作正文文字色） */
  primaryDark: '#0F172A',
  /** Secondary #1E293B */
  secondary: '#1E293B',
  /** Background #020617（暗色面画布） */
  backgroundDark: '#020617',
  /** Foreground #F8FAFC（暗色面正文） */
  foregroundOnDark: '#F8FAFC',
  /** Muted #1A1E2F（暗色面次级容器） */
  muted: '#1A1E2F',
  /** Border #334155（暗色面边框） */
  borderDark: '#334155',
  /** Destructive #EF4444 */
  destructive: '#EF4444',
} as const;

/** 亮色面（antd 默认算法的贴地调整；强调色与暗色面同源） */
export const LIGHT_TOKENS = {
  background: '#F8FAFC',
  container: '#FFFFFF',
  border: '#E2E8F0',
  text: '#0F172A',
  textSecondary: '#475569',
  muted: '#F1F5F9',
} as const;

/** 暗色面（MASTER.md 色板） */
export const DARK_TOKENS = {
  background: DESIGN_TOKENS.backgroundDark, // #020617 OLED 画布
  container: DESIGN_TOKENS.muted, // #1A1E2F 卡片容器
  border: DESIGN_TOKENS.borderDark, // #334155
  text: DESIGN_TOKENS.foregroundOnDark, // #F8FAFC
  textSecondary: '#94A3B8',
  muted: '#0F172A',
} as const;

/** MASTER.md §Typography——Fira Code=代码/日志/等宽，Fira Sans=正文 */
export const FONT_STACKS = {
  /** 正文（Fira Sans + 中文/系统回退） */
  body: "'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans', sans-serif",
  /** 代码/日志/等宽场景（Fira Code + 等宽回退） */
  mono: "'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace",
} as const;

/** MASTER.md §Spacing Variables */
export const SPACE_TOKENS = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  '2xl': '48px',
  '3xl': '64px',
} as const;

/**
 * 布局尺寸令牌：头部高度与由它派生的滚动留白。
 *
 * 为什么单独收口：`88` 此前以字面量散落在 6 处（TaskFormPage 三段分区的
 * `scrollMarginTop`、两个已拆出区块组件，外加锚点条的 `top`）。它并非随手取的
 * 数——= 头部高度 56 + 上下留白，两者必须同步改，否则锚点跳转会被吸顶头部
 * 盖住一截。MainLayout 里 56 还有 3 处耦合使用（logo 按钮、Header、
 * Content 的 minHeight 计算），改头部高度时这几处要一起动。
 */
export const LAYOUT_TOKENS = {
  /** MainLayout 头部高度（px） */
  headerHeight: 56,
  /** 锚点区块的滚动留白（px）：headerHeight + 呼吸空间，防吸顶头部遮挡标题 */
  anchorScrollOffset: 88,
  /** MainLayout 侧栏展开宽度（px） */
  siderWidth: 220,
} as const;

/**
 * 卡片圆角（px）。
 *
 * ConfigProvider 的全局 `borderRadius` 是 8，而卡片历史上被逐张覆写成 10
 * （约 18 处、多为 DashboardPage）——两者并存造成"同页面两种圆角"。此处把
 * 卡片圆角显式命名为令牌：新卡片引用它，避免继续散落字面量。
 * 注：若要彻底统一，正解是在 buildAntdTheme 里加 `components.Card.borderRadius`
 * 并删掉各页覆写；本令牌是渐进收敛的第一步（不改变现有视觉）。
 */
export const CARD_RADIUS = 10;

/** MASTER.md §Shadow Depths */
export const SHADOW_TOKENS = {  sm: '0 1px 2px rgba(0, 0, 0, 0.05)',
  md: '0 4px 6px rgba(0, 0, 0, 0.1)',
  lg: '0 10px 15px rgba(0, 0, 0, 0.1)',
  xl: '0 20px 25px rgba(0, 0, 0, 0.15)',
} as const;

/** 高频语义色（图表/状态在双主题下共用；亮暗面均可读） */
export const SEMANTIC_COLORS = {
  success: '#22C55E',
  error: '#EF4444',
  warning: '#F59E0B',
  info: '#3B82F6',
  purple: '#8B5CF6',
  /** 中性/未连接态（SSE connecting、DAG 等状态点的灰面），亮暗面均可读 */
  neutral: '#94A3B8',
  /** 图表网格线：亮面浅灰 / 暗面 MASTER border 色 */
  gridLight: '#E2E8F0',
  gridDark: '#334155',
} as const;

/** 图表配色集合（Dashboard 趋势图 / ExecutorDetail 资源趋势共用） */
export const CHART_COLORS = {
  success: SEMANTIC_COLORS.success,
  failed: SEMANTIC_COLORS.error,
  cpu: SEMANTIC_COLORS.info,
  memory: SEMANTIC_COLORS.purple,
  concurrent: SEMANTIC_COLORS.warning,
  grid: (isDark: boolean) => (isDark ? SEMANTIC_COLORS.gridDark : SEMANTIC_COLORS.gridLight),
  axisText: (isDark: boolean) => (isDark ? '#94A3B8' : '#475569'),
} as const;

/**
 * D-P2-16（设计审计）：品牌渐变唯一事实源。
 * MASTER §Accent/CTA #22C55E → #16A34A，供 Logo 方块 / 用户头像 / 登录主按钮
 * 共用——改品牌色只改此处，不再五处内联。
 */
export const BRAND_GRADIENT = 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)';

/**
 * 阶段一设计遗留（设计建议#1）：主操作按钮填充加深档。
 * 品牌绿 #22C55E 上白字仅 2.28:1（< WCAG 2.1 AA SC 1.4.11 正文 4.5:1）。
 * 按钮填充改用 green-700 `#15803d`——白字 5.02:1，亮/暗双主题同源均达标；
 * hover/active 取同色相更深档（白字对比仍 ≥4.5:1）。
 * 品牌绿 `#22C55E` 仍保留在 `DESIGN_TOKENS.accent` / `BRAND_GRADIENT`（Logo、
 * 头像）/ `SEMANTIC_COLORS.success`（状态点）——仅主操作按钮填充加深，不改品牌色相。
 * index.css 的 `.ant-btn-primary` 覆盖块与本处镜像，由
 * `__tests__/primary-button-contrast.ux.test.ts` 双向钉住（值一致 + 实测对比）。
 */
export const PRIMARY_BUTTON = {
  /** 主按钮填充（白字 5.02:1） */
  bg: '#15803d',
  /** hover 填充（白字 7.13:1） */
  hoverBg: '#166534',
  /** active 填充（白字 9.11:1） */
  activeBg: '#14532d',
  /** 主按钮文字色（antd colorTextLightSolid，亮/暗面均为白） */
  text: '#FFFFFF',
} as const;

/** SSE 日志区双主题面（亮面白底深字 / 暗面 MASTER 画布 + foreground） */
export const LOG_PANEL_COLORS = {
  light: { bg: '#FFFFFF', text: '#0F172A' },
  dark: { bg: DESIGN_TOKENS.backgroundDark, text: DESIGN_TOKENS.foregroundOnDark },
} as const;

/**
 * F-30（DEEP_REVIEW 0ef3bbe）：首帧主题脚本的**唯一**来源——DOM 解析前注入
 * data-theme，防首帧闪白（FOUC）。index.html 不再内联手写副本，由
 * vite.config.ts 的 themeInitPlugin（transformIndexHtml）在构建/开发期把本
 * 常量注入 <head> 末尾，避免两处手写漂移。持久化键名与 theme/store.ts 一致。
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=JSON.parse(localStorage.getItem('autoflow-theme')||'{}').state&&JSON.parse(localStorage.getItem('autoflow-theme')||'{}').state.mode;var m=t||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.setAttribute('data-theme',d?'dark':'light');e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
