/**
 * 阶段一设计遗留（设计建议#4）：768–1024px 中宽屏头部排布守卫。
 *
 * MainLayout Header 是 flex + justify-content:space-between：左侧长面包屑、
 * 右侧 5+ 控件。在 769–1024px 窄中宽屏二者会挤压/溢出。修复在 index.css
 * 加了一段 `@media (min-width:769px) and (max-width:1024px)`：藏时钟、面包屑
 * 可收缩并省略号。本守卫钉住该段不回退，并确认它作用于真实头部结构。
 *
 * 与 focus-ring/对比度守卫同一形态：静态读 CSS + 读 MainLayout 源码（渲染层
 * 无真实视口测试设施；断点与选择器钉死即防回归）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  it('该区间隐藏次要信息时钟 .header-time', () => {
    expect(band, '中宽屏块内未隐藏 .header-time').toContain('.header-time');
    expect(band).toMatch(/\.header-time\s*\{[^}]*display:\s*none\s*!important/);
  });

  it('该区间面包屑可收缩（min-width:0）并省略号', () => {
    expect(band).toContain('.header-breadcrumb');
    expect(band).toMatch(/\.header-breadcrumb\s*\{[^}]*min-width:\s*0/);
    expect(band).toContain('text-overflow: ellipsis');
  });

  it('作用于真实头部结构：MainLayout 仍渲染 .header-breadcrumb 与 .header-time', () => {
    expect(layout).toContain('className="header-breadcrumb"');
    expect(layout).toContain('className="header-time"');
    // 头部仍是 space-between（修复前提：左右两组被推开）
    expect(layout).toContain('justifyContent: \'space-between\'');
  });

  it('不影响 ≤768px 既有移动端规则（移动块仍在）', () => {
    expect(CSS).toContain('@media (max-width: 768px)');
  });
});
