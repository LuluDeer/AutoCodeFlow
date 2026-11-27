/**
 * 工作台拆分后的行为等价性钉子（form hook + 展示组件 + 页面组装）。
 * 验收级别：单测 / 内存替身（api/workbench 全 mock，不触网、不落真库）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
const GOAL = '每周汇总项目状态';

const okResult: PreviewPlanResult = {
  card: {
    title: '每周项目状态汇总',
    triggerText: '每周一上午生成状态报告',
    capabilityHints: ['读取项目列表', '生成报告摘要'],
    acceptanceText: '报告包含本周新增与阻塞项',
    budget: { maxTurns: 12 },
  },
  checks: [
    { field: 'goal', status: 'ok', message: '目标描述清晰' },
    { field: 'cadence', status: 'warn', message: '频率已设置' },
  ],
  eligible: true,
  cardHash: 'card-abc123',
  policyGeneration: 'aaaaaaaaaaaaaaaa',
};

const commitOk: CommitResult = {
  sopId: 'sop-0001',
  slug: 'workbench-card-abc1',
  status: 'draft',
  approvalStatus: 'submitted',
  policyGeneration: 'bbbbbbbbbbbbbbbb',
};

const detail = {
  sessionId: SESSION_ID,
  kind: 'sop_authoring',
  status: 'running',
  stepCount: 1,
  steps: [{ seq: 1, role: 'assistant', contentPreview: 'draft step' }],
  toolCallCount: 1,
  toolCalls: [],
  approvals: {},
  artifacts: [],
};

const button = (label: string): HTMLButtonElement =>
  screen.getByText(label).closest('button') as HTMLButtonElement;

async function preview() {
  render(<WorkbenchPage />);
  fireEvent.change(screen.getByPlaceholderText('例如：每周汇总项目状态并生成报告'), {
    target: { value: GOAL },
  });
  fireEvent.click(button('预览方案'));
  await screen.findByText(okResult.card.title);
}

async function submitCommit() {
  await preview();
  fireEvent.click(button('确认方案'));
  await screen.findByTestId('workbench-commit-success');
}

beforeEach(async () => {
  await setLanguage('zh');
  window.localStorage.clear();
  window.history.replaceState({}, '', '/workbench');
  vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult);
  vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
  vi.mocked(createWorkbenchSession).mockReset().mockResolvedValue({ sessionId: SESSION_ID, status: 'pending' });
  vi.mocked(getWorkbenchSession).mockReset().mockResolvedValue(detail as never);
  vi.mocked(listWorkbenchSessions).mockReset().mockResolvedValue({ items: [], total: 0 });
  useAuthStore.setState({ user: { id: 7, username: 'alice', role: 'user' } });
});

afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
  await setLanguage('zh');
});

describe('workbench split：拆分后行为逐字等价', () => {
  it('preview：表单入参 + 方案卡/检查标签由独立组件渲染', async () => {
    await preview();
    expect(vi.mocked(previewPlan)).toHaveBeenCalledWith({ goal: GOAL, cadence: 'daily' });
    // 检查项在一个 Tag 里由三个 span 拼成，用正文包含断言而非精确节点匹配。
    expect(document.body.textContent).toContain('目标描述清晰');
    expect(document.body.textContent).toContain('频率已设置');
    expect(screen.getByText('每周项目状态汇总')).toBeTruthy();
  });

  it('commit：回填 preview 锚点，提交结果与记录区独立渲染', async () => {
    await submitCommit();
    expect(vi.mocked(commitPlan)).toHaveBeenCalledWith({
      goal: GOAL,
      cadence: 'daily',
      expectedCardHash: okResult.cardHash,
      expectedPolicyGeneration: okResult.policyGeneration,
    });
    expect(screen.getByTestId('workbench-commit-success')).toBeTruthy();
    const record = screen.getByTestId('workbench-confirm-record');
    // 回带值优先：记录区展示的是 commit 的 generation，而非 preview 的。
    expect(record.getAttribute('data-generation')).toBe(commitOk.policyGeneration);
    expect(record.textContent).toContain('alice');
  });

  it('二次预览：清掉提交结果但不改既有确认记录（与拆分前一致）', async () => {
    await submitCommit();
    fireEvent.click(button('预览方案'));
    await waitFor(() => expect(screen.queryByTestId('workbench-commit-success')).toBeNull());
    expect(screen.getAllByTestId('workbench-confirm-record')).toHaveLength(1);
  });

  it('预览通过 sessionResetRef 清空上一轮会话 URL/localStorage', async () => {
    window.localStorage.setItem('workbench.sessionId', SESSION_ID);
    window.history.replaceState({}, '', `/workbench?session=${SESSION_ID}`);

    await preview();

    expect(window.localStorage.getItem('workbench.sessionId')).toBeNull();
    expect(new URL(window.location.href).searchParams.get('session')).toBeNull();
  });

  it('commit 失败：后端 detail 文案透传到方案卡内联 Alert', async () => {
    vi.mocked(commitPlan).mockRejectedValueOnce({ detail: '方案卡生成后能力策略已变更' });
    await preview();
    fireEvent.click(button('确认方案'));
    await screen.findByText(/方案卡生成后能力策略已变更/);
    expect(screen.queryByTestId('workbench-commit-success')).toBeNull();
  });

  it('USER 三态：submitted 不渲染 /sops 深链，显示已提交审阅', async () => {
    await submitCommit();
    expect(document.querySelector('a[href^="/sops"]')).toBeNull();
    expect(screen.getByTestId('workbench-submitted-for-review').textContent).toContain('已提交审阅');
  });
});
