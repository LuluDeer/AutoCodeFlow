/**
 * R169：重试链面板**读失败 ≠ 没有重试额度**。
 *
 * ## 为什么专门守这一处
 *
 * 「重试链」Tab 的**预算 Tag** 与「手动重试」卡都挂在 `taskMaxRetry > 0` 上，而它来自
 * `useTaskDetail`。那个查询失败时 `taskData` 是 `undefined` ⇒ `taskMaxRetry` 落到 **0**
 * ⇒ 两块 UI **直接不渲染**，重试链列表也只剩空态文案。
 *
 * 用户看到的是「**这个任务没有重试额度、也没有重试记录**」—— 而真相是「**我们没读到**」。
 * **「没有」与「没读到」方向相反**：前者意味着不必再抢救，后者应当重试或报障。
 * 这个页面恰恰是排障最常落地的地方，所以这条假事实的代价很高。
 *
 * ## 判据（三条）
 *
 * ① 传 `loadError` ⇒ 必须渲染**错误块**（有「重试」按钮），且**不出现**任何预算/空态结论；
 * ② **不传** `loadError` 且 `taskMaxRetry > 0` ⇒ 预算 Tag 正常（**正例控制组**：
 *    证明上面那条不是因为「组件什么都不渲染」才绿的）；
 * ③ **不传** `loadError` 且 `taskMaxRetry === 0` ⇒ 不渲染错误块（0 是**真实**的 0）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  Link: (p: { to: string; children: React.ReactNode }) => <a href={p.to}>{p.children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('../hooks/useExecutorNames', () => ({
  useExecutorNames: () => ({ nameOf: (id: string) => id }),
}));

import ExecutionRetryChain from '../components/ExecutionRetryChain';
import type { RetryChainLink } from '../pages/retry-chain';

const LINK: RetryChainLink = {
  execId: 'e-1',
  attempt: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'failed',
  trigger: 'manual',
  failureReason: 'script_error',
  executorId: null,
  executorAddress: null,
  retryCount: 0,
} as RetryChainLink;

const baseProps = {
  taskId: 't-1',
  data: { id: 'e-1', retryCount: 0 },
  retryChain: [LINK],
  pendingRetry: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('R169：读失败不得渲染成「没有重试额度」', () => {
  it('① 传 loadError ⇒ 出错误块 + 重试按钮，且**没有**「没有重试额度」这类结论', () => {
    const onRetry = vi.fn();
    render(
      <ExecutionRetryChain
        {...baseProps}
        taskMaxRetry={0}
        loadError={new Error('boom')}
        onRetry={onRetry}
      />,
    );
    // 错误块必须出现（标题来自 execDetail.retry.loadFail）
    expect(screen.getByText(/重试链读取失败|Failed to load the retry chain/)).toBeTruthy();
    // 重试入口必须可用 —— 「没读到」的处置是「再试一次」
    const retryBtn = screen.getByRole('button', { name: /重试|Retry/ });
    retryBtn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    // 关键反向断言：不得出现任何「重试链为空 / 没有额度」的结论
    expect(document.body.textContent).not.toMatch(/重试预算|Retry budget/);
  });

  it('② 正例控制组：无 loadError + taskMaxRetry>0 ⇒ 预算 Tag 正常渲染', () => {
    render(<ExecutionRetryChain {...baseProps} taskMaxRetry={3} />);
    expect(document.body.textContent).toMatch(/重试预算|Retry budget/);
    expect(screen.queryByText(/重试链读取失败|Failed to load the retry chain/)).toBeNull();
  });

  it('③ 无 loadError + taskMaxRetry===0 ⇒ 不渲染错误块（0 是真实的 0）', () => {
    render(<ExecutionRetryChain {...baseProps} taskMaxRetry={0} />);
    expect(screen.queryByText(/重试链读取失败|Failed to load the retry chain/)).toBeNull();
  });
});
