/**
 * FEAT-02: DAG 布局纯函数层单测。
 * 数据契约：dependencies 值 = 上游依赖 taskId（对齐 admin-api
 * triggerDependentTasks 的 Object.values(...).includes(completedTaskId)）。
 */
import { describe, it, expect } from 'vitest';
import { buildDependencyGraph, type DagTaskRef } from '../components/dag-layout';

function task(id: string, name = id, status = 'active', deps?: Record<string, string>): DagTaskRef & { dependencies?: Record<string, string> } {
  return { id, name, status, ...(deps ? { dependencies: deps } : {}) };
}

describe('buildDependencyGraph (FEAT-02)', () => {
  it('returns null when the current task is not in the list', () => {
    expect(buildDependencyGraph([task('a')], 'missing')).toBeNull();
  });

  it('single task with no relations → empty graph (component shows the empty state)', () => {
    const g = buildDependencyGraph([task('a'), task('b')], 'a');
    expect(g).not.toBeNull();
    expect(g!.nodes).toHaveLength(1);
    expect(g!.nodes[0]).toMatchObject({ id: 'a', isCurrent: true, layer: 0 });
    expect(g!.edges).toHaveLength(0);
  });

  it('direct upstream: dependency value is the upstream taskId, edge points dep → dependent', () => {
    const tasks = [task('up', '上游'), task('cur', '当前', 'active', { d1: 'up' })];
    const g = buildDependencyGraph(tasks, 'cur')!;
    expect(g.edges).toEqual([{ from: 'up', to: 'cur' }]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['cur', 'up']);
    expect(g.nodes.find((n) => n.id === 'up')!.layer).toBe(0);
    expect(g.nodes.find((n) => n.id === 'cur')!.layer).toBe(1);
    expect(g.cycle).toBe(false);
  });

  it('transitive upstream closure: dep of dep is included with increasing layers', () => {
    const tasks = [
      task('root', 'r'),
      task('mid', 'm', 'active', { d: 'root' }),
      task('cur', 'c', 'active', { d: 'mid' }),
      task('unrelated', 'x', 'active', { d: 'root' }),
    ];
    const g = buildDependencyGraph(tasks, 'cur')!;
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['cur', 'mid', 'root']);
    // unrelated 也依赖 root，但不在 cur 的上游闭包/下游闭包内 → 不入图，
    // 其指向 root 的边被两端过滤
    expect(g.edges).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === 'root')!.layer).toBe(0);
    expect(g.nodes.find((n) => n.id === 'mid')!.layer).toBe(1);
    expect(g.nodes.find((n) => n.id === 'cur')!.layer).toBe(2);
  });

  it('downstream closure: tasks depending on current are pulled into the graph', () => {
    const tasks = [
      task('cur', 'c'),
      task('down', 'd', 'active', { d: 'cur' }),
      task('deep', 'dp', 'active', { d: 'down' }),
    ];
    const g = buildDependencyGraph(tasks, 'cur')!;
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['cur', 'deep', 'down']);
    expect(g.edges).toEqual([
      { from: 'cur', to: 'down' },
      { from: 'down', to: 'deep' },
    ]);
    expect(g.nodes.find((n) => n.id === 'deep')!.layer).toBe(2);
  });

  it('diamond: longest-path layering (join node sits below the deeper branch)', () => {
    const tasks = [
      task('a', 'a'),
      task('b1', 'b1', 'active', { d: 'a' }),
      task('b2', 'b2', 'active', { d: 'b1' }),
      task('c', 'c', 'active', { d1: 'a', d2: 'b2' }),
    ];
    const g = buildDependencyGraph(tasks, 'c')!;
    expect(g.nodes.find((n) => n.id === 'a')!.layer).toBe(0);
    expect(g.nodes.find((n) => n.id === 'b1')!.layer).toBe(1);
    expect(g.nodes.find((n) => n.id === 'b2')!.layer).toBe(2);
    // c 的最长路径是 a→b1→b2→c = 3 层（而非 a→c = 1）
    expect(g.nodes.find((n) => n.id === 'c')!.layer).toBe(3);
  });

  it('dependency cycle is flagged and degrades to a single flat layer', () => {
    const tasks = [
      task('x', 'x', 'active', { d: 'y' }),
      task('y', 'y', 'active', { d: 'x' }),
    ];
    const g = buildDependencyGraph(tasks, 'x')!;
    expect(g.cycle).toBe(true);
    expect(g.nodes.every((n) => n.layer === 0)).toBe(true);
  });

  it('unknown dependency ids and self-references are ignored', () => {
    const tasks = [task('cur', 'c', 'active', { ghost: 'nope', self: 'cur' })];
    const g = buildDependencyGraph(tasks, 'cur')!;
    expect(g.edges).toHaveLength(0);
    expect(g.nodes).toHaveLength(1);
  });

  it('caps the graph at maxNodes and flags truncation', () => {
    const tasks: ReturnType<typeof task>[] = [task('root', 'r')];
    for (let i = 0; i < 12; i++) {
      tasks.push(task(`n${i}`, `n${i}`, 'active', { d: i === 0 ? 'root' : `n${i - 1}` }));
    }
    const g = buildDependencyGraph(tasks, 'root', 5)!;
    expect(g.truncated).toBe(true);
    expect(g.nodes.length).toBeLessThanOrEqual(5);
  });

  it('marks exactly the current node as isCurrent', () => {
    const tasks = [task('cur', 'c'), task('up', 'u', 'active', { d: 'cur' })];
    const g = buildDependencyGraph(tasks, 'cur')!;
    expect(g.nodes.filter((n) => n.isCurrent).map((n) => n.id)).toEqual(['cur']);
  });
});
