/**
 * P1-3 / P2-1（UX-AUDIT-2026-09-21）：触发预览的两条打磨回归。
 *
 * ## P1-3：cron 预览在「时区未指定」时必须降级为警示，而不是自信渲染时刻
 *
 * 旧实现的错（证据）：
 *   - utils/trigger-preview.ts 在 tz 为空时用**浏览器本地时区**推算
 *     （`offsetMinutes` 的 `if (!tz) return -getTimezoneOffset()`）；
 *   - 而后端 scheduler.service 在 tz 为空时用**服务端进程时区**；
 *   - 组件把浏览器本地时区标成「服务器默认时区（浏览器本地）」并照常渲染
 *     5 个时刻。
 * 后果：UTC 笔记本给 Asia/Shanghai 服务器配 `0 8 * * *`，预览显示「08:00」，
 * 实际触发差 8 小时——且错在"用户以为对上了"的方向（最危险的一类错误）。
 *
 * 修法：tz 未解析时，组件改显「由服务端时区决定，可能不准」的警示 Alert，
 * **不再**渲染可信任的时刻 Tag。纯函数 `previewNeedsTimezoneWarning` 是这条
 * 决策的可测入口。
 *
 * ## P2-1：空输入不再显示假的 Spin 加载态
 *
 * 旧实现的错：cron 输入为空时（times=[] 且非 invalid）走 else 分支，渲染
 * `<Spin/>` + "等待输入…"。空输入不是"加载中"，转圈是纯假象。修法：去掉 Spin。
 */
import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '../i18n';
import TriggerPreview, { TRIGGER_PREVIEW_TESTID } from '../components/task-form/TriggerPreview';
import { previewNeedsTimezoneWarning } from '../utils/trigger-preview';

describe('P1-3: previewNeedsTimezoneWarning（时区未解析即须降级警示）', () => {
  it('空串 / undefined / 非法 IANA 都判为"需要警示"（与后端服务端时区不可比）', () => {
    expect(previewNeedsTimezoneWarning('')).toBe(true);
    expect(previewNeedsTimezoneWarning(undefined)).toBe(true);
    expect(previewNeedsTimezoneWarning(null)).toBe(true);
    expect(previewNeedsTimezoneWarning('Not/AZone')).toBe(true);
  });

  it('合法 IANA 时区不警示（此时浏览器渲染即调度器使用的时区）', () => {
    expect(previewNeedsTimezoneWarning('Asia/Shanghai')).toBe(false);
    expect(previewNeedsTimezoneWarning('UTC')).toBe(false);
  });
});

describe('P1-3: TriggerPreview 渲染——时区未解析时不自信渲染时刻', () => {
  it('有效 cron + 空时区：显示警示，且不渲染可信任的时刻 Tag', () => {
    render(
      <TriggerPreview
        triggerType="cron"
        cronExpression="0 8 * * *"
        timezone=""
        now={new Date('2026-09-21T00:00:00Z')}
      />,
    );
    // 警示文案出现（旧实现只有时刻 Tag、没有这条警示）
    expect(screen.getByText(/服务端进程时区/)).toBeTruthy();
    // 旧实现会把未来 5 次时刻渲染成等宽 Tag；新实现一个时刻 Tag 都不给。
    expect(screen.queryByTestId(TRIGGER_PREVIEW_TESTID)).toBeTruthy();
    // 时刻 Tag 形如 "09/21 08:00:00"——不应出现
    expect(screen.queryByText(/\d{2}:\d{2}:\d{2}/)).toBeNull();
  });

  it('有效 cron + 合法时区：正常渲染时刻 Tag（不因警示逻辑误伤正常预览）', () => {
    render(
      <TriggerPreview
        triggerType="cron"
        cronExpression="0 8 * * *"
        timezone="Asia/Shanghai"
        now={new Date('2026-09-21T00:00:00Z')}
      />,
    );
    // Asia/Shanghai 08:00 = UTC 00:00，5 个时刻 Tag 都渲染出 08:00:00
    expect(screen.getAllByText(/08:00:00/).length).toBeGreaterThan(0);
    // 不应出现"未指定时区"警示
    expect(screen.queryByText(/未指定时区/)).toBeNull();
  });
});

describe('P2-1: TriggerPreview 空输入不再显示假 Spin', () => {
  it('cron 为空：显示"等待输入…"，且不渲染任何 Spin', () => {
    render(
      <TriggerPreview
        triggerType="cron"
        cronExpression=""
        timezone="UTC"
        now={new Date('2026-09-21T00:00:00Z')}
      />,
    );
    expect(screen.getByText(/等待输入/)).toBeTruthy();
    // 旧实现这里有一个 <Spin/>（aria 属性 .ant-spin）；新实现移除。
    expect(document.querySelector('.ant-spin')).toBeNull();
    cleanup();
  });
});
