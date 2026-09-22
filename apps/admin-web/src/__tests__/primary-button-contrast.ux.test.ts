/**
 * 阶段一设计遗留（设计建议#1）：主操作按钮白字对比度守卫。
 *
 * 症状：antd `type="primary"` 按钮白字落在品牌绿 #22C55E 上，实测仅 2.28:1，
 * 低于 WCAG 2.1 AA SC 1.4.11 正文 4.5:1。品牌绿已被团队刻意保留（ux09 注释、
 * BRAND_GRADIENT、状态点），故只把主按钮填充加深到 green-700 #15803d
 * （白字 5.02:1），品牌绿在渐变/状态点/链接场景原样保留。
 *
 * 与 ux09 焦点环守卫同一哲学：既断言"值改对了"，也**自己算对比度**——
 * 不把选色依据留成注释里的口头承诺。亮/暗双主题同源（按钮填充不随主题翻转，
 * 文字恒为 antd colorTextLightSolid 白），故对两主题做同一组断言。
 *
 * 反证：把 index.css 的 #15803d 改回 #22c55e（或删整块覆盖），对应用例立即变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

/** 去掉 CSS 注释——注释里引用旧值不算违规。 */
const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某个主题块内某个自定义属性的值（花括号配对）。 */
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

// ── WCAG 相对亮度与对比度 ──
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
const cleanCss = stripCssComments(CSS);
const tokensTs = read('theme/tokens.ts');

/** 从 .ant-btn-primary 覆盖块里抽某一态的 background hex。 */
function buttonBg(state: 'base' | 'hover' | 'active'): string | null {
  const selector =
    state === 'base'
      ? /\.ant-btn-primary:not\([^)]*\):not\(:disabled\):not\(\.ant-btn-disabled\)\s*\{([^}]*)\}/
      : state === 'hover'
        ? /\.ant-btn-primary:not\([^)]*\):not\(:disabled\):not\(\.ant-btn-disabled\):hover\s*\{([^}]*)\}/
        : /\.ant-btn-primary:not\([^)]*\):not\(:disabled\):not\(\.ant-btn-disabled\):active\s*\{([^}]*)\}/;
  const m = selector.exec(cleanCss);
  if (!m) return null;
  const bg = /background:\s*(#[0-9a-fA-F]{6})/.exec(m[1]);
  return bg ? bg[1].toLowerCase() : null;
}

describe('阶段一遗留：主操作按钮白字对比度（WCAG AA ≥4.5:1）', () => {
  const base = buttonBg('base');
  const hover = buttonBg('hover');
  const active = buttonBg('active');

  it('三态覆盖块都存在且取出了 hex（反永真：块被删/改名即红）', () => {
    expect(base, '缺少 .ant-btn-primary base 覆盖块').toBeTruthy();
    expect(hover, '缺少 .ant-btn-primary:hover 覆盖块').toBeTruthy();
    expect(active, '缺少 .ant-btn-primary:active 覆盖块').toBeTruthy();
  });

  it('base / hover / active 白字对比度均 ≥4.5:1', () => {
    for (const [name, bg] of [
      ['base', base],
      ['hover', hover],
      ['active', active],
    ] as const) {
      const r = contrast(bg!, '#ffffff');
      expect(r, `主按钮 ${name} ${bg} 白字仅 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('明暗双主题同源——暗面不得把主按钮填充改回亮绿', () => {
    // 若有人加了 `html[data-theme='dark'] .ant-btn-primary { background:#22c55e }`，
    // 暗面主按钮会退回 2.28:1。这里钉死不存在这种主题翻转覆盖。
    const darkOverride = /html\[data-theme=['"]dark['"]\]\s+\.ant-btn-primary[^{]*\{[^}]*background\s*:/.test(
      cleanCss,
    );
    expect(darkOverride, '存在暗面 .ant-btn-primary background 翻转覆盖').toBe(false);
  });

  it('品牌绿在非文字场景保留——--color-accent 仍为 #22c55e', () => {
    const accentLight = tokenIn(CSS, ':root', '--color-accent');
    expect(accentLight).toBe('#22c55e');
  });

  it('tokens.ts 的 PRIMARY_BUTTON 与 CSS 值双向对齐（防两处漂移）', () => {
    const m = /PRIMARY_BUTTON\s*=\s*\{[^}]*bg:\s*'(#[0-9a-fA-F]{6})'/.exec(tokensTs);
    expect(m, 'tokens.ts 缺少 PRIMARY_BUTTON.bg').toBeTruthy();
    expect(m![1].toLowerCase()).toBe(base);
  });

  it('反例存档：品牌绿直接当主按钮底色是不达标的（解释为何要加深）', () => {
    expect(contrast('#22c55e', '#ffffff')).toBeLessThan(4.5);
    // 任务建议的 #16a34a 实测只有 3.30:1，同样不达标——故取更深的 #15803d（5.02:1）
    expect(contrast('#16a34a', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#15803d', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
