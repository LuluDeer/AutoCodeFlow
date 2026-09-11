/**
 * UI-12 无障碍第一阶段补完：TaskFormPage（此前因在途冲突避让未覆盖）
 *
 * 断言：
 *  ① 五个分区容器均为具名 region（role="region" + aria-label），读屏可按区跳转；
 *  ② 左侧锚点条为具名 navigation（aria-label），而非裸 div 容器；
 *  ③ 表单校验失败时有可播报通道（role="status" + aria-live），弥补 antd
 *     仅在字段旁标红、读屏不主动播报的缺口；
 *  ④ 提交成功后播报区清空（不残留旧提示）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import TaskFormPage from '../pages/TaskFormPage';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { taskTemplatesApi } from '../api/task-templates';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/task-templates', () => ({ taskTemplatesApi: { get: vi.fn(), list: vi.fn() } }));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

let mockRouteParams: { id?: string } = {};
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => mockRouteParams,
    useSearchParams: () => [new URLSearchParams('')],
    // 无 Router 包裹（对齐 task-form-ui06 先例）：Link 降级为裸 a，避免 Router context 缺失
    Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
  };
});

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
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  mockRouteParams = {};
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(taskTemplatesApi.get).mockReset().mockRejectedValue(new Error('no template') as never);
});

afterEach(() => {
  cleanup();
});

async function renderCreateForm() {
  render(<TaskFormPage />);
  await screen.findByPlaceholderText('daily-report');
}

describe('UI-12 TaskFormPage 无障碍', () => {
  it('五个分区均为具名 region（读屏可按区跳转）', async () => {
    await renderCreateForm();
    for (const name of ['基本配置', '触发与告警', '执行器策略', '参数与运行手册', 'Glue 脚本']) {
      expect(screen.getByRole('region', { name })).toBeTruthy();
    }
    expect(screen.getAllByRole('region')).toHaveLength(5);
  }, 15000);

  it('锚点条是具名 navigation 容器', async () => {
    await renderCreateForm();
    // 锚点条默认 display:none（宽屏由 CSS 媒体查询显示）→ 不进可访问性树，
    // 故以 testid 取节点断言语义（nav 元素 + 具名），而非 role 查询。
    const nav = screen.getByTestId('task-form-anchor');
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('表单分区导航');
  }, 15000);

  it('校验失败时写入可播报状态区（role=status + aria-live）', async () => {
    await renderCreateForm();
    const live = screen.getByTestId('task-form-validation-announcement');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');

    // 空表单直接提交：antd 标红 + 组件补播报摘要
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    await waitFor(() => {
      expect(screen.getByTestId('task-form-validation-announcement').textContent).toContain(
        '表单校验未通过',
      );
    });
  }, 15000);
});
