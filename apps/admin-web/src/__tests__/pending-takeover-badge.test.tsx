/**
 * R198 · 「**待接管 N**」页头入口（Roadmap P1「异常接管台」的最小可用形态）。
 *
 * ## 这是**功能新增**，判据也因此要钉「新功能的三条正确性」
 *
 * ① **有 N 时显示 N，点一下只筛 `waiting_input`**（功能本身）；
 * ② **读失败时必须显式说「未能获取」** —— 不能渲染成「0 个待接管」、
 *    也不能**不渲染**。两者都会让运营**放心地不去处理**（"看起来没人等我"）。
 *    这正是本仓主导缺陷类（R188–R195 修了 8+ 例）的同型；
 * ③ **只有「真的读到且为 0」才允许不显示** —— 这是唯一合法的静默情形。
 *    ②与③必须**同时**成立：只测②会漏掉「永远显示错误」的实现，
 *    只测③会漏掉「读失败也说 0」的实现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const pendingTakeoverCount = vi.fn();
vi.mock('../api/agent', () => ({
  // R198：徽标用**独立方法**（不是 `agentApi.list`）—— 见 `api/agent.ts` 的注释：
  // 复用 `list` 会污染既有「list 被调了几次」的断言（实测让 3 个用例从绿变红）。
  agentApi: { pendingTakeoverCount: (...a: unknown[]) => pendingTakeoverCount(...a) },
}));

import PendingTakeoverBadge from '../components/PendingTakeoverBadge';

beforeEach(() => {
  pendingTakeoverCount.mockReset();
});
afterEach(() => cleanup());

describe('R198 · 待接管徽标', () => {
  it('① 有 N 个待接管 ⇒ 显示 N；点击触发 onJump（页面据此只筛 waiting_input）', async () => {
    pendingTakeoverCount.mockResolvedValue(3);
    const onJump = vi.fn();
    render(<PendingTakeoverBadge onJump={onJump} />);

    await waitFor(() => expect(pendingTakeoverCount).toHaveBeenCalled());
    // 徽标数字 3 出现
    await waitFor(() => expect(document.body.textContent).toContain('3'));
    // 用了**专门的方法**（口径内部固定为 `waiting_input`，见 `api/agent.ts`）
    expect(pendingTakeoverCount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('pending-takeover-jump'));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('② 读失败 ⇒ **显式**说「未能获取」（不谎报 0、也不静默不渲染）', async () => {
    pendingTakeoverCount.mockRejectedValue(new Error('boom'));
    render(<PendingTakeoverBadge onJump={() => {}} />);

    // ⚠️ 用 `data-testid` 而不是文案：本仓测试环境的 i18n **不加载真实词条**
    //   （渲染出的是 key）—— 这是 R195 已经踩过的坑（→ 381）。
    await waitFor(() =>
      expect(screen.getByTestId('pending-takeover-load-fail')).toBeTruthy(),
    );
    // 且**不得**同时渲染出「可点击跳转」的徽标（那会让运营以为有具体数字可看）
    expect(screen.queryByTestId('pending-takeover-jump')).toBeNull();
  });

  it('③ 正例控制组：真的读到 0 ⇒ **不显示**（这是唯一合法的静默）', async () => {
    pendingTakeoverCount.mockResolvedValue(0);
    const { container } = render(<PendingTakeoverBadge onJump={() => {}} />);

    await waitFor(() => expect(pendingTakeoverCount).toHaveBeenCalled());
    // 等一拍，确认它**没有**渲染出按钮/错误文案
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent ?? '').toBe('');
  });
});
