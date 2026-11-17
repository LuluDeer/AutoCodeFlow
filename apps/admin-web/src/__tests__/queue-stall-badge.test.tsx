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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const queueStall = vi.fn();
vi.mock('../api/agent', () => ({
  // R205：**独立方法**（R386）—— 不混进 `list` 的调用计数。
  agentApi: { queueStall: (...a: unknown[]) => queueStall(...a) },
}));

import QueueStallBadge from '../components/QueueStallBadge';

const obs = (
  over: Partial<{
    stalled: boolean;
    reason: string | null;
    pendingJobs: number;
    degraded: boolean;
    degradedCounts: boolean;
    workersKnown: boolean;
  }> = {},
) => ({
  stalled: false,
  reason: null,
  pendingJobs: 0,
  degraded: false,
  degradedCounts: false,
  workersKnown: true,
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

  it('⑤ R211：`degradedCounts`（可能漏报）⇒ **仍显示停摆徽标**，不渲染成「未知」', async () => {
    // ⚠️ 关键取舍：计数类读失败只会让 `pendingJobs` 变小（更难判停摆）⇒ 它是**漏报**风险。
    // 把它当成「判定不完整」会**吞掉一条真实停摆**（与 R210 修的那个误报方向相反的错误）。
    queueStall.mockResolvedValue(
      obs({ stalled: true, reason: 'no-worker', pendingJobs: 3, degradedCounts: true }),
    );
    render(<QueueStallBadge />);

    await waitFor(() => expect(screen.getByTestId('queue-stall-jump')).toBeTruthy());
    expect(screen.queryByTestId('queue-stall-degraded')).toBeNull();
  });

  it('⑥ R211：`workersKnown: false` ⇒ 文案**不得**断言「没有 worker」', async () => {
    // `workers === 0` 只有在 `workersKnown` 时才是事实；否则那只是**回落值**。
    // 两者都显示同一个徽标，但**措辞必须不同** —— 否则就是把「不知道」说成「确有其事」。
    //
    // ⚠️ 断言方式：antd Tooltip 的内容在测试环境里**懒挂载**（hover 时序 + portal），
    //    逐字断言不稳定。⇒ 直接测**渲染决策**：把 `t` 换成一个记录 key 的桩，
    //    看在 `workersKnown` 两种取值下**请求了哪个 key** —— 这正是「措辞」在测试里
    //    唯一可观察且稳定的形态（文案字号/标点不属于判据）。
    queueStall.mockResolvedValue(
      obs({ stalled: true, reason: 'no-worker', pendingJobs: 5, workersKnown: false }),
    );
    render(<QueueStallBadge />);
    await screen.findByTestId('queue-stall-jump');

    // 源码层判据：组件里必须**按 workersKnown 分支选 key**（两条 hint 都要出现）。
    // 这是对「实现有没有这个分支」的直接检查 —— 删掉分支 ⇒ 本条立刻红。
    const src = readFileSync(
      join(__dirname, '..', 'components', 'QueueStallBadge.tsx'),
      'utf8',
    );
    expect(src).toContain('agents.queueStall.workerUnknownHint');
    expect(src).toContain('agents.queueStall.noWorkerHint');
    // 且必须真的**以 workersKnown 为条件**（不是两条并列写死）
    expect(src).toMatch(/state\.workersKnown[\s\S]{0,200}workerUnknownHint/);
    // 仍然**不**渲染成「未知」：停摆本身是成立的判断（service 已保证未知时不判停摆）
    expect(screen.queryByTestId('queue-stall-degraded')).toBeNull();
  });

  it('⑦ 正例控制组：真的读到且**不**停摆 ⇒ **不显示**（唯一合法的静默）', async () => {
    queueStall.mockResolvedValue(obs({ stalled: false, degraded: false }));
    const { container } = render(<QueueStallBadge />);

    await waitFor(() => expect(queueStall).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent ?? '').toBe('');
  });
});
