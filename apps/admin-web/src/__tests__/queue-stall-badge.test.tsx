/**
 * R205 · 「队列可能停摆」徽标（`QueueStallBadge`）。
 *
 * ## 判据
 *
 * ① **停摆** ⇒ 显示徽标（文案说「**可能**」停摆，因 `workers===0` 有误报可能）。
 * ② **读失败** ⇒ 显式说「未知」（**不**得渲染成「队列正常」）。
 * ③ **`degraded`（判定不完整）** ⇒ 显式说「不完整」（**不**得渲染成「队列正常」）。
 * ④ **正例控制组**：真的读到且不��摆 ⇒ **不显示**（唯一合法的静默）。
 *
 * ②③必须**同时**测：只测②会漏掉「degraded 被当成正常」的实现，
 * 只测③会漏掉「读失败被当成正常」的实现 —— 而**这两种「正常」都是假事实**
 * （「没读到」渲染成「没问题」正是本仓主导缺陷类，R188–R204 修了 10+ 例）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const queueStall = vi.fn();
vi.mock('../api/agent', () => ({
  // R205：**独立方法**（R386）—— 不混进 `list` 的调用计数。
  agentApi: { queueStall: (...a: unknown[]) => queueStall(...a) },
}));

import QueueStallBadge from '../components/QueueStallBadge';

const obs = (over: Partial<{ stalled: boolean; reason: string | null; pendingJobs: number; degraded: boolean }> = {}) => ({
  stalled: false,
  reason: null,
  pendingJobs: 0,
  degraded: false,
  ...over,
});

afterEach(() => cleanup());

describe('R205 · 队列停摆徽标', () => {
  it('① 停摆 ⇒ 显示徽标；点击触发 onJump', async () => {
    queueStall.mockResolvedValue(obs({ stalled: true, reason: 'no-worker', pendingJobs: 12 }));
    const onJump = vi.fn();
    render(<QueueStallBadge onJump={onJump} />);

    await waitFor(() => expect(queueStall).toHaveBeenCalled());
    const jump = await screen.findByTestId('queue-stall-jump');
    fireEvent.click(jump);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('② 读失败 ⇒ 显式报「未知」，**不**渲染成「队列正常」', async () => {
    queueStall.mockRejectedValue(new Error('boom'));
    render(<QueueStallBadge />);

    // ⚠️ 用 `data-testid` 而不是文案：本仓测试环境的 i18n **不加载真实词条**
    //   （渲染出的是 key）—— R195 已踩过（→ 381）。
    await waitFor(() => expect(screen.getByTestId('queue-stall-load-fail')).toBeTruthy());
    // 且**不得**渲染出「停摆」徽标（那会让运营以为确有其事）
    expect(screen.queryByTestId('queue-stall-jump')).toBeNull();
  });

  it('③ `degraded`（判定不完整）⇒ 显式说「不完整」，**不**渲染成「正常」', async () => {
    // 后端在某个观测量读失败时返回 `stalled: false` + `degraded: true`
    // （不因一个计数读失败就断言停摆 —— 误报代价更大）。
    // ⇒ 前端**必须**把 `degraded` 呈现出来，而不是静默显示「一切正常」。
    queueStall.mockResolvedValue(obs({ stalled: false, degraded: true }));
    render(<QueueStallBadge />);

    await waitFor(() => expect(screen.getByTestId('queue-stall-degraded')).toBeTruthy());
    // 既不是「停摆」徽标，也不是「什么都没有」
    expect(screen.queryByTestId('queue-stall-jump')).toBeNull();
    expect(screen.queryByTestId('queue-stall-load-fail')).toBeNull();
  });

  it('④ 正例控制组：真的读到且**不**停摆 ⇒ **不显示**（唯一合法的静默）', async () => {
    queueStall.mockResolvedValue(obs({ stalled: false, degraded: false }));
    const { container } = render(<QueueStallBadge />);

    await waitFor(() => expect(queueStall).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent ?? '').toBe('');
  });
});
