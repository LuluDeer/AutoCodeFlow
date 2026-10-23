/**
 * 失败原因聚合（2026-10-23）。
 *
 * 场景：一次批量故障里，运维想知道「这 30 条失败是不是同一个原因」——
 * 是全平台踩了同一个 sandbox_unavailable，还是几十个任务各自的脚本错误。
 * 此前只能一条条点进详情看 failureReason。
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateFailureReasons,
  UNKNOWN_REASON_BUCKET,
  FAILED_EXECUTION_STATUSES,
} from '../failure-reason-aggregate';

describe('aggregateFailureReasons', () => {
  it('按原因聚合并降序排列', () => {
    const rows = [
      { status: 'failed', failureReason: 'script_error' },
      { status: 'failed', failureReason: 'script_error' },
      { status: 'failed', failureReason: 'sandbox_unavailable' },
      { status: 'timeout', failureReason: 'timeout' },
    ];
    expect(aggregateFailureReasons(rows)).toEqual([
      { reason: 'script_error', count: 2 },
      { reason: 'sandbox_unavailable', count: 1 },
      { reason: 'timeout', count: 1 },
    ]);
  });

  it('同次数按原因名升序（稳定排序，避免每次渲染顺序抖动）', () => {
    const rows = [
      { status: 'failed', failureReason: 'zzz' },
      { status: 'failed', failureReason: 'aaa' },
    ];
    expect(aggregateFailureReasons(rows).map((b) => b.reason)).toEqual(['aaa', 'zzz']);
  });

  it('只统计失败类终态：success / running / pending 不计入', () => {
    const rows = [
      { status: 'success', failureReason: null },
      { status: 'running', failureReason: null },
      { status: 'pending', failureReason: null },
      { status: 'failed', failureReason: 'script_error' },
    ];
    const out = aggregateFailureReasons(rows);
    expect(out).toEqual([{ reason: 'script_error', count: 1 }]);
  });

  it('timeout / killed 都算失败（与后端失败语义一致）', () => {
    const rows = [
      { status: 'timeout', failureReason: 'timeout' },
      { status: 'killed', failureReason: 'killed' },
    ];
    expect(aggregateFailureReasons(rows).reduce((n, b) => n + b.count, 0)).toBe(2);
  });

  it('failureReason 为空的历史行归入 unknown（不丢，否则总数对不上）', () => {
    const rows = [
      { status: 'failed', failureReason: null },
      { status: 'failed', failureReason: '' },
      { status: 'failed', failureReason: '   ' },
      { status: 'failed', failureReason: 'script_error' },
    ];
    const out = aggregateFailureReasons(rows);
    const total = out.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(4);
    expect(out.find((b) => b.reason === UNKNOWN_REASON_BUCKET)?.count).toBe(3);
  });

  it('status 大小写不敏感（后端偶有大小写差异）', () => {
    expect(
      aggregateFailureReasons([{ status: 'FAILED', failureReason: 'script_error' }]),
    ).toHaveLength(1);
  });

  it('无失败行 → 空数组（调用方据此不渲染聚合条）', () => {
    expect(aggregateFailureReasons([{ status: 'success' }])).toEqual([]);
    expect(aggregateFailureReasons([])).toEqual([]);
  });

  it('导出常量与口径一致', () => {
    expect(FAILED_EXECUTION_STATUSES).toEqual(['failed', 'timeout', 'killed']);
  });
});
