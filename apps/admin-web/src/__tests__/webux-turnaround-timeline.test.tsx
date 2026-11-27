/**
 * WEBUX-TURNAROUND：审批卡在主时间线可见，并按 callId（非序号）展示批准后将执行的命令。
 * 验收级别：单测 / 内存替身（直接喂 detail，不触网）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { setLanguage } from '../i18n';
import WorkbenchTimeline from '../components/workbench/WorkbenchTimeline';
import type { WorkbenchSessionDetail } from '../pages/workbench/types-public';

const baseDetail: WorkbenchSessionDetail = {
  sessionId: 'session-1',
  kind: 'sop_authoring',
  status: 'waiting_input',
  steps: [],
  toolCalls: [],
  approvalItems: [],
  artifacts: [],
};

function renderTimeline(detail: WorkbenchSessionDetail) {
  return render(
    <WorkbenchTimeline
      detail={detail}
      live={false}
      actingKey={null}
      onDecide={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

beforeEach(async () => {
  await setLanguage('zh');
});

afterEach(async () => {
  cleanup();
  await setLanguage('zh');
});

describe('主时间线内联审批', () => {
  it('等待审批的卡片出现在主时间线内，而不是只在检查面板镜像里', () => {
    renderTimeline({
      ...baseDetail,
      approvalItems: [{
        approvalKey: 'apr-1',
        toolName: 'terminal_send',
        status: 'pending',
        canDecide: true,
      }],
    });
    const timeline = screen.getByTestId('workbench-timeline');
    const card = timeline.querySelector('[data-testid="workbench-approval-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent?.replace(/\s+/g, '')).toContain('批准');
    expect(card?.textContent?.replace(/\s+/g, '')).toContain('拒绝');
  });

  it('按 callId 关联 argsRaw：同名多次调用也不会取错命令', () => {
    renderTimeline({
      ...baseDetail,
      approvalItems: [{
        approvalKey: 'apr-2',
        toolName: 'terminal_send',
        status: 'pending',
        canDecide: true,
        callId: 'call-b',
      } as never],
      toolCalls: [
        { id: 'tc-a', toolName: 'terminal_send', status: 'ok', callId: 'call-a', argsRaw: '{"text":"first command"}' } as never,
        { id: 'tc-b', toolName: 'terminal_send', status: 'ok', callId: 'call-b', argsRaw: '{"text":"second command"}' } as never,
      ],
    });
    expect(screen.getByTestId('workbench-approval-command').textContent)
      .toContain('批准后将执行：second command');
    expect(screen.queryByText(/first command/)).toBeNull();
  });

  it('解析失败静默降级：不渲染占位垃圾，也不编造命令', () => {
    renderTimeline({
      ...baseDetail,
      approvalItems: [{
        approvalKey: 'apr-3',
        toolName: 'terminal_send',
        status: 'pending',
        canDecide: true,
        callId: 'missing-call',
      } as never],
      toolCalls: [{ id: 'tc-1', toolName: 'terminal_send', status: 'ok', callId: 'call-1', argsRaw: '{broken' } as never],
    });
    expect(screen.getByTestId('workbench-approval-card')).toBeTruthy();
    expect(screen.queryByTestId('workbench-approval-command')).toBeNull();
    expect(document.body.textContent).not.toContain('unknown command');
  });
});
