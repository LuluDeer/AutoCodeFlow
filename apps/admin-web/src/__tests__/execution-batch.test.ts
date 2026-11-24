/**
 * 执行记录批量终止编排测试（后端无批量 kill 端点 → 客户端顺序编排）。
 *
 * 覆盖点：
 *  1) 全部成功：结果顺序与入参一致；进度回调逐条 (done, total)；
 *  2) 部分失败：失败项吸收 error，不中断后续；成功 / 失败逐项可报告（summarizeBatch）；
 *  3) 顺序编排：前一条未结束后一条不发出（无并发重叠）；
 *  4) 非 Error 抛出值兜底转字符串，不把原始对象塞进报告。
 */
import { describe, it, expect, vi } from 'vitest';
import { runBatchKill } from '../api/executionBatch';
import { summarizeBatch } from '../api/tasks';

const ROWS = [
  { taskId: 't1', execId: 'e1' },
  { taskId: 't2', execId: 'e2' },
  { taskId: 't3', execId: 'e3' },
];

describe('runBatchKill', () => {
  it('全部成功：结果顺序与入参一致，进度逐条回调', async () => {
    const progress: Array<[number, number]> = [];
    const kill = vi.fn(async () => {
      await Promise.resolve();
    });
    const results = await runBatchKill(ROWS, kill, (done, total) => progress.push([done, total]));

    expect(results.map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(summarizeBatch(results).succeeded).toBe(3);
  });

  it('部分失败：失败项吸收 error 不中断后续；成功/失败逐项可报告', async () => {
    const kill = vi.fn(async (_t: string, execId: string) => {
      if (execId === 'e2') throw new Error('busy');
    });
    const results = await runBatchKill(ROWS, kill);

    expect(results[0]).toEqual({ id: 'e1' });
    expect(results[1]).toEqual({ id: 'e2', error: 'busy' });
    expect(results[2]).toEqual({ id: 'e3' });

    const summary = summarizeBatch(results);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]).toEqual({ id: 'e2', error: 'busy' });
  });

  it('顺序编排：前一条未结束后一条不发出（无并发重叠）', async () => {
    const order: string[] = [];
    const kill = vi.fn(async (_t: string, execId: string) => {
      order.push(`start:${execId}`);
      if (execId === 'e2') await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${execId}`);
    });
    await runBatchKill(ROWS, kill);

    const e2Start = order.indexOf('start:e2');
    const e3Start = order.indexOf('start:e3');
    expect(order[e2Start + 1]).toBe('end:e2');
    expect(e3Start).toBeGreaterThan(e2Start);
  });

  it('非 Error 抛出值兜底转字符串，不塞原始对象进报告', async () => {
    const kill = vi.fn(async () => {
      throw 'raw-string-failure';
    });
    const results = await runBatchKill([ROWS[0]], kill);
    expect(results[0]).toEqual({ id: 'e1', error: 'raw-string-failure' });
  });
});
