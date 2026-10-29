/**
 * UI-08 巡查回归（admin-web 质量巡查 2026-10-25）：三个列表页首屏加载态。
 *
 * 缺陷现场（巡查发现）：ExecutorListPage / AgentSessionsPage / AppDeploymentPage
 * 是全站仅剩的三个「首屏无骨架」列表页——
 *  · ExecutorListPage：卡片视图（移动端强制形态）在数据未达时直接渲染
 *    Empty「无匹配执行器」；表格视图只有 antd 内建 spinner，无行骨架；
 *  · AgentSessionsPage：移动端卡片分支在数据未达时直接渲染 Empty；
 *  · AppDeploymentPage：列表区首帧无任何反馈（仅 Table 内建 spinner）。
 *
 * 修复形态（对齐 ApplicationListPage/SopsPage/TaskListPage 先例）：
 * 首载（无数据、未出错、加载中）以 PageSkeleton（data-testid="page-skeleton"）
 * 呈现；筛选无匹配空态 / 真空态 / StateError 语义不变。
 *
 * 先红后绿：三条用例在修复前失败（无骨架节点 / 出现空态误报），修复后通过。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorListPage from '../pages/ExecutorListPage';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { executorsApi } from '../api/executors';
import { agentApi } from '../api/agent';
import { deploymentsApi } from '../api/applications';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), picker: vi.fn() },
}));
vi.mock('../api/agent', () => ({
  agentApi: { list: vi.fn(), detail: vi.fn(), resume: vi.fn(), budget: vi.fn(), create: vi.fn(), listApprovals: vi.fn(), grantApproval: vi.fn(), denyApproval: vi.fn() },
  AGENT_SESSION_STATUSES: ['pending', 'running', 'waiting_input', 'succeeded', 'failed', 'aborted', 'budget_exceeded'],
}));
vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API（既有页面测试先例 shim）
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

/** 首屏挂起态：列表请求永不 resolve（停在 pending），页面必须呈现骨架。 */
function never(): Promise<never> {
  return new Promise(() => {});
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  // 预算行独立加载且失败静默，但 mock 必须返回 Promise（undefined.then 会崩）
  vi.mocked(agentApi.budget).mockResolvedValue(null as never);
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('autoflow-ui07-executor-view');
  vi.mocked(executorsApi.list).mockReset();
  vi.mocked(executorsApi.getGroups).mockReset();
  vi.mocked(executorsApi.picker).mockReset();
  vi.mocked(agentApi.list).mockReset();
  vi.mocked(deploymentsApi.list).mockReset();
});

describe('UI-08 首屏骨架：ExecutorListPage 卡片视图', () => {
  it('首载（数据未达）渲染骨架，而非 Empty「无匹配执行器」', async () => {
    vi.mocked(executorsApi.list).mockImplementation(never);
    vi.mocked(executorsApi.getGroups).mockResolvedValue([]);
    // 卡片视图（localStorage 记忆的桌面合法形态；移动端强制同款——两形态
    // 共用同一数据通路，此处以桌面 card 形态驱动）
    localStorage.setItem('autoflow-ui07-executor-view', 'card');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/executors']}>
          <Routes>
            <Route path="/executors" element={<ExecutorListPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 期望：首帧即有骨架节点（红点①：修复前无此节点）
    expect(screen.getByTestId('page-skeleton')).toBeTruthy();
    // 期望：数据未达时不渲染空态（红点②：修复前卡片分支 executors=[]
    // 直接落入 Empty「无匹配执行器」，把「加载中」误报成「没有数据」）
    expect(screen.queryByText('无匹配执行器')).toBeNull();
  });

  it('首载（数据未达）表格视图同样呈现行骨架', async () => {
    vi.mocked(executorsApi.list).mockImplementation(never);
    vi.mocked(executorsApi.getGroups).mockResolvedValue([]);
    localStorage.setItem('autoflow-ui07-executor-view', 'table');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/executors']}>
          <Routes>
            <Route path="/executors" element={<ExecutorListPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('page-skeleton')).toBeTruthy();
  });
});

describe('UI-08 首屏骨架：AgentSessionsPage', () => {
  it('首载（数据未达）渲染骨架而非空态', async () => {
    vi.mocked(agentApi.list).mockImplementation(never);
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentSessionsPage />
      </MemoryRouter>,
    );

    // 期望：首帧有骨架节点（红点：修复前无）
    expect(screen.getByTestId('page-skeleton')).toBeTruthy();
    // 期望：不误报空态（红点：修复前移动端卡片分支会，桌面靠 antd spinner）
    expect(screen.queryByText('暂无 Agent 会话')).toBeNull();
  });
});

describe('UI-08 首屏骨架：AppDeploymentPage', () => {
  it('首载（数据未达）渲染骨架而非空态', async () => {
    vi.mocked(deploymentsApi.list).mockImplementation(never);
    vi.mocked(executorsApi.picker).mockImplementation(never);
    // 页面以 props 接收 applicationId（真实挂载点是 ApplicationDetailPage 的
    // Tabs，非路由直挂），测试直接传 props 驱动
    render(<AppDeploymentPage applicationId="app-1" />);

    // 期望：列表区首帧有骨架节点（红点：修复前仅 Table 内建 spinner，
    // PageSkeleton 形态缺席，与全站其余列表页不一致）
    await waitFor(() => {
      expect(screen.getByTestId('page-skeleton')).toBeTruthy();
    });
    // 期望：数据未达时不渲染空态「该应用尚未部署」
    expect(screen.queryByText('该应用尚未部署')).toBeNull();
  });
});
