/**
 * UX-09（本轮体验审查）：键盘焦点环用了不在色板内、且不随主题切换的
 * antd 旧默认蓝 #1677FF。
 *
 * 症状：`src/styles/a11y-focus.css` 两处写死 #1677ff——
 *   ① `.a11y-skip-link` 的背景（跳到主要内容链接）；
 *   ② `.autoflow-layout :focus-visible` 的 outline。
 * 全站强调色是品牌绿 #22C55E，唯独键盘焦点是另一个蓝，视觉上像"没改完的
 * 默认值"；且该值是硬编码，暗色主题下也不会调整。
 *
 * 修法：改用专用令牌 `--color-focus-ring`（index.css 双主题各一档）。
 *
 * **为什么不是直接用 --color-accent**（这条是本修复的关键取舍）：品牌绿
 * #22C55E 在亮面 #FFFFFF / #F1F5F9 上只有 2.28:1 / 2.08:1，**低于 WCAG 2.2
 * SC 1.4.11 对焦点指示器要求的 3:1**——为了颜色一致性而让键盘用户看不见焦点，
 * 是把 a11y 换成了好看。故亮面取深一档的 #16A34A（3.30:1 / 3.01:1），
 * 暗面用 #22C55E（7.25:1 / 8.85:1）。
 *
 * 本文件既断言"值改对了"，也**自己算对比度**——避免把选色依据留成注释里的
 * 口头承诺（本轮已见过注释与实测完全相反的缺陷）。
 *
 * 反证：把任一处的 var(--color-focus-ring) 改回 #1677ff 或 var(--color-accent)，
 * 对应用例立即变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

/** 去掉 CSS 注释——注释里引用旧值不算违规。 */
const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某个主题块内某个自定义属性的值（花括号配对，避免命中注释后的伪块）。 */
function tokenIn(css: string, blockSelector: string, name: string): string | null {
  const clean = stripCssComments(css);
  const start = clean.indexOf(blockSelector);
  if (start === -1) return null;
  const open = clean.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const block = clean.slice(open, end);
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : null;
}

// ── WCAG 相对亮度与对比度（用于把"选色依据"变成可执行断言）──
function relLuminance(hex: string): number {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [x, y] = [relLuminance(a), relLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const CSS = read('index.css');
const FOCUS_CSS = read('styles/a11y-focus.css');

describe('UX-09：焦点环不得再用色板外的硬编码蓝', () => {
  it('a11y-focus.css 里不再出现 #1677ff（两处都已令牌化）', () => {
    expect(stripCssComments(FOCUS_CSS).toLowerCase()).not.toContain('#1677ff');
  });

  it('outline 取 --color-focus-ring（而非硬编码，也非 --color-accent）', () => {
    const clean = stripCssComments(FOCUS_CSS);
    const m = /outline:\s*2px solid ([^;]+);/.exec(clean);
    expect(m, '找不到 focus-visible 的 outline 声明').toBeTruthy();
    expect(m![1]).toContain('var(--color-focus-ring');
    // 关键：不能退回 --color-accent（亮面对比度不达标，见下）
    expect(m![1]).not.toContain('--color-accent');
    expect(m![1]).not.toContain('--color-ring');
  });

  it('skip-link 背景取 --color-accent，前景取深色（不是白字）', () => {
    const clean = stripCssComments(FOCUS_CSS);
    const bg = /background:\s*var\(--color-accent[^;]*;/.exec(clean);
    expect(bg, 'skip-link 背景未令牌化').toBeTruthy();
    // #22C55E 上白字仅 2.28:1；必须用深色文字
    const color = /\.a11y-skip-link\s*\{[\s\S]*?color:\s*([^;]+);/.exec(clean);
    expect(color, '找不到 skip-link 的 color').toBeTruthy();
    expect(color![1]).toContain('--color-primary');
  });
});

describe('UX-09：选色依据必须是可执行的对比度断言（不是注释里的承诺）', () => {
  const lightRing = tokenIn(CSS, ':root', '--color-focus-ring');
  const darkRing = tokenIn(CSS, "html[data-theme='dark']", '--color-focus-ring');

  it('双主题都定义了 --color-focus-ring', () => {
    expect(lightRing, ':root 缺 --color-focus-ring').toBeTruthy();
    expect(darkRing, "html[data-theme='dark'] 缺 --color-focus-ring").toBeTruthy();
  });

  it('亮面焦点环对所有亮面底色 ≥3:1（WCAG 2.2 SC 1.4.11）', () => {
    // 亮面卡面（antd Card 白底）与 muted 面（--color-muted #F1F5F9）
    for (const surface of ['#ffffff', '#f1f5f9']) {
      const r = contrast(lightRing!, surface);
      expect(r, `亮面焦点环 ${lightRing} on ${surface} 仅 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('暗面焦点环对所有暗面底色 ≥3:1', () => {
    // 暗面卡面（--color-muted #1A1E2F）与页面底色（--color-background #020617）
    for (const surface of ['#1a1e2f', '#020617']) {
      const r = contrast(darkRing!, surface);
      expect(r, `暗面焦点环 ${darkRing} on ${surface} 仅 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('反例存档：品牌绿直接当亮面焦点环是**不达标**的（解释为何要单独一档）', () => {
    // 这条不是断言产品代码，而是钉住"为什么不能图省事用 --color-accent"的
    // 量化依据。若哪天有人把 --color-accent 的值改成亮面达标的绿，这条会红
    // ——那时可以放心合并两个令牌（是一次有意的复核，而非误报）。
    const accent = tokenIn(CSS, ':root', '--color-accent');
    expect(accent).toBe('#22c55e');
    expect(contrast(accent!, '#ffffff')).toBeLessThan(3);
  });

  it('反例存档：--color-ring（MASTER 语义 #0F172A）当焦点环在暗面几乎不可见', () => {
    // UX-03 记录过 --color-ring 的值/语义错配；此处钉住"它不能当焦点环"。
    expect(contrast('#0f172a', '#1a1e2f')).toBeLessThan(1.5);
  });
});
