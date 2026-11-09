/**
 * F-2（R140）TaskFormPage 组件级接线：错失计划落点策略（misfireStrategy）。
 *
 * 背景（见 artifacts/autonomy/R138/assess-feature.md F-2、README:295/830）：
 * 后端整条链路早已齐备（create-task.dto.ts 的 @IsEnum(MisfireStrategy)，
 * task.entity.ts 的枚举列 default ignore，scheduler.service.ts 的
 * checkMisfires 只对 `misfireStrategy === fire_once` 做补跑），但前端**没有
 * 任何控件**——用户能用到的只有库默认 ignore。本文件守住补齐后的四件事：
 *
 *  ① 周期触发（cron）提交时 payload 含**显式** misfireStrategy（缺省值是
 *     ignore，也必须显式发——PATCH 缺省=保留旧值，缺省会留下库里的旧
 *     fire_once，与「界面显示不补跑」相悖）；
 *  ② 编辑态回填：任务带 fire_once ⇒ 控件显示为已选 fire_once；
 *  ③ 非周期触发（manual）不渲染该控件（后端也只对 cron/fixed_rate 判定
 *     misfire——manual/api 没有「计划落点」）；
 *  ④ 从 cron 切到 manual 后提交**不含该键**（preserve={false} 摘掉 store
 *     值 ⇒ PATCH 缺省=保留旧值）。绝不发 null：该列 NOT NULL default ignore，
 *     null 会 422/500。fixed_rate 同样渲染（周期语义的第二态）。
 *
 * 测试骨架（api mock / 路由 mock / jsdom 兜底）与判据写法对齐先例
 * task-form-optimistic-lock.test.tsx 的 blockStrategy 用例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';

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
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

let mockRouteParams: { id?: string } = {};
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
  useParams: () => mockRouteParams,
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
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
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/** 周期触发的存量任务（无 misfireStrategy 列值 ⇒ 后端默认 ignore）。 */
const CRON_TASK = {
  id: 'task-1',
  name: 'my-task',
  runtime: 'python',
  entrypoint: 'tasks/main.py',
  triggerType: 'cron',
  cronExpression: '0 8 * * *',
  timezone: 'Asia/Shanghai',
  status: 'active',
  priority: 2,
  timeout: 300,
  maxRetry: 3,
  retryDelay: 0,
  codeSource: 'git' as const,
  gitRepo: 'https://example.com/repo.git',
  gitBranch: 'main',
  glueSource: undefined,
  updatedAt: '2026-10-01T08:00:00.000Z',
  maintenanceWindows: [],
  blockStrategy: 'serial' as const,
};

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  mockNavigate.mockReset();
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(CRON_TASK as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
  vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 等编辑态加载完成（表单回填 name 值）后点「保存更改」，返回提交 payload。 */
async function submitEditForm(): Promise<Record<string, unknown>> {
  const nameInput = await screen.findByDisplayValue('my-task');
  expect(nameInput).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
  await waitFor(() => {
    expect(vi.mocked(tasksApi.update)).toHaveBeenCalled();
  });
  return vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
}

describe('TaskFormPage：misfireStrategy 控件（F-2 / R140）', () => {
  it('① cron 任务提交时 payload 含显式 misfireStrategy（存量行未声明 ⇒ 显式 ignore）', async () => {
    renderPage();
    // 控件在周期触发下可见（与 blockStrategy 并列）
    expect(await screen.findByText('错失计划落点策略')).toBeTruthy();
    const payload = await submitEditForm();
    // 显式发，而不是缺省：PATCH 缺省=保留旧值，缺省会让库里的旧 fire_once
    // 继续生效，而界面显示的是「不补跑」。
    expect(payload.misfireStrategy).toBe('ignore');
  });

  it('② 编辑态回填 fire_once：控件显示为已选「错过后补跑一次」，提交透传', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...CRON_TASK,
      misfireStrategy: 'fire_once',
    } as never);
    renderPage();
    // antd Select 的已选项以 label 文案渲染（与 blockStrategy 用例同判据）
    expect(await screen.findByText('错过后补跑一次（不是每次都补）')).toBeTruthy();
    const payload = await submitEditForm();
    expect(payload.misfireStrategy).toBe('fire_once');
  });

  it('③ 非周期触发（manual）不渲染该控件', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...CRON_TASK,
      triggerType: 'manual',
      cronExpression: undefined,
      misfireStrategy: 'fire_once',
    } as never);
    renderPage();
    // 等编辑态加载完成（name 回填）
    await screen.findByDisplayValue('my-task');
    expect(screen.queryByText('错失计划落点策略')).toBeNull();
    expect(screen.queryByText('错过后补跑一次（不是每次都补）')).toBeNull();
  });

  it('③b fixed_rate 是周期触发的第二态：同样渲染', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...CRON_TASK,
      triggerType: 'fixed_rate',
      cronExpression: undefined,
      fixedRate: 300,
    } as never);
    renderPage();
    expect(await screen.findByText('错失计划落点策略')).toBeTruthy();
  });

  it('④ 从 cron 切到 manual 后：控件消失，提交不含 misfireStrategy 键（PATCH 缺省=保留旧值，绝不发 null）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...CRON_TASK,
      misfireStrategy: 'fire_once',
    } as never);
    renderPage();
    // 先确认回填（fire_once 已选）
    expect(await screen.findByText('错过后补跑一次（不是每次都补）')).toBeTruthy();
    // 切换触发方式 → manual（字段随之卸载，preserve={false} 摘掉 store 值）
    fireEvent.click(screen.getByRole('radio', { name: /手动触发/ }));
    await waitFor(() => {
      expect(screen.queryByText('错失计划落点策略')).toBeNull();
    });
    const payload = await submitEditForm();
    // 口径：缺省不提交（不是显式 null——该列 NOT NULL default ignore，null
    // 会 422/500）。antd 的 unmount 清理把顶层键置成 undefined 而非删键
    // （@rc-component/util 的 set 只对深层路径做 delete），但**请求体里没有
    // 这个键**：JSON.stringify 丢弃 undefined，后端 PATCH 因此走「缺省=保留
    // 旧值」。两条断言合起来把口径钉死。
    expect(payload.misfireStrategy).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('misfireStrategy');
  });
});
