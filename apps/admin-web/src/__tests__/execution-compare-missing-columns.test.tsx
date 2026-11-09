/**
 * R190（P3-6）· 执行对比：**选中的执行没取到数据**时，不得渲染「整整一列全 `-`」。
 *
 * ## 病（R188 复核**纠正了 R169 的机制描述**）
 *
 * R169 说「只剩一列」；R188 实测实际是「**多出一整列全 `-`**」，机制是：
 * `cols` 按 `compareIds` 展开，而 `exec` 要从 `selectedExecutions` 里 `find`。
 * `compareIds` 由页面透传自**活的选中集**（antd 受控 `selectedRowKeys`，**不会**因数据变化
 * 被 prune），而 `executions` 会**刷新** ⇒ 两者不同步（选中后列表刷新把某条顶掉、
 * 或换了筛选条件）⇒ `exec?.xxx` 全 `undefined` ⇒ **该列每格都是 `-`**。
 *
 * ## 为什么这比「缺一列」更糟
 *
 * `-` 在这张表里通常读作「**这条执行该项没有值**」，而真相是「**我们没取到这条执行**」——
 * **同一个符号两个相反语义**。用户会得出「这条执行什么都没记下来」的错误结论。
 *
 * ## 判据（三条）
 *
 * ① **不为缺失的执行渲染列**（杜绝全 `-` 列）；
 * ② **也不静默丢弃**：缺了几条要**显式告知**（否则用户以为「只对比了 3 条」而其实选了 5 条）；
 * ③ **正例控制组**：全部都能取到时**不出现**告警，且列数 = 选中数
 *    （证明①不是因为「什么都不渲染」才绿的）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { ExecutionCompareModal } from '../components/ExecutionCompare';

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有先例）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** 最小执行行（只填对比面板会读到的字段）。 */
const exec = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'success',
  triggerType: 'manual',
  taskVersion: 'v1',
  retryCount: 0,
  startTime: '2026-11-08T00:00:00.000Z',
  endTime: '2026-11-08T00:01:00.000Z',
  duration: 60000,
  params: {},
  exitCode: 0,
  failureReason: null,
  errorMessage: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

const renderModal = (executions: unknown[], compareIds: string[]) =>
  render(
    <ExecutionCompareModal
      open
      onClose={() => {}}
      executions={executions as never}
      compareIds={compareIds}
    />,
  );

describe('R190（P3-6）· 执行对比：没取到数据的选中项不得渲染成全 `-` 列', () => {
  it('① 选中的执行里有 1 条不在当前列表 ⇒ **不**为它渲染列（不出现全 `-` 列）', () => {
    // 选了 3 条，但列表里只剩 2 条（第 3 条被刷新顶掉）
    renderModal([exec('e1'), exec('e2')], ['e1', 'e2', 'e3']);

    // 表头只应有 2 个执行列（+ 1 个指标列）；缺失的 e3 **不得**成列。
    // 判据：e3 的 id 前 8 位不应作为**列标题**出现。
    expect(document.body.textContent).not.toContain('e3');
  });

  it('② 缺了几条必须**显式告知**（不静默丢弃）', () => {
    renderModal([exec('e1'), exec('e2')], ['e1', 'e2', 'e3']);
    // 告警文案形如「有 1/3 个已选执行的数据未取到」
    expect(document.body.textContent).toMatch(/1\/3|1 \/ 3/);
    expect(document.body.textContent).toMatch(/未参与本次对比|excluded from this comparison/);
  });

  it('③ 正例控制组：全部都能取到 ⇒ 无告警，且 3 列都在', () => {
    renderModal([exec('e1'), exec('e2'), exec('e3')], ['e1', 'e2', 'e3']);
    // 无缺失告警
    expect(document.body.textContent).not.toMatch(/未参与本次对比|excluded from this comparison/);
    // 三列都能看到各自的 id 前缀（列标题用 id 前 8 位 fallback 或时间）
    const cells = document.querySelectorAll('thead th');
    // 指标列 1 + 执行列 3
    expect(cells.length).toBe(4);
  });
});
