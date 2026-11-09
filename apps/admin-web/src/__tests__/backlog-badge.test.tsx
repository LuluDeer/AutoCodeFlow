/**
 * R203 · 「积压 N」徽标（`BacklogBadge`）—— Roadmap P1 接管台三件套的第三件。
 *
 * ## 与另两个徽标的口径对照（三者**互不重叠**）
 *
 * | 徽标 | 状态 | 现象 | 人的动作 |
 * |---|---|---|---|
 * | 待接管（R198） | `waiting_input` | **正常地**在等人 | 审批 / 回复澄清 |
 * | 卡住（R199） | `running` 且久无进展 | 跑着跑着不动了 | 介入 / 终止 |
 * | **积压（本轮）** | `pending` 且**队列里没有 job** | **根本没开始跑** | **重新入队**（无损、幂等） |
 *
 * ## 判据
 *
 * ① 有 N 条积压 ⇒ 显示 N；点击触发 `onJump`。
 * ② **读失败 ⇒ 显式说「未知」**（不谎报 0、也不静默不渲染）。
 * ③ **正例控制组**：真的读到 0 ⇒ **不显示**（唯一合法的静默）。
 * ④ **`truncated` 必须呈现**（R395 的直接落地）——
 *    对账有上限（后端 200 条）。若截断了却只显示「3」，运营会以为「一共就 3 条」，
 *    而实际可能有几百条 ⇒ **同一符号两个语义**。⇒ 截断时数字必须带 `+`。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const backloggedCount = vi.fn();
vi.mock('../api/agent', () => ({
  // R203：**独立方法**（R386）—— 不混进 `list` 的调用计数。
  agentApi: { backloggedCount: (...a: unknown[]) => backloggedCount(...a) },
}));

import BacklogBadge from '../components/BacklogBadge';

const ok = (count: number, truncated = false, probed = 200) => ({
  sessionIds: Array.from({ length: count }, (_, i) => `s${i}`),
  count,
  probed,
  truncated,
});

// 每个用例自己设定 mock 返回值（**不**在 beforeEach 里 reset：
//  会把实现清成 ，与  组合时
// 会让「未处理的拒绝」在下一个用例里冒出来 —— 实测踩过）。
afterEach(() => cleanup());

describe('R203 · 积压徽标', () => {
  it('① 有 N 条积压 ⇒ 显示 N；点击触发 onJump', async () => {
    backloggedCount.mockResolvedValue(ok(2));
    const onJump = vi.fn();
    render(<BacklogBadge onJump={onJump} />);

    await waitFor(() => expect(backloggedCount).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent).toContain('2'));
    expect(backloggedCount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('backlog-jump'));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('② 读失败 ⇒ **显式**报「未知」（不谎报 0、也不静默不渲染）', async () => {
    backloggedCount.mockRejectedValue(new Error('boom'));
    render(<BacklogBadge onJump={() => {}} />);

    // ⚠️ 用 `data-testid` 而不是文案：本仓测试环境的 i18n **不加载真实词条**
    //   （渲染出的是 key）—— R195 已踩过（→ 381）。
    await waitFor(() => expect(screen.getByTestId('backlog-load-fail')).toBeTruthy());
    // 且**不得**同时渲染出「可点击跳转」的徽标（那会让运营以为有具体数字可看）
    expect(screen.queryByTestId('backlog-jump')).toBeNull();
  });

  it('③ 正例控制组：真的读到 0 ⇒ **不显示**（唯一合法的静默）', async () => {
    backloggedCount.mockResolvedValue(ok(0, false, 0));
    const { container } = render(<BacklogBadge onJump={() => {}} />);

    await waitFor(() => expect(backloggedCount).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent ?? '').toBe('');
  });

  it('④ **`truncated` 必须呈现**：截断时数字带 `+`（不把「只查了 200 条」显示成「一共 3 条」）', async () => {
    backloggedCount.mockResolvedValue(ok(3, true, 200));
    render(<BacklogBadge onJump={() => {}} />);

    await waitFor(() => expect(backloggedCount).toHaveBeenCalled());
    // 数字必须是 `3+` 而不是 `3`
    await waitFor(() => expect(document.body.textContent).toContain('3+'));
  });

  it('⑤ 未截断时**不得**多出 `+`（否则「3」与「3+」的区分就失效了）', async () => {
    backloggedCount.mockResolvedValue(ok(3, false));
    render(<BacklogBadge onJump={() => {}} />);

    await waitFor(() => expect(backloggedCount).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent).toContain('3'));
    expect(document.body.textContent).not.toContain('3+');
  });
});
