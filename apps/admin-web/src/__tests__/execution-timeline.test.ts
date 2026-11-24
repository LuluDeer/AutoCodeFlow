/**
 * OBS-04: 时间线映射纯函数测试——三端对齐契约（admin-api
 * execution-timeline.util / mcp-server buildExecutionTimeline 同语义），
 * 重点验证「时间线可视化与 DB 时间戳一致」的验收项。
 */
import { describe, expect, it } from 'vitest';
import {
  buildExecutionTimeline,
  TIMELINE_PHASE_LABELS,
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
    // N-04：中文映射表已删，工厂缺省回落 i18n 单例（测试环境默认 zh），
    // 断言语义不变——标签仍覆盖 pending/running/terminal 三段链。
    const labels = TIMELINE_PHASE_LABELS();
    expect(labels.created).toContain('pending');
    expect(labels.started).toContain('running');
    expect(labels.finished).toContain('terminal');
  });

  // B3-②：阶段耗时派生——started=排队等待(startTime−createdAt)，
  // finished=运行耗时(endTime−startTime)；缺时刻/非法/回退一律 null。
  it('B3-②：派生排队等待与运行耗时（相邻 DB 时间戳差值）', () => {
    const tl = buildExecutionTimeline({
      status: 'success',
      createdAt: '2026-09-07T01:00:00.000Z',
      startTime: '2026-09-07T01:00:05.000Z',
      endTime: '2026-09-07T01:05:00.000Z',
    });
    expect(tl[0].durationMs).toBeUndefined();
    expect(tl[1].durationMs).toBe(5000);
    expect(tl[2].durationMs).toBe(295000);
  });

  it('B3-②：缺阶段时刻时该段耗时为 null，不猜数', () => {
    const tl = buildExecutionTimeline({
      status: 'running',
      createdAt: '2026-09-07T08:00:00.000Z',
      startTime: '2026-09-07T08:00:03.000Z',
    });
    expect(tl[1].durationMs).toBe(3000);
    expect(tl[2].durationMs).toBeNull();
  });

  it('B3-②：非法时间戳与时钟回退不产出负耗时/NaN', () => {
    const tl = buildExecutionTimeline({
      createdAt: 'garbage',
      startTime: '2026-09-07T08:00:03.000Z',
      endTime: '2026-09-07T07:59:00.000Z',
    });
    expect(tl[1].durationMs).toBeNull();
    expect(tl[2].durationMs).toBeNull();
  });
});
