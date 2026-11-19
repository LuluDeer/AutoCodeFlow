/**
 * R281-DEEPLINK-01（S2 前端深链）：通知铃「全部失败」深链必须是**多值** `status=failed,timeout`。
 *
 * ## 缺陷现场
 *
 * 铃面板的数据源是 `/metrics/failures`（`useRecentFailures`），口径为后端
 * `FAILED_EXECUTION_STATUSES = FAILED ∪ TIMEOUT`
 * （`apps/admin-api/src/modules/task/entities/task-execution.entity.ts:61`）。
 * 而此前按钮硬编码 `nav('/executions?status=failed')` —— 后端 status 过滤是等值，
 * 超时风暴（10 条 timeout、0 条 failed）下「面板明明列着 10 条，点查看失败却是 0 条」。
 *
 * ## 断言形态
 *
 * `expect(nav).toHaveBeenCalledWith('/executions?status=failed,timeout')` —— 断言**具体
 * URL 字面值**，不是「调用过」。模块级 mock `useNavigate`（对齐 a11y-login-page.test
 * 先例：`vi.mock` 工厂返回 `useNavigate: () => mockNav`），组件其余渲染走真实实现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import { setLanguage } from '../i18n';
import NotificationBell from '../components/NotificationBell';
import { useRecentFailures } from '../api/queries';

const mockNav = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNav };
});

vi.mock('../api/queries', () => ({
  useRecentFailures: vi.fn(),
}));

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

const failuresFixture = [
  { id: 'f1', taskId: 'task-a', taskName: '任务A', errorMessage: 'timed out', createdAt: '2026-09-07T10:00:00Z' },
  { id: 'f2', taskId: 'task-b', taskName: '任务B', errorMessage: 'timed out', createdAt: '2026-09-07T11:00:00Z' },
];

const renderBell = () =>
  render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );

async function openPanel() {
  fireEvent.click(screen.getByTestId('notify-bell'));
  return screen.findByTestId('notify-panel');
}

beforeEach(async () => {
  await setLanguage('zh');
  localStorage.clear();
  mockNav.mockReset();
});

afterEach(() => {
  cleanup();
  vi.mocked(useRecentFailures).mockReset();
});

describe('R281-DEEPLINK-01 · 通知铃「全部失败」带多值 status', () => {
  it('点击 → nav 收到 /executions?status=failed,timeout（具体 URL 断言）', async () => {
    vi.mocked(useRecentFailures).mockReturnValue({
      data: failuresFixture,
      error: null,
      refetch: vi.fn(),
    } as never);

    renderBell();
    await openPanel();
    // 「全部失败」按钮（i18n: nav.notify.viewAll）——与「通知设置」并列的左侧按钮
    fireEvent.click(screen.getByRole('button', { name: '全部失败' }));

    // 核心断言：**具体 URL**。改回单值 'failed' 必然红。
    expect(mockNav).toHaveBeenCalledWith('/executions?status=failed,timeout');
    // 反向护栏：不得回退成单值（哪怕同一调用序列里还有别的 nav）
    expect(mockNav).not.toHaveBeenCalledWith('/executions?status=failed');
  });

  it('读取失败态下该按钮仍存在且同样多值（错误态不吞掉入口）', async () => {
    vi.mocked(useRecentFailures).mockReturnValue({
      data: undefined,
      error: new Error('502'),
      refetch: vi.fn(),
    } as never);

    renderBell();
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: '全部失败' }));

    expect(mockNav).toHaveBeenCalledWith('/executions?status=failed,timeout');
  });
});