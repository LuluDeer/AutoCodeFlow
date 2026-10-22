/**
 * CORE-03 / TEMPLATE-INSTANTIATE: TaskTemplatesPage 渲染与「使用模板」回归。
 *
 * 本轮变更：控制台「使用此模板」不再跳 `/tasks/new?templateId=`（那条 deep-link
 * 预填路径不漏 glueSource、且把 entrypoint 当必填，官方「开箱即跑」模板走它会
 * 卡在入口文件必填），改为弹窗采集任务名后直接 `POST /task-templates/:id/instantiate`。
 *
 * 覆盖：
 *  1) 卡片列表/官方 Tag/自定义删除（原 CORE-03 用例保留）；
 *  2) 点「使用」→ Modal 出现、默认任务名符合 `模板名-yyyyMMdd-HHmmss`；
 *  3) 填名确认 → instantiate 收到正确 id/name → 成功 toast → 跳 /tasks/<id>；
 *  4) instantiate 失败（409 重名）→ 错误提示、不导航、Modal 仍开且保留输入；
 *  5) 名称为空/纯空白 → 不调用 instantiate（Form 内联必填提示）；
 *  6) configSummary：带 glueSource 的模板显示 `runtime · glue`（官方模板不再有
 *     entrypoint，旧摘要会显示 `runtime · -`，误导为模板缺入口文件）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskTemplatesPage from '../pages/TaskTemplatesPage';
import { taskTemplatesApi, type TaskTemplate } from '../api/task-templates';
import { message } from '../utils/toast';

const navMock = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navMock }));
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));
// 页面从 utils/toast 取 message；showApiError 也从同一模块取，故这里一并捕获
// success/error，既能断言成功提示，也能断言失败透出的后端文案（如 409 重名）。
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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

const OFFICIAL_ID = '11111111-2222-4333-8444-555555555555';
const CREATED_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: OFFICIAL_ID,
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

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskTemplatesPage />
    </QueryClientProvider>,
  );
}

/** 点第一张卡片的「使用此模板」并等 Modal 出现（antd 有挂载动画）。 */
async function openUseModal(): Promise<HTMLElement> {
  const useButtons = await screen.findAllByRole('button', { name: /使用此模板/ });
  fireEvent.click(useButtons[0]);
  return screen.findByRole('dialog');
}

beforeEach(() => {
  navMock.mockReset();
  vi.mocked(message.success).mockClear();
  vi.mocked(message.error).mockClear();
  vi.mocked(taskTemplatesApi.instantiate).mockReset().mockResolvedValue({
    id: CREATED_ID,
    name: 'created',
    status: 'active',
    triggerType: 'cron',
    runtime: 'shell',
    createdAt: '2026-10-22T00:00:00.000Z',
  } as never);
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
    renderPage();

    expect(await screen.findByText('定时备份')).toBeTruthy();
    expect(screen.getByText('我的自定义模板')).toBeTruthy();
    expect(screen.getByText('官方')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
    expect(screen.getByText(/周期性备份任务/)).toBeTruthy();
    // 空描述的自定义模板回退占位文案。
    expect(screen.getByText('（无描述）')).toBeTruthy();
  });

  it('官方模板不渲染删除按钮；自定义模板渲染删除按钮', async () => {
    renderPage();

    await screen.findByText('定时备份');
    // UI-09 图标按钮 a11y：icon-only 删除按钮显式补 aria-label（templates.delete），
    // 可访问名不再依赖图标的 aria-label="delete"。
    const delButtons = screen.getAllByRole('button', { name: '删除模板' });
    expect(delButtons.length).toBe(1);
  });

  it('列表为空 → 空态提示', async () => {
    vi.mocked(taskTemplatesApi.list).mockClear().mockResolvedValue([] as never);
    renderPage();

    expect(await screen.findByText('暂无模板')).toBeTruthy();
  });
});

describe('TaskTemplatesPage「使用模板」= 直接实例化', () => {
  it('点「使用」→ 打开 Modal，展示模板名，默认任务名为「模板名-yyyyMMdd-HHmmss」（非空）', async () => {
    renderPage();
    const dialog = await openUseModal();

    expect(within(dialog).getByText('模板：定时备份')).toBeTruthy();
    const input = within(dialog).getByRole('textbox') as HTMLInputElement;
    // 默认名必须开箱可提交：非空、无首尾空白、只剩合法可见字符 + 时间后缀。
    expect(input.value).toMatch(/^定时备份-\d{8}-\d{6}$/);
    expect(input.value).toBe(input.value.trim());
  });

  it('填名确认 → instantiate(tpl.id,{name}) → 成功提示并跳转 /tasks/<id>', async () => {
    vi.mocked(taskTemplatesApi.instantiate).mockResolvedValue({
      id: CREATED_ID,
      name: 'prod-backup',
      status: 'active',
      triggerType: 'cron',
      runtime: 'shell',
      createdAt: '2026-10-22T00:00:00.000Z',
    } as never);
    renderPage();
    const dialog = await openUseModal();

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'prod-backup' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建任务' }));

    await waitFor(() => {
      expect(taskTemplatesApi.instantiate).toHaveBeenCalledWith(OFFICIAL_ID, { name: 'prod-backup' });
    });
    await waitFor(() => expect(navMock).toHaveBeenCalledWith(`/tasks/${CREATED_ID}`));
    expect(message.success).toHaveBeenCalledWith('已创建任务「prod-backup」');
  });

  it('instantiate 失败（409 重名）→ 错误提示、不导航、Modal 仍开且保留用户输入', async () => {
    vi.mocked(taskTemplatesApi.instantiate).mockRejectedValue(
      Object.assign(new Error('任务名称已存在'), {
        response: { data: { message: '任务名称已存在' } },
      }),
    );
    renderPage();
    const dialog = await openUseModal();
    const input = within(dialog).getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'prod-backup' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建任务' }));

    // showApiError 透出后端具体拒因，而不是泛化的「创建失败」。
    await waitFor(() => expect(message.error).toHaveBeenCalledWith('任务名称已存在'));
    expect(navMock).not.toHaveBeenCalled();
    // Modal 不关闭、输入不丢——用户改个名字即可重试。
    const stillOpen = screen.getByRole('dialog');
    expect((within(stillOpen).getByRole('textbox') as HTMLInputElement).value).toBe('prod-backup');
  });

  it('任务名为空/纯空白 → 不调用 instantiate，表单内联提示必填', async () => {
    renderPage();
    const dialog = await openUseModal();

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建任务' }));

    expect(await screen.findByText('任务名称不能为空')).toBeTruthy();
    expect(taskTemplatesApi.instantiate).not.toHaveBeenCalled();
    expect(navMock).not.toHaveBeenCalled();
  });
});

describe('TaskTemplatesPage configSummary：glue 模板', () => {
  it('config.glueSource 为非空字符串 → 显示 runtime · glue（而非 runtime · -）', async () => {
    vi.mocked(taskTemplatesApi.list).mockClear().mockResolvedValue([
      makeTemplate({
        config: {
          triggerType: 'manual',
          runtime: 'shell',
          glueSource: 'console.log("hello from glue");',
          glueLanguage: 'javascript',
        },
      }),
    ] as never);
    renderPage();

    await screen.findByText('定时备份');
    const body = document.body.textContent ?? '';
    expect(body).toContain('shell · glue');
    expect(body).not.toContain('shell · -');
  });

  it('无 glueSource 的旧模板仍回退 entrypoint', async () => {
    renderPage();

    await screen.findByText('定时备份');
    expect(document.body.textContent ?? '').toContain('shell · backup.sh');
  });
});
