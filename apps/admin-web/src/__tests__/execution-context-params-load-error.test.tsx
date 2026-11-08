/**
 * R176：「参数区」的**读失败 ≠ 没有参数**。
 *
 * ## 为什么专门守这一处
 *
 * 「参数」是**执行时的输入**。此前任务详情读失败时，`taskData` 是 `undefined` ⇒ 参数区落
 * 「**本任务未配置默认参数**」⇒ 用户很可能据此判断「**这个执行不需要参数**」而**放弃追查**。
 * 「没有参数」与「**没读到参数**」是**方向相反**的两个结论：前者是正常态，后者应当重试/报障。
 *
 * 本仓同一形态已连续修过 7 处（R169/R170/R176），本组件把三分支固化成**可测**的 props。
 *
 * ## 判据（三条）
 *
 * ① `loadError` 存在 ⇒ 出**错误块**（含重试按钮），且**绝不出现**「未配置默认参数」；
 * ② `params` 非空 ⇒ 渲染参数 Tag（**正例控制组**：证明①不是因为「什么都不渲染」才绿的）；
 * ③ `params` 为空对象且**没有** `loadError` ⇒ 才落「未配置默认参数」（**真的没有**）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import ExecutionContextParams from '../components/ExecutionContextParams';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('R176：参数区读失败不得渲染成「未配置默认参数」', () => {
  it('① loadError ⇒ 出错误块 + 可点重试，且**没有**「未配置默认参数」', () => {
    const onRetry = vi.fn();
    render(
      <ExecutionContextParams
        params={undefined}
        loadError={new Error('boom')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/读取任务参数失败|Failed to load the task params/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // 关键反向断言：不得出现「真的没有参数」的结论
    expect(document.body.textContent).not.toMatch(/未配置默认参数|no default params/);
  });

  it('② 正例控制组：params 非空 ⇒ 渲染参数 Tag，且**没有**错误块', () => {
    render(
      <ExecutionContextParams params={{ foo: 'bar', n: 1 }} loadError={null} />,
    );
    expect(document.body.textContent).toContain('foo = bar');
    expect(screen.queryByText(/读取任务参数失败|Failed to load the task params/)).toBeNull();
  });

  it('③ params 为空对象且无 error ⇒ 落「未配置默认参数」（真的没有）', () => {
    render(<ExecutionContextParams params={{}} loadError={null} />);
    expect(document.body.textContent).toMatch(/未配置默认参数|no default params/);
    expect(screen.queryByText(/读取任务参数失败|Failed to load the task params/)).toBeNull();
  });
});
