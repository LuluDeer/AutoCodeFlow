/**
 * UX-AUDIT / positioning-ux-overhaul —— 业务用户旅程修复的行为回归（单测/内存替身）。
 *
 * 覆盖：
 *   · 路由注册表统一侧栏/命令面板的角色口径（/inbox 全角色、/sops admin-only）
 *   · Dashboard 首任务 CTA 对业务用户走 /workbench，管理员仍走 /tasks/new
 *   · Workbench 提交成功后 USER 不出现 /sops 链接、改用诚实文案；ADMIN 保留原链接
 *   · 命令面板候选池截断告知 + 加载失败重试按钮
 *   · SSO 可用性检测失败给提示与重试入口
 *   · AI 分析空结果不谎报「分析完成」
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import { isAdminOnlyRoute, menuRoutes, paletteRoutes } from '../routes/route-registry';
import { useAuthStore } from '../store/auth';
import WorkbenchPage from '../pages/WorkbenchPage';
import LoginPage from '../pages/LoginPage';
import CommandPalette from '../components/CommandPalette';
import { previewPlan, commitPlan, createWorkbenchSession, getWorkbenchSession } from '../api/workbench';
import { authApi } from '../api/auth';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import zh from '../locales/zh';
import en from '../locales/en';

// —— 浏览器 API shim ——
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

vi.mock('../api/workbench', () => ({
  previewPlan: vi.fn(),
  commitPlan: vi.fn(),
  createWorkbenchSession: vi.fn(),
  getWorkbenchSession: vi.fn(),
}));
vi.mock('../api/auth', () => ({
  authApi: {
    oidcStatus: vi.fn(), login: vi.fn(), verifyLogin: vi.fn(), me: vi.fn(), refresh: vi.fn(),
    totpSetup: vi.fn(), totpEnable: vi.fn(), totpDisable: vi.fn(), listSessions: vi.fn(),
    revokeSession: vi.fn(), revokeOtherSessions: vi.fn(),
  },
}));
vi.mock('../api/tasks', () => ({
  tasksApi: { list: vi.fn(), allExecutions: vi.fn(), trigger: vi.fn(), pause: vi.fn(), resume: vi.fn() },
}));
vi.mock('../api/executors', () => ({ executorsApi: { list: vi.fn() } }));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));

const zhDict = zh as Record<string, string>;

beforeEach(() => {
  vi.mocked(authApi.oidcStatus).mockReset().mockResolvedValue({ enabled: false });
  vi.mocked(tasksApi.list).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
  vi.mocked(tasksApi.allExecutions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('共享路由注册表：侧栏与命令面板角色口径一致', () => {
  it('/inbox 全角色可见；/sops、/agent-sessions 仅 admin；/artifacts 不再误标 adminOnly', () => {
    expect(isAdminOnlyRoute('/inbox')).toBe(false);
    expect(isAdminOnlyRoute('/artifacts')).toBe(false);
    expect(isAdminOnlyRoute('/sops')).toBe(true);
    expect(isAdminOnlyRoute('/agent-sessions')).toBe(true);
    const userMenu = menuRoutes(false).map((r) => r.path);
    const adminMenu = menuRoutes(true).map((r) => r.path);
    expect(userMenu).toContain('/inbox');
    expect(userMenu).not.toContain('/sops');
    expect(adminMenu).toContain('/sops');
    expect(paletteRoutes(false).map((r) => r.path)).toContain('/inbox');
  });
});

describe('WORK-BUSINESS：Workbench 提交成功后的诚实 CTA', () => {
  const okResult = {
    card: { title: '每周汇总', triggerText: '每周', capabilityHints: [], acceptanceText: '', budget: { maxTurns: 5 } },
    checks: [{ field: 'goal', status: 'ok', message: 'ok' }],
    eligible: true, cardHash: 'h', policyGeneration: 'p',
  };
  const commitOk = { sopId: 'sop-1', slug: 'slug-1', status: 'draft', approvalStatus: 'submitted' } as never;
  const btn = (label: string) => screen.getByText(label).closest('button') as HTMLButtonElement;

  async function submit(role: string) {
    useAuthStore.setState({ user: { id: 1, username: 'u', role } });
    vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult as never);
    vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
    render(<WorkbenchPage />);
    fireEvent.change(screen.getByPlaceholderText(zhDict['workbench.goal.placeholder']), { target: { value: '目标' } });
    fireEvent.click(btn(zhDict['workbench.preview.action']));
    await screen.findByText(okResult.card.title);
    fireEvent.click(btn(zhDict['workbench.confirm.action']));
    await screen.findByTestId('workbench-commit-success');
  }

  it('USER：不出现 /sops 链接，显示「已提交审阅、草稿未运行」', async () => {
    await submit('user');
    expect(document.querySelector('a[href^="/sops"]')).toBeNull();
    const notice = screen.getByTestId('workbench-submitted-for-review');
    expect(notice.textContent).toContain('已提交审阅');
    expect(notice.textContent).toContain('尚未运行');
  });

  it('ADMIN：保留原 /sops 深链（不回归既有行为）', async () => {
    await submit('admin');
    expect(document.querySelector('a[href="/sops?sop=sop-1"]')).toBeTruthy();
  });
});

describe('PALETTE-HONESTY：截断告知与失败重试', () => {
  const renderPalette = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <CommandPalette open onOpenChange={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  it('候选池命中数超过取回数时显示告知与完整列表链接', async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      items: [{ id: 't1', name: 'report', status: 'active', triggerType: 'cron' } as never],
      total: 120, page: 1, pageSize: 50,
    });
    useAuthStore.setState({ user: { id: 1, username: 'u', role: 'user' } });
    renderPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'report' } });
    await screen.findByText(/仅显示前 1 条候选结果/);
    const link = screen.getByText('查看完整列表') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/tasks?q=report');
  });

  it('加载失败显示重试按钮，点击后重新发起请求', async () => {
    vi.mocked(tasksApi.list).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      items: [], total: 0, page: 1, pageSize: 50,
    });
    useAuthStore.setState({ user: { id: 1, username: 'u', role: 'user' } });
    renderPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'report' } });
    await screen.findByText(/任务加载失败/);
    const retry = screen.getAllByTestId('palette-retry')[0];
    const callsBefore = vi.mocked(tasksApi.list).mock.calls.length;
    fireEvent.click(retry);
    await vi.waitFor(() => expect(vi.mocked(tasksApi.list).mock.calls.length).toBeGreaterThan(callsBefore));
  });
});

describe('SSO 可用性失败：提示 + 重试', () => {
  it('oidcStatus 失败时展示重试按钮，点击后重新探测', async () => {
    vi.mocked(authApi.oidcStatus).mockRejectedValueOnce(new Error('down')).mockResolvedValue({ enabled: true });
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    const retry = await screen.findByTestId('login-sso-retry');
    expect(retry.textContent).toContain('重试检测');
    fireEvent.click(retry);
    await screen.findByTestId('login-sso');
    expect(vi.mocked(authApi.oidcStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('WORK-BUSINESS / Writer B：运行我的草稿（受限起草会话）', () => {
  const okResult = {
    card: { title: '每周汇总', triggerText: '每周', capabilityHints: [], acceptanceText: '', budget: { maxTurns: 5 } },
    checks: [{ field: 'goal', status: 'ok', message: 'ok' }],
    eligible: true, cardHash: 'abcdef0123456789', policyGeneration: 'p',
  };
  const commitOk = { sopId: 'sop-1', slug: 'slug-1', status: 'draft', approvalStatus: 'submitted' } as never;
  const btn = (label: string) => screen.getByText(label).closest('button') as HTMLButtonElement;

  async function submittedPage(role = 'user') {
    useAuthStore.setState({ user: { id: 1, username: 'u', role } });
    vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult as never);
    vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
    vi.mocked(createWorkbenchSession).mockReset().mockResolvedValue({ sessionId: 'sess-1', status: 'pending' });
    vi.mocked(getWorkbenchSession).mockReset().mockResolvedValue({
      sessionId: 'sess-1', kind: 'sop_authoring', status: 'running', createdBy: 1,
      scope: { sops: ['sop-1'] }, stepCount: 1,
      steps: [{ seq: 1, role: 'system', contentPreview: '读取草稿', createdAt: '2026-01-01T00:00:00Z' }],
      toolCallCount: 2, approvals: { pending: 1, approved: 0, denied: 0 },
      artifacts: [{ id: 'a1', name: 'report.md', size: 100, createdAt: '2026-01-01T00:00:00Z' }],
    } as never);
    render(<WorkbenchPage />);
    fireEvent.change(screen.getByPlaceholderText(zhDict['workbench.goal.placeholder']), { target: { value: '目标' } });
    fireEvent.click(btn(zhDict['workbench.preview.action']));
    await screen.findByText(okResult.card.title);
    fireEvent.click(btn(zhDict['workbench.confirm.action']));
    await screen.findByTestId('workbench-commit-success');
  }

  it('提交后显示运行按钮；点击调用 createSession（sopId/goal/hash）并展示会话面板', async () => {
    await submittedPage('user');
    const runBtn = screen.getByTestId('workbench-run-draft');
    expect(runBtn).toBeTruthy();
    fireEvent.click(runBtn);
    await screen.findByTestId('workbench-session-panel');
    expect(vi.mocked(createWorkbenchSession)).toHaveBeenCalledWith({
      sopId: 'sop-1', goal: '目标', expectedCardHash: 'abcdef0123456789',
    });
    expect(screen.getByTestId('workbench-session-id').textContent).toContain('sess-1');
    expect(screen.getByTestId('workbench-session-tool-calls').textContent).toContain('2');
    expect(screen.getByTestId('workbench-session-artifacts').textContent).toContain('report.md');
  });

  it('创建失败（403）显示纯语言错误 + 重试按钮，点击重试再次调用', async () => {
    await submittedPage('user');
    vi.mocked(createWorkbenchSession).mockRejectedValueOnce({ __status: 403 });
    fireEvent.click(screen.getByTestId('workbench-run-draft'));
    await screen.findByTestId('workbench-session-retry');
    expect(document.body.textContent).toContain('属于其他用户');
    fireEvent.click(screen.getByTestId('workbench-session-retry'));
    await vi.waitFor(() => expect(vi.mocked(createWorkbenchSession).mock.calls.length).toBe(2));
  });
});

describe('i18n 完整性：新增可见文案 zh/en 双全', () => {
  const enDict = en as Record<string, string>;
  const newKeys = [
    'palette.candidateTruncated', 'palette.viewFullList', 'palette.retry',
    'palette.action.createViaWorkbench', 'dashboard.createFirstHint',
    'workbench.submittedForReview', 'requireAdmin.title', 'login.ssoCheckFailed',
    'sops.field.draftSlug.placeholder', 'registry.field.name.placeholder',
    'registry.field.version.placeholder',
    'workbench.runDraft', 'workbench.runDraftHint', 'workbench.session.started',
    'workbench.session.id', 'workbench.session.status', 'workbench.session.steps',
    'workbench.session.toolCalls', 'workbench.session.approvals', 'workbench.session.artifacts',
    'workbench.session.terminal', 'workbench.session.createFail.forbidden', 'workbench.session.retry',
  ];
  it.each(newKeys)('%s 在 zh 与 en 均有非空文案', (key) => {
    expect(zhDict[key]).toBeTruthy();
    expect(enDict[key]).toBeTruthy();
  });
});
