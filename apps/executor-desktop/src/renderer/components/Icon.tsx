import React from 'react';

/**
 * 统一的线性图标组件（替代散落各页的 emoji 字符）。
 *
 * 背景：Tab 栏与标题栏在 UI 翻新时已改为单色 SVG 线性图标，但页面内部
 * 仍混用约 20 个 emoji（🔍📂✕⚠🗑💡…）。Windows 上 emoji 走 Segoe UI Emoji
 * 彩色字体，与深色主题里的单色 SVG 视觉语言冲突且尺寸基线不齐。
 * 本组件收口为同一套 24 viewBox / currentColor / 1.8 描边的线条图标，
 * 颜色一律继承文字色（状态色由外层容器的 color 决定）。
 *
 * 用法：<Icon name="search" />；尺寸由 CSS 控制（默认 14px，见 .icon）。
 */

export type IconName =
  | 'search'
  | 'folder'
  | 'close'
  | 'refresh'
  | 'warning'
  | 'check'
  | 'check-circle'
  | 'copy'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-up'
  | 'arrow-down'
  | 'external'
  | 'trash'
  | 'terminal'
  | 'doc'
  | 'bulb'
  | 'pin'
  | 'shield'
  | 'bot'
  | 'globe'
  | 'link'
  | 'gear'
  | 'expand'
  | 'monitor'
  | 'zap'
  | 'spark'
  | 'box'
  | 'activity'
  | 'server'
  | 'play'
  | 'stop'
  | 'eye'
  | 'eye-off'
  | 'clock'
  | 'download'
  | 'upload';

const PATHS: Record<IconName, React.ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  folder: (
    <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2L11.5 8H19a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z" />
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.2 21 19.2H3Z" />
      <path d="M12 10.2v3.8" />
      <path d="M12 16.8h.01" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.4 12.3 2.4 2.4 4.8-5.2" />
    </>
  ),
  'chevron-right': <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  'chevron-down': <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  'arrow-up': (
    <>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </>
  ),
  'arrow-down': (
    <>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </>
  ),
  external: (
    <>
      <path d="M14.5 5H19v4.5" />
      <path d="m19 5-8.5 8.5" />
      <path d="M19 13.5V18A1.5 1.5 0 0 1 17.5 19.5h-11A1.5 1.5 0 0 1 5 18V7A1.5 1.5 0 0 1 6.5 5.5H11" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5A1 1 0 0 1 10.5 4h3a1 1 0 0 1 1 1v2" />
      <path d="m6.5 7 .8 11.2a1.8 1.8 0 0 0 1.8 1.6h5.8a1.8 1.8 0 0 0 1.8-1.6L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="m7 9.5 3 2.5-3 2.5" />
      <path d="M12.5 15H17" />
    </>
  ),
  doc: (
    <>
      <path d="M6 4.5h7L18.5 10v9A1.5 1.5 0 0 1 17 20.5H6A1.5 1.5 0 0 1 4.5 19V6A1.5 1.5 0 0 1 6 4.5Z" />
      <path d="M13 4.5V10h5.5" />
    </>
  ),
  bulb: (
    <>
      <path d="M9.5 17.5h5" />
      <path d="M10.2 20.5h3.6" />
      <path d="M12 3.5a6 6 0 0 1 3.6 10.8c-.7.55-1.1 1-1.1 1.7h-5c0-.7-.4-1.15-1.1-1.7A6 6 0 0 1 12 3.5Z" />
    </>
  ),
  pin: (
    <>
      <path d="M9 4h6l-.6 6.2 2.9 3.4a.6.6 0 0 1-.46 1H7.16a.6.6 0 0 1-.46-1l2.9-3.4Z" />
      <path d="M12 14.6V20" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z" />
      <path d="m9 11.5 2.2 2.2 4.3-4.7" />
    </>
  ),
  bot: (
    <>
      <rect x="5" y="8.5" width="14" height="10.5" rx="2" />
      <path d="M12 8.5V5.5" />
      <circle cx="12" cy="4.3" r="1.1" />
      <path d="M9.2 13h.01M14.8 13h.01" />
      <path d="M9.5 16.2h5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4c2.7 2.2 2.7 13.8 0 16M12 4c-2.7 2.2-2.7 13.8 0 16" />
    </>
  ),
  link: (
    <>
      <path d="M10.5 13.5a4.2 4.2 0 0 0 6 0l2.4-2.4a4.24 4.24 0 0 0-6-6L11.5 6.5" />
      <path d="M13.5 10.5a4.2 4.2 0 0 0-6 0l-2.4 2.4a4.24 4.24 0 0 0 6 6l1.4-1.4" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.2 12c0-.5-.05-1-.13-1.44l1.9-1.44-1.86-3.22-2.25.9a7.4 7.4 0 0 0-2.5-1.44L14 3h-3.7l-.36 2.36a7.4 7.4 0 0 0-2.5 1.44l-2.25-.9-1.86 3.22 1.9 1.44a7.5 7.5 0 0 0 0 2.88l-1.9 1.44 1.86 3.22 2.25-.9a7.4 7.4 0 0 0 2.5 1.44L10.3 21h3.7l.36-2.36a7.4 7.4 0 0 0 2.5-1.44l2.25.9 1.86-3.22-1.9-1.44c.08-.44.13-.9.13-1.44Z" />
    </>
  ),
  expand: <path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" />,
  monitor: (
    <>
      <rect x="3.5" y="5" width="17" height="11.5" rx="1.5" />
      <path d="M9.5 20h5M12 16.5V20" />
    </>
  ),
  zap: <path d="M13 3 5.5 13.5H11L10.5 21 18 10.5h-5.5Z" />,
  spark: <path d="m12 4 1.9 5.4L19.5 11l-5.6 1.6L12 18l-1.9-5.4L4.5 11l5.6-1.6Z" />,
  box: (
    <>
      <path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6Z" />
      <path d="M4.2 7.7 12 11.9l7.8-4.2M12 11.9v8.7" />
    </>
  ),
  activity: (
    <>
      <path d="M3.5 12h3.6l2.4-6 4.6 12 2.4-6h4" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4.5" width="16" height="6.5" rx="1.5" />
      <rect x="4" y="13" width="16" height="6.5" rx="1.5" />
      <path d="M7 7.75h.01M7 16.25h.01" />
    </>
  ),
  play: <path d="M7.5 5.5 18.5 12 7.5 18.5Z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M4 4.5 20 19.5" />
      <path d="M9.9 6.2A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.9 16.9 0 0 1-2.2 3.1M6.7 6.7A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 3.3-.6" />
      <path d="M9.5 9.7a2.8 2.8 0 0 0 4 4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.2 2" />
    </>
  ),
  // 拓展包：配置导出/导入与日志导出按钮用（与既有 1.8 线宽同风格）
  download: (
    <>
      <path d="M12 4v10.5" />
      <path d="m6.8 10.8 5.2 5.2 5.2-5.2" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5V5" />
      <path d="M6.8 9.2 12 4l5.2 5.2" />
      <path d="M4.5 19.5h15" />
    </>
  ),
};

export default function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
