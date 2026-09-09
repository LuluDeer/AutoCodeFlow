/**
 * CORE-02: 重试策略纯逻辑单测。
 *  - retry-policy.ts：retryableErrors 白名单提交序列化（trim/空集显式 null/
 *    未挂载归 null）+ 编辑态回填；
 *  - retry-chain.ts：兄弟执行行 → attempt 链拼装（连续档收集/间断截断/
 *    间隔计算/anchor 自身）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyRetryableErrorsPayload,
  retryableErrorsFormValues,
  RETRYABLE_ERROR_OPTIONS,
} from '../pages/retry-policy';
import {
  buildRetryChain,
  retryGapMs,
  nextPendingRetryAt,
} from '../pages/retry-chain';
import type { TaskExecution } from '../api/tasks';

describe('applyRetryableErrorsPayload（CORE-02 白名单提交序列化）', () => {
  it('逐条 trim 并丢弃空项', () => {
    const payload = applyRetryableErrorsPayload({
      retryableErrors: [' timeout ', '', 'executor_offline'],
    });
    expect(payload.retryableErrors).toEqual(['timeout', 'executor_offline']);
  });

  it('清空多选（空集）→ 显式 null（PATCH 缺省=保留旧值，必须发 null 才回到全量重试）', () => {
    const payload = applyRetryableErrorsPayload({ retryableErrors: [] });
    expect(payload.retryableErrors).toBeNull();
  });

  it('字段未挂载（undefined）→ 归 null', () => {
    expect(applyRetryableErrorsPayload({}).retryableErrors).toBeNull();
  });

  it('非字符串元素被丢弃', () => {
    const payload = applyRetryableErrorsPayload({
      retryableErrors: ['timeout', 42, null],
    });
    expect(payload.retryableErrors).toEqual(['timeout']);
  });

  it('保留其它字段不变', () => {
    const payload = applyRetryableErrorsPayload({
      name: 't',
      maxRetry: 5,
      retryableErrors: ['script_error'],
    });
    expect(payload.name).toBe('t');
    expect(payload.maxRetry).toBe(5);
    expect(payload.retryableErrors).toEqual(['script_error']);
  });

  it('选项覆盖全部可重试错误枚举（killed/stale_recovered 除外）', () => {
    const values = RETRYABLE_ERROR_OPTIONS.map((o) => o.value);
    expect(values).toContain('timeout');
    expect(values).toContain('executor_offline');
    expect(values).toContain('unknown');
    expect(values).not.toContain('killed');
    expect(values).not.toContain('stale_recovered');
  });
});

describe('retryableErrorsFormValues（编辑态回填）', () => {
  it('null/缺省 → 空数组占位（= 全部可重试）', () => {
    expect(retryableErrorsFormValues({ retryableErrors: null })).toEqual({ retryableErrors: [] });
    expect(retryableErrorsFormValues({})).toEqual({ retryableErrors: [] });
  });

  it('已有白名单原样回填，非字符串项被过滤', () => {
    expect(
      retryableErrorsFormValues({ retryableErrors: ['timeout', 'unknown'] }),
    ).toEqual({ retryableErrors: ['timeout', 'unknown'] });
    expect(
      retryableErrorsFormValues({ retryableErrors: ['timeout', 7] as unknown as string[] }),
    ).toEqual({ retryableErrors: ['timeout'] });
  });
});

// ---- retry-chain ----

let seq = 0;
function mkExec(overrides: Partial<TaskExecution> = {}): TaskExecution {
  seq += 1;
  return {
    id: `exec-${seq}`,
    taskId: 't1',
    taskName: 'demo',
    status: 'failed',
    triggerType: 'manual',
    retryCount: 0,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, seq)).toISOString(),
    ...overrides,
  } as TaskExecution;
}

describe('buildRetryChain（attempt 链拼装）', () => {
  it('anchor retryCount=0 且无兄弟 → 单元素链', () => {
    const a = mkExec({ id: 'a' });
    expect(buildRetryChain([a], { id: 'a', retryCount: 0 })).toHaveLength(1);
  });

  it('0→1→2 完整链：从中间 anchor（1）拼出完整三节', () => {
    const e0 = mkExec({ id: 'e0', retryCount: 0, status: 'failed', endTime: '2026-09-01T00:10:00Z' });
    const e1 = mkExec({ id: 'e1', retryCount: 1, status: 'failed', endTime: '2026-09-01T00:20:00Z' });
    const e2 = mkExec({ id: 'e2', retryCount: 2, status: 'success' });
    const chain = buildRetryChain([e2, e0, e1], { id: 'e1', retryCount: 1 });
    expect(chain.map((l) => l.execId)).toEqual(['e0', 'e1', 'e2']);
    expect(chain.map((l) => l.retryCount)).toEqual([0, 1, 2]);
  });

  it('后继档缺失（0 失败后直接 2）→ 间断处截断，不猜测补位', () => {
    const e0 = mkExec({ id: 'e0', retryCount: 0 });
    const e2 = mkExec({ id: 'e2', retryCount: 2 });
    // anchor=0：向下收集要求连续 → e2 跳档不纳入
    expect(buildRetryChain([e0, e2], { id: 'e0', retryCount: 0 }).map((l) => l.execId)).toEqual(['e0']);
    // anchor=2：向上连续收集到 1 断 → 只有自身
    expect(buildRetryChain([e0, e2], { id: 'e2', retryCount: 2 }).map((l) => l.execId)).toEqual(['e2']);
  });

  it('同档并发重复行取 createdAt 最早一行', () => {
    const e0a = mkExec({ id: 'e0a', retryCount: 0, createdAt: '2026-09-01T00:00:00Z' });
    const e0b = mkExec({ id: 'e0b', retryCount: 0, createdAt: '2026-09-01T01:00:00Z' });
    const e1 = mkExec({ id: 'e1', retryCount: 1 });
    const chain = buildRetryChain([e0b, e1, e0a], { id: 'e1', retryCount: 1 });
    expect(chain[0].execId).toBe('e0a');
  });

  it('anchor 不在 siblings 列表内时仍生成占位节（容错）', () => {
    const e0 = mkExec({ id: 'e0', retryCount: 0 });
    const chain = buildRetryChain([e0], { id: 'ghost', retryCount: 1 });
    expect(chain.map((l) => l.execId)).toEqual(['e0', 'ghost']);
    expect(chain[1].retryCount).toBe(1);
    // 占位节：无状态数据 → status 为 undefined（UI 按未知状态渲染）
    expect(chain[1].status).toBeUndefined();
  });

  it('链上无关的普通执行行（档位超出连续窗口）不进入链', () => {
    const e0 = mkExec({ id: 'e0', retryCount: 0 });
    const other = mkExec({ id: 'other', retryCount: 0 }); // 同任务普通执行
    const e1 = mkExec({ id: 'e1', retryCount: 1 });
    const chain = buildRetryChain([e0, other, e1], { id: 'e1', retryCount: 1 });
    expect(chain.map((l) => l.execId)).toEqual(['e0', 'e1']);
  });
});

describe('retryGapMs / nextPendingRetryAt', () => {
  it('间隔 = 下一行 startTime − 上一行 endTime', () => {
    expect(
      retryGapMs('2026-09-01T00:10:00Z', '2026-09-01T00:10:05Z'),
    ).toBe(5000);
  });

  it('缺端点或负间隔 → null（不可算，UI 显示 —）', () => {
    expect(retryGapMs(null, '2026-09-01T00:10:05Z')).toBeNull();
    expect(retryGapMs('2026-09-01T00:10:05Z', '2026-09-01T00:10:00Z')).toBeNull();
  });

  it('nextPendingRetryAt 命中链上首个 PENDING 行', () => {
    const chain = [
      { execId: 'a', retryCount: 0, status: 'failed' },
      { execId: 'b', retryCount: 1, status: 'pending' },
    ];
    expect(nextPendingRetryAt(chain as never)?.execId).toBe('b');
    expect(nextPendingRetryAt([{ execId: 'a', retryCount: 0, status: 'failed' }] as never)).toBeNull();
  });
});
