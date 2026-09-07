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

/** MASTER.md §Shadow Depths */
export const SHADOW_TOKENS = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.05)',
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

/** SSE 日志区双主题面（亮面白底深字 / 暗面 MASTER 画布 + foreground） */
export const LOG_PANEL_COLORS = {
  light: { bg: '#FFFFFF', text: '#0F172A' },
  dark: { bg: DESIGN_TOKENS.backgroundDark, text: DESIGN_TOKENS.foregroundOnDark },
} as const;

/** index.html 初始主题脚本：DOM 解析前注入 data-theme，防首帧闪白（FOUC）。 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=JSON.parse(localStorage.getItem('autoflow-theme')||'{}').state&&JSON.parse(localStorage.getItem('autoflow-theme')||'{}').state.mode;var m=t||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.setAttribute('data-theme',d?'dark':'light');e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
