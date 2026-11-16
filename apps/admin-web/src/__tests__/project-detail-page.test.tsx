/**
 * P1-2：ProjectDetailPage 渲染回归。
 *
 * 锁住「数字真实可核对」的展示纪律：
 *  ① summary 各计数按后端响应原样渲染，不补假统计；
 *  ② failureRate === null（窗口内无执行）→ 显示「暂无数据」，不渲染 0%；
 *  ③ 最近失败 / 最近活动列表为空走空态；
 *  ④ 实体或 summary 请求失败 → StateError + 重试。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProjectDetailPage from '../pages/ProjectDetailPage';
import { projectsApi, type ProjectSummary } from '../api/projects';

vi.mock('../api/projects', () => ({
  projectsApi: {
    getOne: vi.fn(),
    summary: vi.fn(),
  },
}));

const mockedProjects = vi.mocked(projectsApi, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）。
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

const entityFixture = {
  id: 'p-1',
  name: 'Alpha',
  description: '演示项目',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function makeSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: 'p-1',
    projectName: 'Alpha',
    taskCount: 12,
    applicationCount: 0,
    memberCount: 3,
    executionsLast7d: 8,
    failedExecutionsLast7d: 2,
    timeoutExecutionsLast7d: 1,
    failureRate: 25,
    recentFailures: [
      {
        id: 'e1',
        taskId: 't1',
        taskName: '任务甲',
        status: 'failed',
        failureReason: 'script_error',
        errorMessage: 'boom 脚本异常',
        createdAt: '2026-11-15T01:00:00.000Z',
        duration: 1200,
      },
    ],
    recentExecutions: [
      {
        id: 'e2',
        taskId: 't2',
        taskName: '任务乙',
        status: 'success',
        createdAt: '2026-11-15T02:00:00.000Z',
        duration: 900,
      },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/projects/p-1']}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects" element={<div>projects-list-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedProjects.getOne.mockReset().mockResolvedValue(entityFixture as never);
  mockedProjects.summary.mockReset().mockResolvedValue(makeSummary());
});

afterEach(() => cleanup());

/** 取某张统计卡的内容文本（标题 → 最近的 .ant-statistic-content）。 */
function cardContent(title: string): string {
  const titleEl = screen.getByText(title);
  const card = titleEl.closest('.ant-card');
  return card?.querySelector('.ant-statistic-content')?.textContent ?? '';
}

describe('ProjectDetailPage（P1-2 项目详情统计）', () => {
  it('按 summary 响应渲染统计数字与最近失败/活动列表', async () => {
    renderPage();

    expect(await screen.findByText('任务甲')).toBeTruthy();
    expect(screen.getByText('任务乙')).toBeTruthy();

    expect(cardContent('任务数')).toBe('12');
    expect(cardContent('应用数')).toBe('0');
    expect(cardContent('成员数')).toBe('3');
    expect(cardContent('近 7 天执行')).toBe('8');
    expect(cardContent('近 7 天失败')).toContain('2');
    // 失败率 25 → 25%
    expect(cardContent('近 7 天失败率')).toBe('25%');
    // 失败原因走本地化标签（script_error → 脚本错误）
    expect(screen.getByText('脚本错误')).toBeTruthy();
  });

  it('failureRate 为 null（窗口内无执行）→ 显示「暂无数据」，不渲染 0%', async () => {
    mockedProjects.summary.mockReset().mockResolvedValue(
      makeSummary({
        executionsLast7d: 0,
        failedExecutionsLast7d: 0,
        timeoutExecutionsLast7d: 0,
        failureRate: null,
        recentFailures: [],
        recentExecutions: [],
      }),
    );
    renderPage();

    await screen.findByText('近期没有执行记录');
    const rate = cardContent('近 7 天失败率');
    expect(rate).toBe('暂无数据');
    expect(rate).not.toContain('0%');
    expect(screen.getByText('近期没有失败或超时的执行')).toBeTruthy();
  });

  it('summary 请求失败 → StateError 错误块 + 重试入口', async () => {
    mockedProjects.summary.mockReset().mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
  });
});
