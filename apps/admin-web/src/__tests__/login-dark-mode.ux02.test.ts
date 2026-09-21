// @vitest-environment jsdom
/**
 * UX-02（本轮体验审查）：登录页在暗色主题下仍是亮底 + 不可见标题。
 *
 * 缺陷：登录页在 `ThemedProviders` 内（main.tsx:23），暗色下 Card 容器取
 * `DARK_TOKENS.container = #1A1E2F`，但页面自身有三处硬编码亮色：
 *   ① 外层整页 `linear-gradient(135deg, #f0f4ff, #f5f0ff)`——退出登录/会话
 *      过期跳回登录页时整页刺眼浅蓝紫，与全站暗色壳层割裂；
 *   ② 表单标题 `color: '#333'`——#333333 on #1A1E2F 对比度 **1.31:1**，
 *      「登录账号」几乎看不见；
 *   ③ 主按钮旧 antd 蓝紫渐变 #1677ff→#7c3aed，与全站 #22C55E 强调色
 *      （ThemeProviders colorPrimary）不一致。
 *
 * 修法：整页改用 `var(--color-background)`；标题去掉硬编码 color 让 antd
 * colorText token 生效；渐变收敛到品牌绿（与 MainLayout 同源）。
 *
 * 反证：把 `background: 'var(--color-background)'` 改回亮色渐变，或把
 * `color: '#333'` 加回标题，对应用例立即变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_SRC = readFileSync(join(__dirname, '..', 'pages', 'LoginPage.tsx'), 'utf-8');

/** 去掉注释，避免注释里引用的旧色值冒充真实代码。 */
const code = LOGIN_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /^\s*\/\/.*$/gm,
  '',
);

describe('UX-02：登录页暗色适配', () => {
  it('整页背景用主题感知变量，不再是硬编码亮色渐变', () => {
    expect(code).toContain("background: 'var(--color-background)'");
    // 原缺陷的两个渐变色值不得再出现在代码里
    expect(code).not.toContain('#f0f4ff');
    expect(code).not.toContain('#f5f0ff');
  });

  it('表单标题不再硬编码 #333（暗面 1.31:1 不可见）', () => {
    // 关键反证：加回 color: '#333' 本断言即红。
    expect(code).not.toContain("color: '#333'");
    // 标题仍保留 aria-labelledby 关联所需的 id（UX-12 不回归）
    expect(code).toContain('login-form-title');
  });

  it('主按钮与品牌图标收敛到全站强调色，不再是旧 antd 蓝紫', () => {
    expect(code).not.toContain('#1677ff');
    expect(code).not.toContain('#7c3aed');
    // 与 MainLayout 的品牌渐变同源——D-P2-16（设计审计）起收敛为
    // theme/tokens.ts 的 BRAND_GRADIENT 单源（不再内联渐变字面量）。
    expect(code).toContain('BRAND_GRADIENT');
  });

  it('反证：主题变量确实随 data-theme 翻转（否则上面的替换等于没修）', () => {
    const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rootBg = css.match(/:root\s*\{[^}]*--color-background:\s*(#[0-9a-fA-F]{3,6})/s);
    const darkBg = css.match(
      /html\[data-theme='dark'\]\s*\{[^}]*--color-background:\s*(#[0-9a-fA-F]{3,6})/s,
    );
    expect(rootBg?.[1]).toBeTruthy();
    expect(darkBg?.[1]).toBeTruthy();
    // 亮暗必须不同——同值就意味着「改用变量」并不能修好暗色
    expect(rootBg![1].toLowerCase()).not.toBe(darkBg![1].toLowerCase());
  });
});
