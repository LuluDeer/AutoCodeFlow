/**
 * 工作台会话面板明细：工具名/状态/错误、审批入口、产物下载入口。
 * 验收级别：单测 / 内存替身（直接喂视图对象，不触网）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { setLanguage } from '../i18n';
import WorkbenchSessionPanel, { type WorkbenchSessionView } from '../components/workbench/WorkbenchSessionPanel';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_KEY = `apr-${SESSION_ID}-abcdef0123456789`;
const DOWNLOAD_URL = '/api/tasks/executions/44444444-4444-4444-8444-444444444444/artifacts/report.md';

const session: WorkbenchSessionView = {
  sessionId: SESSION_ID,
  kind: 'sop_authoring',
  status: 'waiting_input',
  stepCount: 1,
  steps: [{ seq: 1, role: 'assistant', contentPreview: 'draft step' }],
  toolCallCount: 1,
  toolCalls: [{
    toolName: 'sop_get',
    status: 'error',
    errorSummary: 'target not found',
  }],
  approvals: { pending: 1 },
  approvalItems: [{
    approvalKey: APPROVAL_KEY,
    toolName: 'sop_publish',
    status: 'pending',
    reason: 'release gate',
    reviewUrl: `/agent-sessions?session=${SESSION_ID}&tab=approvals&approvalKey=${APPROVAL_KEY}`,
  }],
  artifacts: [{
    id: '33333333-3333-4333-8333-333333333333',
    name: 'report.md',
    size: 12,
    downloadUrl: DOWNLOAD_URL,
  }],
};

beforeEach(async () => {
  await setLanguage('zh');
});

afterEach(async () => {
  cleanup();
  await setLanguage('zh');
});

describe('workbench resume - panel details', () => {
  it('工具调用至少展示工具名/状态/错误摘要', () => {
    render(<WorkbenchSessionPanel session={session} />);

    const call = screen.getByTestId('workbench-session-tool-call');
    expect(call.textContent).toContain('sop_get');
    expect(call.textContent).toContain('error');
    expect(screen.getByTestId('workbench-session-tool-error').textContent).toBe('target not found');
  });

  it('审批项展示业务键与管理员入口，产物名可点击下载', () => {
    render(<WorkbenchSessionPanel session={session} />);

    const item = screen.getByTestId('workbench-session-approval-item');
    expect(item.textContent).toContain(APPROVAL_KEY);
    expect(screen.getByTestId('workbench-session-approval-link').getAttribute('href')).toContain(APPROVAL_KEY);
    const artifact = screen.getByTestId('workbench-session-artifact-link');
    expect(artifact.textContent).toContain('report.md');
    expect(artifact.getAttribute('href')).toBe(DOWNLOAD_URL);
  });

  it('普通用户没有审批处置入口时只展示状态，不伪造链接', () => {
    render(<WorkbenchSessionPanel session={{
      ...session,
      approvalItems: [{ ...session.approvalItems![0], reviewUrl: null }],
    }} />);

    expect(screen.queryByTestId('workbench-session-approval-link')).toBeNull();
    expect(screen.getByTestId('workbench-session-approval-item').textContent).toContain(APPROVAL_KEY);
  });
});
