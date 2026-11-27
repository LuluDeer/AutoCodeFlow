/**
 * 阶段一设计遗留（设计建议#4）：768–1024px 中宽屏头部排布守卫。
 *
 * MainLayout Header 是 flex + justify-content:space-between：左侧长面包屑、
 * 右侧 header-controls（项目切换/待办/通知/用户等）。在 769–1024px 窄中宽屏
 * 二者会挤压/溢出。index.css 的 `@media (min-width:769px) and (max-width:1024px)`
 * 收紧项目切换器、让面包屑可收缩并省略号，配合全局 .inbox-badge-units 收口防溢出。
 * 本守卫钉住该段不回退，并确认它作用于真实头部结构；挂钟 DOM 已移除，不再作锚点。
 *
 * 与 focus-ring/对比度守卫同一形态：静态读 CSS + 读 MainLayout 源码（渲染层
 * 无真实视口测试设施；断点与选择器钉死即防回归）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18n from '../i18n';
import { formatShortTime } from '../utils/timeFormat';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

const clean = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS = clean(read('index.css'));
const layout = read('layouts/MainLayout.tsx');

/** 取某媒体查询块内的文本。 */
function mediaBlock(css: string, feature: string): string | null {
  const start = css.indexOf(feature);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return end === -1 ? null : css.slice(open, end);
}

describe('阶段一遗留：768–1024px 中宽屏头部排布', () => {
  const band = mediaBlock(CSS, 'min-width: 769px') ?? '';

  it('存在 min-width:769 / max-width:1024 的中宽屏媒体查询块', () => {
    const hasRange = /@media\s*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)/.test(CSS);
    expect(hasRange, '缺少 769–1024px 中宽屏媒体查询').toBe(true);
  });

  it('该区间收紧项目切换器并保留面包屑可收缩/省略号（替代旧挂钟方案）', () => {
    expect(band).toMatch(/\.header-project\s*\{[^}]*width:\s*136px/);
    expect(band).toContain('.header-breadcrumb');
    expect(band).toMatch(/\.header-breadcrumb\s*\{[^}]*min-width:\s*0/);
    expect(band).toMatch(/\.header-breadcrumb\s*\{[^}]*flex:\s*1 1 auto/);
    expect(band).toContain('overflow: hidden');
    expect(band).toContain('text-overflow: ellipsis');
    expect(band).toContain('white-space: nowrap');
  });

  it('作用于真实头部结构：Header space-between = 左 header-breadcrumb + 右 header-controls', () => {
    expect(layout).toContain('justifyContent: \'space-between\'');
    expect(layout).toContain('className="header-breadcrumb"');
    expect(layout).toContain('className="header-controls"');
    // IA-HEADER 已移除挂钟：旧断言 `className="header-time"` 已不存在，禁止复活。
    expect(layout).not.toContain('className="header-time"');
  });

  it('不影响 ≤768px 既有移动端规则（移动块仍在且项目选择器放宽至 112px）', () => {
    expect(CSS).toContain('@media (max-width: 768px)');
    const mobile = mediaBlock(CSS, 'max-width: 768px') ?? '';
    expect(mobile).toMatch(/\.header-project\s*\{[^}]*width:\s*112px/);
  });

  it('防 1280/1440 英文顶栏横向溢出：header-controls 不换行且 inbox 明细收口', () => {
    const inboxBadge = read('components/InboxBadge.tsx');
    expect(inboxBadge).toContain('className="inbox-badge-units"');
    expect(CSS).toMatch(/\.inbox-badge-units\s*\{[^}]*display:\s*none/);
    expect(layout).toContain('<InboxBadge />');
    // Header 内联样式钉死单行不换行：没有 flexWrap，gap/居中仍是同一套布局。
    expect(layout).toMatch(/display:\s*'flex'/);
    expect(layout).toMatch(/alignItems:\s*'center'/);
    expect(layout).toMatch(/gap:\s*8/);
    expect(layout).not.toContain('flexWrap');
  });
});

describe('timeFormat.formatShortTime（短格式出口的 zh/en 稳定性）', () => {
  const iso = '2026-01-02T03:04:05Z';
  const options = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  } as const;

  afterEach(async () => {
    await i18n.changeLanguage('zh');
  });

  it('默认 zh → zh-CN 短格式', () => {
    expect(formatShortTime(iso)).toBe(new Date(iso).toLocaleString('zh-CN', options));
  });

  it('切到 en → en-US 短格式，且与 zh-CN 不同', async () => {
    await i18n.changeLanguage('en');
    expect(formatShortTime(iso)).toBe(new Date(iso).toLocaleString('en-US', options));
    expect(formatShortTime(iso)).not.toBe(new Date(iso).toLocaleString('zh-CN', options));
  });

  it('非法/空值回落占位符（与 formatDateTime 同口径）', () => {
    expect(formatShortTime(null)).toBe('—');
    expect(formatShortTime('not-a-date')).toBe('—');
  });
});
