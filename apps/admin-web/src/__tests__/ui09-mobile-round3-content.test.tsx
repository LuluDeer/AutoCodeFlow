/**
 * UI-09 第三轮扩面：内容操作簇 4 页 375px 走查回归——
 *   AgentSessionsPage / SopsPage / TaskTemplatesPage / ProjectsPage。
 *
 * 断言口径对齐第二轮 ui09-mobile-pages.test.tsx：jsdom 无布局引擎，
 * 只断言「渲染产物」（表格↔卡片分支、内联样式宽度、aria 属性），
 * 不假装能断言像素；像素级验证由真实浏览器 375px 实测承担。
 *
 * 移动端判定桩：useIsMobile 走 window.matchMedia('(max-width: 768px)')，
 * mobile 模式下该查询命中、其余 antd 内部查询不命中——与真实浏览器
 * 375px 下的分支一致（round-2 的 stubMatchMedia 同思路）。
 *
 * a11y 断言：4 页内 icon-only 按钮显式 aria-label（antd Tooltip 不自动
 * 加 aria-label）；随文字出现的装饰图标 aria-hidden。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import SopsPage from '../pages/SopsPage';
import TaskTemplatesPage from '../pages/TaskTemplatesPage';
import ProjectsPage from '../pages/ProjectsPage';
import { agentApi } from '../api/agent';
import { sopsApi } from '../api/sops';
import { projectsApi, type ProjectViewRow } from '../api/projects';
import { usersApi } from '../api/users';
import { taskTemplatesApi, type TaskTemplate } from '../api/task-templates';
import type { AgentSession } from '../api/agent';
import type { Sop, SopAssignment, SopClarification } from '../api/sops';

import '../i18n';

// ── ProjectsPage 的主体 mock（对齐 projects-page.test 的可控主体口径）──
const authState: { user: { id: number; role?: string } | null } = { user: null };
vi.mock('../store/auth', () => ({
  isAdminUser: (u: { role?: string } | null | undefined) => u?.role === 'admin',
  useAuthStore: (sel: (s: unknown) => unknown) => sel(authState),
}));

vi.mock('../api/agent', () => ({
  agentApi: { list: vi.fn(), detail: vi.fn(), resume: vi.fn(), budget: vi.fn(), create: vi.fn() },
}));
vi.mock('../api/sops', () => ({
  sopsApi: {
    list: vi.fn(),
    get: vi.fn(),
    draft: vi.fn(),
    updateDraft: vi.fn(),
    publish: vi.fn(),
    assign: vi.fn(),
    versions: vi.fn(),
    assignments: vi.fn(),
    assignment: vi.fn(),
    replyClarification: vi.fn(),
    listAssignableExecutors: vi.fn(),
    assignmentMedia: vi.fn(),
    viewMedia: vi.fn(),
  },
}));
vi.mock('../api/projects', () => ({
  projectsApi: {
    list: vi.fn(),
    listPaged: vi.fn(),
    getMembers: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    listMyRoles: vi.fn(),
  },
}));
vi.mock('../api/users', () => ({
  usersApi: { list: vi.fn(), listAll: vi.fn() },
}));
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有页面测试先例）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// useIsMobile 的 matchMedia 桩：mobile 模式仅命中 (max-width: 768px)，
// desktop 模式全不命中（antd 内部断点查询不受影响）。
function stubMatchMedia(isMobile: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: isMobile && q.includes('max-width: 768px'),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage(node: React.ReactElement, path = '/') {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── 夹具（形状对齐各页既有测试，桌面分支继续消费同一批 mock）──
const sessionOf = (id: string, status: string): AgentSession => ({
  id,
  kind: 'incident',
  status,
  title: `session-${id}`,
  triggerSource: 'cron',
  parentSessionId: null,
  contextJson: {},
  scopeJson: {},
  budgetJson: null,
  resultJson: null,
  summary: null,
  errorMessage: null,
  totalSteps: 1,
  totalTokensIn: 1,
  totalTokensOut: 1,
  totalToolCalls: 0,
  waitingFor: null,
  startedAt: '2026-09-11T10:00:00Z',
  finishedAt: null,
  createdAt: '2026-09-11T10:00:00Z',
  updatedAt: '2026-09-11T10:00:00Z',
});

const sop: Sop = {
  id: 'sop-1',
  slug: 'demo-sop',
  title: '演示 SOP',
  status: 'published',
  currentVersion: '1.0.0',
  applicationId: null,
  frontMatterJson: {},
  bodyMarkdown: 'body',
  createdBy: 'tester',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
};

const sopAssignment: SopAssignment = {
  id: 'asg-1',
  sopId: 'sop-1',
  sopVersion: '1.0.0',
  targetExecutorId: 'exec-1',
  targetAgentSessionId: null,
  status: 'in_progress',
  clarificationRound: 1,
  maxRounds: 5,
  resultJson: null,
  parentSessionId: null,
  pulledAt: '2026-09-07T01:00:00Z',
  lastProgressAt: null,
  progressJson: null,
  attempt: 1,
  lastReplyDeliveredAt: null,
  capabilitySnapshotJson: null,
  permissionProfileAtPull: null,
  assignedBy: 'tester',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-07T02:00:00Z',
};

const sopClarification: SopClarification = {
  id: 'clr-1',
  clientClarificationId: null,
  assignmentId: 'asg-1',
  round: 1,
  question: '第 3 步弹窗点不动',
  questionContextJson: null,
  answer: null,
  resolution: null,
  newSopVersion: null,
  mediaRefsJson: null,
  reviewSessionId: null,
  createdAt: '2026-09-07T01:30:00Z',
  updatedAt: '2026-09-07T01:30:00Z',
};

function makeProject(overrides: Partial<ProjectViewRow> = {}): ProjectViewRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Default',
    description: '未分配资源的归属项目',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    myRole: null,
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    key: 'scheduled_backup',
    name: '定时备份',
    description: '周期性备份任务：Cron 定时触发（默认每天 02:00）。',
    category: '备份',
    config: {
      triggerType: 'cron',
      cronExpression: '0 2 * * *',
      runtime: 'shell',
      entrypoint: 'backup.sh',
      timeoutSeconds: 3600,
      maxRetry: 3,
    },
    isOfficial: true,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  stubMatchMedia(true);
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({
    items: [sessionOf('s-run', 'running')],
    total: 1,
  });
  vi.mocked(agentApi.detail).mockReset().mockImplementation(async (id: string) => ({
    session: sessionOf(id, 'running'),
    steps: [],
    toolCalls: [],
    children: [],
  }));
  vi.mocked(agentApi.budget).mockReset().mockResolvedValue({
    maxSteps: 40,
    maxTokens: 1000,
    wallClockMs: 60000,
    maxToolCalls: 20,
  });
  vi.mocked(sopsApi.list).mockReset().mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.assignments).mockReset().mockResolvedValue([sopAssignment]);
  vi.mocked(sopsApi.assignment).mockReset().mockResolvedValue({
    assignment: sopAssignment,
    clarifications: [sopClarification],
  });
  vi.mocked(sopsApi.assignmentMedia).mockReset().mockResolvedValue([]);
  vi.mocked(projectsApi.listPaged).mockReset().mockResolvedValue({
    list: [
      makeProject(),
      makeProject({
        id: 'aaaa0000-0000-4000-8000-000000000002',
        name: 'Alpha',
        description: null,
        myRole: 'editor',
      }),
    ],
    items: [],
    total: 2,
    page: 1,
    pageSize: 20,
    totalPages: 1,
  });
  vi.mocked(projectsApi.getMembers).mockReset().mockResolvedValue([
    {
      id: 'm1',
      projectId: '00000000-0000-0000-0000-000000000001',
      userId: 7,
      role: 'editor',
      createdAt: '2026-09-02T00:00:00.000Z',
    },
  ]);
  vi.mocked(usersApi.listAll).mockReset().mockResolvedValue([
    { id: 7, username: 'alice', email: 'a@x', role: 'user', createdAt: '', updatedAt: '' },
  ]);
  vi.mocked(taskTemplatesApi.list).mockReset().mockResolvedValue([
    makeTemplate(),
    makeTemplate({
      id: '99999999-8888-4777-8666-333333333333',
      key: 'my-tpl',
      name: '我的自定义模板',
      description: null,
      category: null,
      isOfficial: false,
      config: { triggerType: 'manual', runtime: 'python', entrypoint: 'main.py' },
    }),
  ] as never);
  authState.user = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ───────────────────────── AgentSessionsPage ─────────────────────────
describe('UI-09 R3 AgentSessionsPage 375px 产物', () => {
  it('移动端：6 列表格降级为卡片列表（状态+标题/类型+触发/用量/开始时间/操作）', async () => {
    renderPage(<AgentSessionsPage />, '/agent-sessions');
    expect(await screen.findByText('session-s-run')).toBeTruthy();
    // 表格已消失，卡片承载同一行数据
    expect(document.querySelector('.ant-table')).toBeNull();
    const cards = document.querySelectorAll('.ant-card');
    expect(cards.length).toBe(1);
    const card = cards[0] as HTMLElement;
    expect(card.textContent).toContain('运行中');
    expect(card.textContent).toContain('事件处置');
    expect(card.textContent).toContain('1 步 · 2 令牌 · 0 工具调用');
    // 操作入口保留（原「详情」按钮）
    expect(screen.getByRole('button', { name: /详/ })).toBeTruthy();
  });

  it('移动端：筛选栏脱离页头纵向堆叠，Select 占满整行（不再固定 160px）', async () => {
    renderPage(<AgentSessionsPage />, '/agent-sessions');
    await screen.findByText('session-s-run');
    const selects = document.querySelectorAll('.ant-select');
    expect(selects.length).toBe(2);
    selects.forEach((s) => {
      expect((s as HTMLElement).style.width).toBe('100%');
    });
    // 刷新入口在筛选栏内可达；预算行随堆叠呈现
    expect(screen.getByRole('button', { name: /刷新/ })).toBeTruthy();
    expect(screen.getByText(/预算：/)).toBeTruthy();
  });

  it('移动端：会话详情抽屉满宽（width=100%，原 920px 固定宽在 375px 溢出）', async () => {
    renderPage(<AgentSessionsPage />, '/agent-sessions');
    fireEvent.click((await screen.findAllByRole('button', { name: /详/ }))[0]);
    await screen.findByText('上下文与结论');
    const wrapper = document.querySelector('.ant-drawer-content-wrapper') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.width).toBe('100%');
  });

  it('a11y：随文字的刷新图标纯装饰（aria-hidden）', async () => {
    renderPage(<AgentSessionsPage />, '/agent-sessions');
    await screen.findByText('session-s-run');
    const reload = document.querySelector('.anticon-reload') as HTMLElement | null;
    expect(reload).not.toBeNull();
    expect(reload!.getAttribute('aria-hidden')).toBe('true');
  });

  it('桌面端回归：表格保留、页头内筛选 Select 恢复 160px 固定宽', async () => {
    stubMatchMedia(false);
    renderPage(<AgentSessionsPage />, '/agent-sessions');
    expect(await screen.findByText('session-s-run')).toBeTruthy();
    expect(document.querySelector('.ant-table')).not.toBeNull();
    expect(document.querySelectorAll('.ant-card').length).toBe(0);
    // 只断言页头内的两个筛选 Select（桌面表格的分页 size-changer 也是
    // .ant-select 但无内联宽度，须从作用域剔除）
    const header = document.querySelector('[data-testid="page-header"]') as HTMLElement;
    const headerSelects = header.querySelectorAll('.ant-select');
    expect(headerSelects.length).toBe(2);
    headerSelects.forEach((s) => {
      expect((s as HTMLElement).style.width).toBe('160px');
    });
  });
});

// ───────────────────────────── SopsPage ─────────────────────────────
describe('UI-09 R3 SopsPage 375px 产物', () => {
  it('移动端：6 列表格降级为卡片列表（slug+状态/标题/版本与更新时间/操作）', async () => {
    renderPage(<SopsPage />);
    expect(await screen.findByText('demo-sop')).toBeTruthy();
    expect(document.querySelector('.ant-table')).toBeNull();
    const cards = document.querySelectorAll('.ant-card');
    expect(cards.length).toBe(1);
    const card = cards[0] as HTMLElement;
    // sops.statusTag 沿用既有原始 token 渲染（R3-F 只治理了 AgentSessions 裸枚举，
    // sops 状态词条不在本轮范围）——锚定现状，避免误改语义
    expect(card.textContent).toContain('published');
    expect(card.textContent).toContain('演示 SOP');
    expect(card.textContent).toContain('1.0.0');
  });

  it('移动端：真空态给「暂无 SOP」提示（新增 sops.empty 词条）', async () => {
    vi.mocked(sopsApi.list).mockResolvedValue({ items: [], total: 0 });
    renderPage(<SopsPage />);
    expect(await screen.findByText('暂无 SOP')).toBeTruthy();
  });

  it('移动端：详情抽屉满宽（width=100%，原 860px 固定宽在 375px 溢出）', async () => {
    renderPage(<SopsPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /详/ }))[0]);
    await screen.findByText('demo-sop 1.0.0');
    const wrapper = await waitFor(() => {
      const el = document.querySelector('.ant-drawer-content-wrapper') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(wrapper.style.width).toBe('100%');
  });

  it('a11y：随文字的刷新图标纯装饰（aria-hidden）', async () => {
    renderPage(<SopsPage />);
    await screen.findByText('demo-sop');
    const reload = document.querySelector('.anticon-reload') as HTMLElement | null;
    expect(reload).not.toBeNull();
    expect(reload!.getAttribute('aria-hidden')).toBe('true');
  });

  it('桌面端回归：表格保留', async () => {
    stubMatchMedia(false);
    renderPage(<SopsPage />);
    expect(await screen.findByText('demo-sop')).toBeTruthy();
    expect(document.querySelector('.ant-table')).not.toBeNull();
    expect(document.querySelectorAll('.ant-card').length).toBe(0);
  });
});

// ────────────────────────── TaskTemplatesPage ──────────────────────────
describe('UI-09 R3 TaskTemplatesPage 375px 产物', () => {
  it('a11y：icon-only 删除按钮显式 aria-label（不再依赖图标 aria-label="delete"）', async () => {
    renderPage(<TaskTemplatesPage />);
    expect(await screen.findByText('定时备份')).toBeTruthy();
    // 官方模板无删除入口；自定义模板的删除按钮可访问名为「删除模板」
    const delButtons = screen.getAllByRole('button', { name: '删除模板' });
    expect(delButtons.length).toBe(1);
    expect(delButtons[0].getAttribute('aria-label')).toBe('删除模板');
  });

  it('a11y：卡片上的装饰图标对读屏器隐藏', async () => {
    renderPage(<TaskTemplatesPage />);
    expect(await screen.findByText('定时备份')).toBeTruthy();
    (['.anticon-file-text', '.anticon-api', '.anticon-code', '.anticon-field-time'] as const).forEach(
      (sel) => {
        const icon = document.querySelector(sel) as HTMLElement | null;
        expect(icon).not.toBeNull();
        expect(icon!.getAttribute('aria-hidden')).toBe('true');
      },
    );
  });

  it('移动端：卡片栅格降为单列承载面（antd Col xs=24），卡片照常渲染', async () => {
    renderPage(<TaskTemplatesPage />);
    expect(await screen.findByText('我的自定义模板')).toBeTruthy();
    // 本页无表格/抽屉：栅格本身已响应式（xs=24 → 375px 单列），断言卡片产物在位
    expect(document.querySelectorAll('.ant-card').length).toBe(2);
    expect(screen.getAllByRole('button', { name: /使用此模板/ }).length).toBe(2);
  });
});

// ─────────────────────────── ProjectsPage ───────────────────────────
describe('UI-09 R3 ProjectsPage 375px 产物', () => {
  it('移动端：5 列表格降级为卡片列表（名称+我的角色/描述/创建时间/成员入口）', async () => {
    renderPage(<ProjectsPage />, '/projects');
    expect(await screen.findByText('Default')).toBeTruthy();
    expect(document.querySelector('.ant-table')).toBeNull();
    const cards = document.querySelectorAll('.ant-card');
    expect(cards.length).toBe(2);
    expect(screen.getByText('编辑者')).toBeTruthy();
    // 服务端分页在移动端保留（small 尺寸分页器）
    expect(document.querySelector('.ant-pagination')).not.toBeNull();
  });

  it('移动端：成员抽屉满宽（原 size=large 的 736px 在 375px 溢出）', async () => {
    renderPage(<ProjectsPage />, '/projects');
    fireEvent.click((await screen.findAllByRole('button', { name: /成员/ }))[0]);
    await screen.findByText('7');
    const wrapper = document.querySelector('.ant-drawer-content-wrapper') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.width).toBe('100%');
  });

  it('a11y：随文字的成员/移除/添加图标纯装饰（aria-hidden）', async () => {
    authState.user = { id: 1, role: 'admin' };
    renderPage(<ProjectsPage />, '/projects');
    fireEvent.click((await screen.findAllByRole('button', { name: /成员/ }))[0]);
    await screen.findByText('7');
    const team = document.querySelector('.anticon-team') as HTMLElement | null;
    expect(team).not.toBeNull();
    expect(team!.getAttribute('aria-hidden')).toBe('true');
    const del = document.querySelector('.anticon-delete') as HTMLElement | null;
    expect(del).not.toBeNull();
    expect(del!.getAttribute('aria-hidden')).toBe('true');
    const add = document.querySelector('.anticon-user-add') as HTMLElement | null;
    expect(add).not.toBeNull();
    expect(add!.getAttribute('aria-hidden')).toBe('true');
  });

  it('桌面端回归：表格保留（scroll.x 880 兜底），成员抽屉恢复 736px', async () => {
    stubMatchMedia(false);
    renderPage(<ProjectsPage />, '/projects');
    expect(await screen.findByText('Default')).toBeTruthy();
    const table = document.querySelector('.ant-table table') as HTMLElement | null;
    expect(table).not.toBeNull();
    expect(Number.parseFloat(table!.style.width)).toBe(880);
    fireEvent.click((await screen.findAllByRole('button', { name: /成员/ }))[0]);
    await screen.findByText('7');
    const wrapper = document.querySelector('.ant-drawer-content-wrapper') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(Number.parseFloat(wrapper!.style.width)).toBe(736);
  });
});
