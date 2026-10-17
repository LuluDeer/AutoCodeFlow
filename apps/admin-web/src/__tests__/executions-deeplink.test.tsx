/**
 * URL-SYNC-02（审计 P2，2026-10-17）：ExecutionsPage 的**外部深链**。
 *
 * 缺陷现场（URL-SYNC-01 的单向同步）：
 *   · state 的初始值读 URL；
 *   · 之后由一个回写 effect 单向覆盖 URL。
 * 于是组件**已挂载**时从外部改 URL（通知铃铛「查看失败」链到
 * `/executions?status=failed`、Dashboard「全部失败」、浏览器前进/后退）：
 * searchParams 变了但 state 不变，紧接着回写 effect 又把 URL 覆盖回旧 state。
 * 净效果 = 深链完全失效：地址栏闪过 `?status=failed` 随即被抹掉，列表仍显示
 * 全量数据。用户以为链接坏了。
 *
 * 本 spec 用**真实路由导航**（MemoryRouter + 一个外部按钮 push 新 URL）复现
 * 这个场景——这正是单元测试最容易漏掉的形态：同组件内点按钮改 state 一直
 * 是好的，只有外部导航才暴露。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutionsPage from '../pages/ExecutionsPage';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    allExecutions: vi.fn(),
    killExecution: vi.fn(),
  },
}));
const mockedTasks = vi.mocked(tasksApi, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
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

const pageFixture = (items: TaskExecution[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});


/**
 * 外部导航触发器：模拟通知铃铛/Dashboard 的链接。
 * 与页面同级渲染（不在页面内部），点击即 push 一个新 URL——这正是
 * 「组件已挂载时 URL 变化」的现场。
 */
function ExternalNav() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/executions?status=failed')}>
      goto-failed-deeplink
    </button>
  );
}

function renderPage(initialUrl = '/executions') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <ExternalNav />
        <Routes>
          <Route path="/executions" element={<ExecutionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 取最后一次列表请求的参数（allExecutions 的唯一入参对象）。 */
const lastCall = () =>
  mockedTasks.allExecutions.mock.calls[
    mockedTasks.allExecutions.mock.calls.length - 1
  ]?.[0];

describe('ExecutionsPage 外部深链（URL-SYNC-02）', () => {
  beforeEach(() => {
    mockedTasks.allExecutions.mockReset();
    mockedTasks.allExecutions.mockResolvedValue(pageFixture([]));
  });
  afterEach(() => cleanup());

  it('初始 URL 带 ?status=failed → 首屏即按 failed 请求（既有能力，回归护栏）', async () => {
    renderPage('/executions?status=failed');
    await waitFor(() => {
      expect(lastCall()?.status).toBe('failed');
    });
  });

  it('组件已挂载时外部导航到 ?status=failed → 列表按新筛选重取（修复前失效）', async () => {
    renderPage();
    await screen.findByText('暂无执行记录');
    // 首屏是无筛选请求
    expect(lastCall()?.status).toBeUndefined();

    fireEvent.click(screen.getByText('goto-failed-deeplink'));

    // 核心断言：外部导航必须驱动一次带 status=failed 的请求。
    // 修复前：state 不更新，URL 又被回写抹掉，这里永远看不到 failed。
    await waitFor(() => {
      expect(lastCall()?.status).toBe('failed');
    });
  });

  it('外部深链的筛选值会反映到 UI（状态选择器显示「失败」）', async () => {
    renderPage();
    await screen.findByText('暂无执行记录');
    fireEvent.click(screen.getByText('goto-failed-deeplink'));

    // antd Select 的选中项文本：外部导航生效后应显示「失败」而非「全部状态」
    await waitFor(() => {
      expect(
        document.body.textContent?.includes('全部状态'),
      ).toBe(false);
    });
  });

  it('外部深链不会被回写 effect 抹掉（地址栏保留 status=failed）', async () => {
    renderPage();
    await screen.findByText('暂无执行记录');
    fireEvent.click(screen.getByText('goto-failed-deeplink'));

    await waitFor(() => {
      expect(lastCall()?.status).toBe('failed');
    });
    // 回写是 replace 语义：若 state 没跟上，URL 会被清回裸 /executions，
    // 后续所有请求又会变回无筛选——这里再取一次仍应是 failed。
    await new Promise((r) => setTimeout(r, 50));
    expect(lastCall()?.status).toBe('failed');
  });
});
