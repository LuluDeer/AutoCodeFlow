/**
 * OBS-04: 时间线映射纯函数测试——三端对齐契约（admin-api
 * execution-timeline.util / mcp-server buildExecutionTimeline 同语义），
 * 重点验证「时间线可视化与 DB 时间戳一致」的验收项。
 */
import { describe, expect, it } from 'vitest';
import {
  buildExecutionTimeline,
  TIMELINE_PHASE_LABEL,
} from '../utils/execution-timeline';

describe('buildExecutionTimeline (admin-web)', () => {
  it('maps created/started/finished preserving exact DB timestamps', () => {
    const tl = buildExecutionTimeline({
      status: 'success',
      triggerType: 'cron',
      executorAddress: 'http://executor-a:3001',
      createdAt: '2026-09-07T01:00:00.000Z',
      startTime: '2026-09-07T01:00:05.000Z',
      endTime: '2026-09-07T01:05:00.000Z',
    });
    expect(tl.map((t) => t.phase)).toEqual(['created', 'started', 'finished']);
    // ISO 串逐字符等于 DB 值——不做二次推算
    expect(tl[0].at).toBe('2026-09-07T01:00:00.000Z');
    expect(tl[1].at).toBe('2026-09-07T01:00:05.000Z');
    expect(tl[2].at).toBe('2026-09-07T01:05:00.000Z');
    expect(tl[0].detail).toBe('trigger=cron');
    expect(tl[1].detail).toBe('executor=http://executor-a:3001');
    expect(tl[2].detail).toBe('status=success');
  });

  it('degrades missing phases to null for a pending execution', () => {
    const tl = buildExecutionTimeline({
      status: 'pending',
      createdAt: '2026-09-07T08:00:00.000Z',
    });
    expect(tl[0].at).toBe('2026-09-07T08:00:00.000Z');
    expect(tl[1].at).toBeNull();
    expect(tl[2].at).toBeNull();
  });

  it('never throws on null/invalid timestamps (all phases null)', () => {
    const tl = buildExecutionTimeline({
      createdAt: null,
      startTime: 'garbage',
      endTime: undefined,
    });
    expect(tl).toHaveLength(3);
    expect(tl.every((t) => t.at === null)).toBe(true);
  });

  it('exposes phase labels covering the pending→running→terminal chain', () => {
    expect(TIMELINE_PHASE_LABEL.created).toContain('pending');
    expect(TIMELINE_PHASE_LABEL.started).toContain('running');
    expect(TIMELINE_PHASE_LABEL.finished).toContain('terminal');
  });
});
