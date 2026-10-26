/**
 * P3-②（审计）回归：调度延迟格式化 formatLatencyMs。
 *
 * 背景：Dashboard 调度延迟卡的 derived.avgTriggerLatencyMs 是**桶插值浮点**，
 * 此前经 formatDuration 的亚秒档原样输出 `${ms}ms`——实测出现
 * 「平均 6.716883116883117ms」（17 位小数糊在卡面上）。
 * 新增专用档位：<10ms 保留 1 位小数（整值不带尾零）、<1000ms 取整、
 * ≥1s 复用 formatDuration 人类可读档；非有限值/空值回落 '—'、负值 clamp 0。
 * 既有整型延迟（80/100/42ms）输出不变（dashboard-ui04 先例回归）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '../i18n';
import { formatLatencyMs } from '../utils/timeFormat';
import SchedulerLatencyCard from '../components/dashboard/SchedulerLatencyCard';
import type { SchedulerMetricsResponse } from '../api/metrics';

describe('formatLatencyMs 档位（P3-②）', () => {
  it('桶插值浮点：<10ms 保留 1 位小数，不再裸奔 17 位小数', () => {
    expect(formatLatencyMs(6.716883116883117)).toBe('6.7ms');
    expect(formatLatencyMs(0.42)).toBe('0.4ms');
    expect(formatLatencyMs(9.96)).toBe('10ms'); // 进位后整值不带尾零
  });

  it('整值 <10ms 不带尾零；10~999ms 取整', () => {
    expect(formatLatencyMs(3)).toBe('3ms');
    expect(formatLatencyMs(80)).toBe('80ms');
    expect(formatLatencyMs(100)).toBe('100ms');
    expect(formatLatencyMs(42)).toBe('42ms');
    expect(formatLatencyMs(876.5)).toBe('877ms');
  });

  it('≥1s 复用 formatDuration 人类可读档', () => {
    expect(formatLatencyMs(1234)).toBe('1.2秒');
    expect(formatLatencyMs(63000)).toBe('1分3秒');
  });

  it('边界与非有限值与 formatDuration 同口径', () => {
    expect(formatLatencyMs(0)).toBe('0ms');
    expect(formatLatencyMs(-5)).toBe('0ms');
    expect(formatLatencyMs(null)).toBe('—');
    expect(formatLatencyMs(undefined)).toBe('—');
    expect(formatLatencyMs(Number.NaN)).toBe('—');
    expect(formatLatencyMs(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('SchedulerLatencyCard 浮点延迟呈现（P3-②）', () => {
  const metrics = (avg: number, p99: number) =>
    ({
      counters: {
        triggerLatencyCount: 15,
        lastTriggerLatencyMs: 4.25,
      },
      derived: {
        avgTriggerLatencyMs: avg,
        p99TriggerLatencyMs: p99,
      },
    }) as unknown as SchedulerMetricsResponse;

  afterEach(cleanup);

  it('平均 6.716883…ms 渲染为 6.7ms', () => {
    render(<SchedulerLatencyCard metrics={metrics(6.716883116883117, 12.34)} />);
    expect(screen.getByText('6.7ms')).toBeTruthy();
    expect(screen.getByText('12ms')).toBeTruthy(); // 10~999ms 档取整
    expect(screen.getByText('4.3ms')).toBeTruthy();
    // 样本注记
    expect(screen.getByText(/样本 15 次/)).toBeTruthy();
  });

  it('无指标 → 三个占位符，不误导为 0', () => {
    render(<SchedulerLatencyCard metrics={undefined} />);
    expect(screen.getAllByText('—').length).toBe(3);
    expect(screen.getByText(/暂无定时触发样本/)).toBeTruthy();
  });
});
