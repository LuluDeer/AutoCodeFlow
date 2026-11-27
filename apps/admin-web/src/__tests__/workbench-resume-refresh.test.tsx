/**
 * 工作台刷新恢复：URL query/localStorage 优先恢复 + 「我的会话」兜底。
 * 验收级别：单测 / 内存替身（api/workbench 全 mock，不触网、不落真库）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { renderWorkbenchWithLegacy } from './workbench-legacy-helper';
import { setLanguage } from '../i18n';
import WorkbenchPage from '../pages/WorkbenchPage';
import {
  previewPlan,
  commitPlan,
  createWorkbenchSession,
  getWorkbenchSession,
  listWorkbenchSessions,
  type CommitResult,
  type PreviewPlanResult,
} from '../api/workbench';
import { useAuthStore } from '../store/auth';

vi.mock('../api/workbench', () => ({
  previewPlan: vi.fn(),
  commitPlan: vi.fn(),
  createWorkbenchSession: vi.fn(),
  getWorkbenchSession: vi.fn(),
  listWorkbenchSessions: vi.fn(),
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = '99999999-9999-4999-8999-999999999999';
const APPROVAL_KEY = `apr-${SESSION_ID}-abcdef0123456789`;

const okResult: PreviewPlanResult = {
  card: {
    title: 'weekly report',
    triggerText: 'every monday',
    capabilityHints: ['read projects'],
    acceptanceText: 'report contains blockers',
    budget: { maxTurns: 12 },
  },
  checks: [{ field: 'goal', status: 'ok', message: 'clear' }],
  eligible: true,
  cardHash: 'abcdef0123456789',
  policyGeneration: '0123456789abcdef',
};

const commitOk: CommitResult = {
  sopId: '11111111-1111-4111-8111-111111111111',
  slug: 'workbench-abcdef01',
  status: 'draft',
  approvalStatus: 'submitted',
};

const detail = {
  sessionId: SESSION_ID,
  kind: 'sop_authoring',
  status: 'running',
  stepCount: 1,
  steps: [{ seq: 1, role: 'assistant', contentPreview: 'draft step' }],
  toolCallCount: 1,
  toolCalls: [{ toolName: 'sop_get', status: 'error', errorSummary: 'target not found' }],
  approvals: { pending: 1 },
  approvalItems: [{
    approvalKey: APPROVAL_KEY,
    toolName: 'sop_publish',
    status: 'pending',
    reason: 'release gate',
  }],
  artifacts: [{
    id: '33333333-3333-4333-8333-333333333333',
    name: 'report.md',
    size: 12,
    downloadUrl: '/api/tasks/executions/44444444-4444-4444-8444-444444444444/artifacts/report.md',
  }],
};

function button(label: string): HTMLButtonElement {
  return screen.getByText(label).closest('button') as HTMLButtonElement;
}

async function submitCommit() {
  renderWorkbenchWithLegacy(<WorkbenchPage />);
  fireEvent.change(screen.getByPlaceholderText('例如：每周汇总项目状态并生成报告'), {
    target: { value: 'weekly report' },
  });
  fireEvent.click(button('预览方案'));
  await screen.findByText(okResult.card.title);
  fireEvent.click(button('确认方案'));
  await screen.findByTestId('workbench-commit-success');
}

beforeEach(async () => {
  await setLanguage('zh');
  window.localStorage.clear();
  window.history.replaceState({}, '', '/workbench');
  useAuthStore.setState({ user: { id: 42, username: 'alice', role: 'user' } });
  vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult);
  vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
  vi.mocked(createWorkbenchSession).mockReset().mockResolvedValue({
    sessionId: SESSION_ID,
    status: 'pending',
  });
  vi.mocked(getWorkbenchSession).mockReset().mockResolvedValue(detail as never);
  vi.mocked(listWorkbenchSessions).mockReset().mockResolvedValue({ items: [], total: 0 });
});

afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  await setLanguage('zh');
});

describe('workbench resume - refresh', () => {
  it('URL query 优先：即使 localStorage 指向别的会话也按 URL 重连', async () => {
    window.localStorage.setItem('workbench.sessionId', OTHER_SESSION_ID);
    window.history.replaceState({}, '', `/workbench?session=${SESSION_ID}`);

    renderWorkbenchWithLegacy(<WorkbenchPage />);

    await screen.findByTestId('workbench-session-panel');
    expect(getWorkbenchSession).toHaveBeenCalledWith(SESSION_ID);
    expect(getWorkbenchSession).not.toHaveBeenCalledWith(OTHER_SESSION_ID);
    expect(screen.getByTestId('workbench-session-id').textContent).toContain(SESSION_ID);
  });

  it('URL 丢失时从 localStorage 恢复会话面板', async () => {
    window.localStorage.setItem('workbench.sessionId', SESSION_ID);

    renderWorkbenchWithLegacy(<WorkbenchPage />);

    await screen.findByTestId('workbench-session-panel');
    expect(getWorkbenchSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('运行草稿后写入 URL query 与 localStorage，刷新前即可看到面板', async () => {
    await submitCommit();

    fireEvent.click(screen.getByTestId('workbench-run-draft'));

    await screen.findByTestId('workbench-session-panel');
    expect(createWorkbenchSession).toHaveBeenCalledWith({
      sopId: commitOk.sopId,
      goal: 'weekly report',
      expectedCardHash: okResult.cardHash,
    });
    // 产品改造：创建会话请求体不再带 kind；严格参数断言之外再显式锁死缺席。
    expect(vi.mocked(createWorkbenchSession).mock.calls[0][0]).not.toHaveProperty('kind');
    expect(new URL(window.location.href).searchParams.get('session')).toBe(SESSION_ID);
    expect(window.localStorage.getItem('workbench.sessionId')).toBe(SESSION_ID);
  });

  it('URL/localStorage 都丢时可从「我的会话」显式恢复', async () => {
    vi.mocked(listWorkbenchSessions).mockResolvedValue({
      items: [{
        sessionId: SESSION_ID,
        status: 'running',
        title: 'workbench draft',
        sopId: commitOk.sopId,
      }],
      total: 1,
    });

    renderWorkbenchWithLegacy(<WorkbenchPage />);

    const restore = await screen.findByTestId('workbench-session-restore');
    fireEvent.click(restore);

    await screen.findByTestId('workbench-session-panel');
    expect(getWorkbenchSession).toHaveBeenCalledWith(SESSION_ID);
    expect(new URL(window.location.href).searchParams.get('session')).toBe(SESSION_ID);
  });
});
