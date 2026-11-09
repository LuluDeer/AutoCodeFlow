/**
 * R199 · 「卡住 N」徽标（`StalledBadge`）+ 「只看卡住」标签组。
 *
 * ## 三条约束（与 R198 同款，来自本仓主导缺陷类）
 *
 * ① **读失败不得渲染成「0 个卡住」** —— 那会让运营放心地不去管；
 * ② **读失败不得静默不渲染** —— 同上（静默等于谎报 0）；
 * ③ **只有「真的读到且为 0」才允许不显示** —— 唯一的合法静默情形。
 *
 * ②与③**必须同时测**：只测②会漏掉「永远显示错误」的实现，
 * 只测③会漏掉「读失败也说 0」的实现。
 *
 * ## 另有一条**互斥**判据（两个徽标不能打架）
 *
 * 「待接管」（`waiting_input`）与「卡住」（`running` 且久无进展）**互不重叠**
 * ⇒ 两个徽标可以同时出现，语义不冲突（判据见 `docs/observability/agent-stalled-criterion.md` §2.3）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const stalledCount = vi.fn();
vi.mock('../api/agent', () => ({
  // R199：徽标用**独立方法**（不是 `agentApi.list`）—— 见 `api/agent.ts` 的注释：
  // 复用 `list` 会污染既有「list 被调了几次」的断言（R198 实测：3 个用例从绿变红）。
  agentApi: {
    stalledCount: (...a: unknown[]) => stalledCount(...a),
    pendingTakeoverCount: vi.fn().mockResolvedValue(0),
  },
}));

import StalledBadge from '../components/StalledBadge';

beforeEach(() => {
  stalledCount.mockReset();
});
afterEach(() => cleanup());

describe('R199 · 卡住徽标', () => {
  it('① 有 N 个卡住 ⇒ 显示 N；点击触发 onJump', async () => {
    stalledCount.mockResolvedValue(2);
    const onJump = vi.fn();
    render(<StalledBadge onJump={onJump} />);

    await waitFor(() => expect(stalledCount).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent).toContain('2'));
    expect(stalledCount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('stalled-jump'));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('② 读失败 ⇒ **显式**说「未知」（不谎报 0、也不静默不渲染）', async () => {
    stalledCount.mockRejectedValue(new Error('boom'));
    render(<StalledBadge onJump={() => {}} />);

    // ⚠️ 用 `data-testid` 而不是文案：本仓测试环境的 i18n **不加载真实词条**
    //   （渲染出的是 key）—— R195 已踩过（→ 381）。
    await waitFor(() => expect(screen.getByTestId('stalled-load-fail')).toBeTruthy());
    // 且**不得**同时渲染出「可点击跳转」的徽标（那会让运营以为有具体数字可看）
    expect(screen.queryByTestId('stalled-jump')).toBeNull();
  });

  it('③ 正例控制组：真的读到 0 ⇒ **不显示**（这是唯一合法的静默）', async () => {
    stalledCount.mockResolvedValue(0);
    const { container } = render(<StalledBadge onJump={() => {}} />);

    await waitFor(() => expect(stalledCount).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent ?? '').toBe('');
  });
});
