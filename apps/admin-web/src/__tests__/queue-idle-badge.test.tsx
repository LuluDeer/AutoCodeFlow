/**
 * R207 · 「队列可能空转」徽标（`QueueIdleBadge`）。
 *
 * ## 判据
 *
 * ① **空转** ⇒ 显示徽标（文案说「**可能**」，因阈值有误报窗口）。
 * ② **读失败** ⇒ 显式说「未知」（**不**得渲染成「队列正常」）。
 * ③ **`degraded`（判定不完整）** ⇒ 显式说「不完整」（**不**得渲染成「正常」）。
 * ④ **`suppressedBy === 'queue-stall'`（让位）** ⇒ **静默**，且**不得**渲染成
 *    「未知」—— 让位是**完整判定**，渲染「未知」会是另一种假事实。
 * ⑤ **正例控制组**：真的读到且不空转 ⇒ **不显示**（唯一合法的静默）。
 *
 * ②③⑤ 必须**同时**测：只测②会漏掉「degraded 被当成正常」，只测③会漏掉
 * 「读失败被当成正常」——**这两种「正常」都是假事实**（「没读到」渲染成
 * 「没问题」正是本仓主导缺陷类，R188–R206 修了 10+ 例）。
 * ④ 是本条**特有**的：`suppressedBy` 与 `degraded` 都会让徽标不显示，
 * 但一个是「完整判定、归别的徽标」、另一个是「判定坏了」⇒ 必须分别钉住，
 * 否则把它们压成同一条分支的实现会静默通过。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const queueIdle = vi.fn();
vi.mock('../api/agent', () => ({
  // R207：**独立方法**（R386）—— 不混进 `list` / `queueStall` 的调用计数。
  agentApi: { queueIdle: (...a: unknown[]) => queueIdle(...a) },
}));

import QueueIdleBadge from '../components/QueueIdleBadge';

const obs = (
  over: Partial<{
    idleStuck: boolean;
    oldestAgeMs: number;
    thresholdMs: number;
    waitingCount: number;
    retried: boolean;
    suppressedBy: 'queue-stall' | null;
    degraded: boolean;
  }> = {},
) => ({
  idleStuck: false,
  oldestAgeMs: 0,
  thresholdMs: 3_630_000,
  waitingCount: 0,
  retried: false,
  suppressedBy: null as 'queue-stall' | null,
  degraded: false,
  ...over,
});

afterEach(() => cleanup());

describe('R207 · 队列空转徽标', () => {
  it('① 空转 ⇒ 显示徽标；点击触发 onJump', async () => {
    queueIdle.mockResolvedValue(
      obs({ idleStuck: true, oldestAgeMs: 4_000_000, waitingCount: 5 }),
    );
    const onJump = vi.fn();
    render(<QueueIdleBadge onJump={onJump} />);

    await waitFor(() => expect(queueIdle).toHaveBeenCalled());
    const jump = await screen.findByTestId('queue-idle-jump');
    fireEvent.click(jump);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('② 读失败 ⇒ 显式报「未知」，**不**渲染成「队列正常」', async () => {
    queueIdle.mockRejectedValue(new Error('boom'));
    render(<QueueIdleBadge />);

    // ⚠️ 用 `data-testid` 而不是文案：本仓测试环境的 i18n **不加载真实词条**
    //   （渲染出的是 key）—— R195 已踩过（→ 381）。
    await waitFor(() => expect(screen.getByTestId('queue-idle-load-fail')).toBeTruthy());
    expect(screen.queryByTestId('queue-idle-jump')).toBeNull();
  });

  it('③ `degraded`（判定不完整）⇒ 显式说「不完整」，**不**渲染成「正常」', async () => {
    queueIdle.mockResolvedValue(obs({ idleStuck: false, degraded: true }));
    render(<QueueIdleBadge />);

    await waitFor(() => expect(screen.getByTestId('queue-idle-degraded')).toBeTruthy());
    expect(screen.queryByTestId('queue-idle-jump')).toBeNull();
    expect(screen.queryByTestId('queue-idle-load-fail')).toBeNull();
  });

  it('④ 让位给停摆徽标 ⇒ **静默**（既不是「未知」也不是「空转」）', async () => {
    // 后端在「已停摆」时返回 `suppressedBy: 'queue-stall'` + `idleStuck: false`。
    // ⚠️ 这是**完整判定**，只是这一格归停摆徽标 ⇒ 若渲染成「未知」，
    //   运营会以为观测坏了，而它其实好得很（另一种假事实）。
    queueIdle.mockResolvedValue(obs({ suppressedBy: 'queue-stall', waitingCount: 3 }));
    const { container } = render(<QueueIdleBadge />);

    await waitFor(() => expect(queueIdle).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent ?? '').toBe('');
    expect(screen.queryByTestId('queue-idle-degraded')).toBeNull();
    expect(screen.queryByTestId('queue-idle-load-fail')).toBeNull();
  });

  it('⑤ 正例控制组：真的读到且**不**空转 ⇒ **不显示**（唯一合法的静默）', async () => {
    queueIdle.mockResolvedValue(obs({ idleStuck: false, degraded: false }));
    const { container } = render(<QueueIdleBadge />);

    await waitFor(() => expect(queueIdle).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent ?? '').toBe('');
  });
});
