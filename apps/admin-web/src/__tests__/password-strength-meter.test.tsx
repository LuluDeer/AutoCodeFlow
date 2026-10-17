/**
 * SECURITY §3.1：`PasswordStrengthMeter` 的渲染契约。
 *
 * 这个组件是"策略镜像"唯一的**可见**出口，所以断言的落点是"用户能读到什么"，
 * 而不是"内部算了什么"：
 *   1) 等级文案与分数分段一致（4 段色条按 score 填充）；
 *   2) 逐条规则清单给出 ok/not-ok，且**文字**承载信息（图标 aria-hidden、
 *      颜色只是增强——色盲/读屏用户必须拿到同样的答案）；
 *   3) 不合规时显式出现"提交会被后端拒绝"的提示，合规时不出现
 *      （把"后端一定会拒"讲清楚，而不是只给一个红色条）；
 *   4) 强度文本容器是 role="status" + aria-live="polite"（输入过程中会被
 *      朗读，但不打断用户输入）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PasswordStrengthMeter from '../components/PasswordStrengthMeter';

afterEach(() => {
  cleanup();
});

const filledCount = (prefix: string) =>
  [1, 2, 3, 4].filter(
    (n) =>
      screen.getByTestId(`${prefix}-segment-${n}`).getAttribute('data-filled') ===
      'true',
  ).length;

describe('PasswordStrengthMeter', () => {
  it('空密码：0 段填充、等级显示"尚未输入"、四条规则全部未满足', () => {
    render(<PasswordStrengthMeter password="" idPrefix="t-empty" />);
    expect(filledCount('t-empty')).toBe(0);
    expect(screen.getByTestId('t-empty-label').textContent).toContain('尚未输入');
    for (const rule of ['length', 'uppercase', 'digit', 'special']) {
      expect(
        screen.getByTestId(`t-empty-rule-${rule}`).getAttribute('data-ok'),
      ).toBe('false');
    }
  });

  it('不合规但很长：分段被压到 1、清单精确指出缺哪条、并提示"会被后端拒绝"', () => {
    // 24 位、仅小写 → 长度远超门槛但缺三条规则；若无封顶会显示为"强"
    render(<PasswordStrengthMeter password="abcdefghijklmnopqrstuvwx" idPrefix="t-cap" />);
    expect(filledCount('t-cap')).toBe(1);
    expect(screen.getByTestId('t-cap-label').textContent).toContain('弱');
    expect(screen.getByTestId('t-cap-rule-length').getAttribute('data-ok')).toBe('true');
    expect(screen.getByTestId('t-cap-rule-uppercase').getAttribute('data-ok')).toBe('false');
    expect(screen.getByTestId('t-cap-rule-digit').getAttribute('data-ok')).toBe('false');
    expect(screen.getByTestId('t-cap-rule-special').getAttribute('data-ok')).toBe('false');
    expect(screen.getByTestId('t-cap-label').textContent).toContain('会被后端拒绝');
  });

  it('合规（仅大写+数字+特殊字符，无小写）：四条规则全 ok、不再出现"会被后端拒绝"', () => {
    render(<PasswordStrengthMeter password="ALLCAPS2026!" idPrefix="t-ok" />);
    for (const rule of ['length', 'uppercase', 'digit', 'special']) {
      expect(screen.getByTestId(`t-ok-rule-${rule}`).getAttribute('data-ok')).toBe('true');
    }
    expect(screen.getByTestId('t-ok-label').textContent).not.toContain('会被后端拒绝');
    // 10 位 + 三/四类字符 → 至少 weak 以上（不写死具体等级，避免把启发式调参变成脆测试）
    expect(filledCount('t-ok')).toBeGreaterThanOrEqual(1);
  });

  it('20 位 + 四类字符：满格 4 段并显示"强"', () => {
    render(<PasswordStrengthMeter password="Abcdefgh1234!@#$XyZ" idPrefix="t-strong" />);
    expect(filledCount('t-strong')).toBe(4);
    expect(screen.getByTestId('t-strong-label').textContent).toContain('强');
  });

  it('无障碍：强度文本是 role=status + aria-live=polite；色条与图标为装饰', () => {
    render(<PasswordStrengthMeter password="ALLCAPS2026!" idPrefix="t-a11y" />);
    const label = screen.getByTestId('t-a11y-label');
    expect(label.getAttribute('role')).toBe('status');
    expect(label.getAttribute('aria-live')).toBe('polite');
    // 图标是 aria-hidden，信息由文字承载（读屏不会读出"✓ ✗"噪声）
    const list = screen.getByTestId('t-a11y-checklist');
    expect(list.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it('showChecklist=false 时只出强度条与等级（清单可关）', () => {
    render(
      <PasswordStrengthMeter password="ALLCAPS2026!" idPrefix="t-noc" showChecklist={false} />,
    );
    expect(screen.queryByTestId('t-noc-checklist')).toBeNull();
    expect(screen.getByTestId('t-noc-label')).toBeTruthy();
  });
});
