/**
 * D-设计审计 2026-09-22 分片A — 依赖 DAG 键盘可达回归。
 *
 * D-P2-05：真实实现已落在 DagCanvas；非当前节点是可聚焦 button，
 * Enter/Space 必须先 preventDefault 再触发与双击一致的 onNavigate('/tasks/:id')，
 * 当前节点退出 Tab 序列且不挂键盘导航，但仍可被指针选中。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import DagCanvas from '../components/task-dag/DagCanvas';
import type { DagGraph } from '../components/dag-layout';

const navigateMock = vi.fn();

const graph: DagGraph = {
  nodes: [
    { id: 'up', name: '上游任务', status: 'active', layer: 0, isCurrent: false },
    { id: 'cur', name: '当前任务', status: 'paused', layer: 1, isCurrent: true },
  ],
  edges: [{ from: 'up', to: 'cur' }],
  cycle: false,
  truncated: false,
};

const positions = new Map([
  ['up', { x: 16, y: 16, w: 160, h: 72 }],
  ['cur', { x: 240, y: 16, w: 160, h: 72 }],
]);

function renderGraph(taskId: string) {
  return render(
    <DagCanvas
      graph={graph}
      positions={positions}
      width={416}
      height={104}
      statusOf={() => undefined}
      statusLabel={() => 'active'}
      statusColor={() => '#22C55E'}
      currentTaskId={taskId}
      onNavigate={(id) => navigateMock(`/tasks/${id}`)}
    />,
  );
}

/** 捕获 document 气泡阶段的 defaultPrevented，证明 Space 不会滚页。 */
function keyDownAndAssertPrevented(nodeEl: HTMLElement, key: 'Enter' | ' ') {
  let prevented: boolean | undefined;
  const listener = (e: KeyboardEvent) => {
    if (e.key === key) prevented = e.defaultPrevented;
  };
  document.addEventListener('keydown', listener);
  fireEvent.keyDown(nodeEl, { key });
  document.removeEventListener('keydown', listener);
  expect(prevented, `${key} 未触发 keydown`).toBe(true);
}

beforeEach(() => navigateMock.mockClear());
afterEach(cleanup);

describe('D-P2-05: DAG 可点击节点键盘可达（DagCanvas）', () => {
  it('非当前节点是可聚焦的 button（tabIndex=0 + role=button）', () => {
    renderGraph('cur');
    const nodeEl = screen.getByTestId('dag-node-up');
    expect(nodeEl.getAttribute('role')).toBe('button');
    expect(nodeEl.getAttribute('tabIndex')).toBe('0');
  });

  it('在节点上按 Enter → preventDefault 后跳转到该任务', () => {
    renderGraph('cur');
    const nodeEl = screen.getByTestId('dag-node-up');
    keyDownAndAssertPrevented(nodeEl, 'Enter');
    expect(navigateMock).toHaveBeenCalledWith('/tasks/up');
  });

  it('在节点上按 Space → preventDefault 后跳转到该任务', () => {
    renderGraph('cur');
    const nodeEl = screen.getByTestId('dag-node-up');
    keyDownAndAssertPrevented(nodeEl, ' ');
    expect(navigateMock).toHaveBeenCalledWith('/tasks/up');
  });

  it('键盘导航与双击导航等价（同一 onNavigate 契约）', () => {
    renderGraph('cur');
    const nodeEl = screen.getByTestId('dag-node-up');
    keyDownAndAssertPrevented(nodeEl, 'Enter');
    expect(navigateMock).toHaveBeenCalledWith('/tasks/up');
    navigateMock.mockClear();
    fireEvent.doubleClick(nodeEl);
    expect(navigateMock).toHaveBeenCalledWith('/tasks/up');
  });

  it('当前节点不可聚焦（tabIndex=-1，role=undefined，不响应键盘）', () => {
    renderGraph('cur');
    const nodeEl = screen.getByTestId('dag-node-cur');
    expect(nodeEl.getAttribute('role')).toBeNull();
    expect(nodeEl.getAttribute('tabIndex')).toBe('-1');
    fireEvent.keyDown(nodeEl, { key: 'Enter' });
    fireEvent.keyDown(nodeEl, { key: ' ' });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('当前节点阴影为 tokens.ts 品牌绿（rgba(34,197,94,0.25)），非 antd 蓝', () => {
    renderGraph('cur');
    const nodeEl = screen.getByTestId('dag-node-cur');
    expect(nodeEl.style.boxShadow).toContain('rgba(34, 197, 94, 0.25)');
    expect(nodeEl.style.boxShadow).not.toContain('22, 119, 255');
  });
});
