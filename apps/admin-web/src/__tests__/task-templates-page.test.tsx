/**
 * CORE-03: TaskTemplatesPage 渲染回归（卡片列表/官方 Tag/使用按钮跳转/自定义删除）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TaskTemplatesPage from '../pages/TaskTemplatesPage';
import { taskTemplatesApi, type TaskTemplate } from '../api/task-templates';

const navMock = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navMock }));
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-form-page.test 先例）。
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
  navMock.mockReset();
  vi.mocked(taskTemplatesApi.list).mockClear().mockResolvedValue([
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
});

afterEach(() => {
  cleanup();
});

describe('TaskTemplatesPage（CORE-03）', () => {
  it('渲染官方+自定义模板卡片（名称/官方 Tag/描述摘要）', async () => {
    render(<TaskTemplatesPage />);

    expect(await screen.findByText('定时备份')).toBeTruthy();
    expect(screen.getByText('我的自定义模板')).toBeTruthy();
    expect(screen.getByText('官方')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
    expect(screen.getByText(/周期性备份任务/)).toBeTruthy();
    // 空描述的自定义模板回退占位文案。
    expect(screen.getByText('（无描述）')).toBeTruthy();
  });

  it('「使用此模板」跳转创建表单并带 ?templateId=（≤3 次点击链路的第 1 跳）', async () => {
    render(<TaskTemplatesPage />);

    const useButtons = await screen.findAllByRole('button', { name: /使用此模板/ });
    expect(useButtons.length).toBe(2);
    fireEvent.click(useButtons[0]);

    expect(navMock).toHaveBeenCalledWith(
      '/tasks/new?templateId=11111111-2222-4333-8444-555555555555',
    );
  });

  it('官方模板不渲染删除按钮；自定义模板渲染删除按钮', async () => {
    render(<TaskTemplatesPage />);

    await screen.findByText('定时备份');
    // 官方卡片 2 个 actions 槽（使用/删除），自定义卡片删除按钮存在——但官方只有一个删除入口不存在。
    // 官方模板卡片：无删除 Popconfirm 触发按钮（danger 删除图标按钮仅自定义有）。
    const delButtons = screen.getAllByRole('button', { name: 'delete' });
    expect(delButtons.length).toBe(1);
  });

  it('列表为空 → 空态提示', async () => {
    vi.mocked(taskTemplatesApi.list).mockClear().mockResolvedValue([] as never);
    render(<TaskTemplatesPage />);

    expect(await screen.findByText('暂无模板')).toBeTruthy();
  });
});
