/**
 * UI-06 任务表单重构专项：
 *  ① 分区单页——五分区同屏渲染（全部 Form.Item 同时挂载）、锚点条渲染、
 *     Glue 区块创建前后形态（原 step3 语义保持）；
 *  ② 触发预览——cron/fixed_rate 未来 5 次时刻渲染、非法表达式占位、manual 不渲染；
 *  ③ pinning/broadcast 互斥——pinned 时广播 Radio 禁用、broadcast 时提示卡
 *     渲染（选择器本身随模式卸载）；
 *  ④ 单页直接提交——不再有 missing 跳步土壤（第八轮兜底保留，此处回归
 *     「全挂载下直接提交 payload 完整」由 task-form-page.test 覆盖）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { taskTemplatesApi } from '../api/task-templates';

vi.mock('../api/tasks', () => ({ tasksApi: { get: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], total: 0 }) } }));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/task-templates', () => ({ taskTemplatesApi: { get: vi.fn(), list: vi.fn() } }));
// GlueEditor 重依赖（monaco）裁剪：只断言区块挂载形态。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

let mockRouteParams: { id?: string } = {};
let mockSearch = '';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => mockRouteParams,
    useSearchParams: () => [new URLSearchParams(mockSearch)],
    Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
  };
});

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐既有先例）。
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
// scrollIntoView jsdom 未实现——组件已 ?. 守卫，这里仍补齐防其他库调用。
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const PIN_UUID = '550e8400-e29b-41d4-a716-446655440000';

beforeEach(() => {
  mockRouteParams = {};
  mockSearch = '';
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([
    { id: PIN_UUID, appName: 'node-a', address: '10.0.0.1:3001', status: 'online' },
  ] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue(['edge'] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(taskTemplatesApi.get).mockReset().mockRejectedValue(new Error('no template') as never);
});

afterEach(() => {
  cleanup();
});

/** 创建态渲染 + 单页可见性就绪 */
async function renderCreateForm() {
  render(<TaskFormPage />);
  await screen.findByPlaceholderText('daily-report');
}

describe('UI-06 ① 分区单页布局', () => {
  it('五分区同屏渲染（data-testid 锚点区块全部挂载），无「下一步」按钮', async () => {
    await renderCreateForm();
    expect(screen.getByTestId('section-basic')).toBeTruthy();
    expect(screen.getByTestId('section-trigger')).toBeTruthy();
    expect(screen.getByTestId('section-executor')).toBeTruthy();
    expect(screen.getByTestId('section-params')).toBeTruthy();
    expect(screen.getByTestId('section-glue')).toBeTruthy();
    // 分步按钮已消失（单页语义核心断言）。
    expect(screen.queryByRole('button', { name: /下一步/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /上一步/ })).toBeNull();
    // 锚点条渲染。
    expect(screen.getByTestId('task-form-anchor')).toBeTruthy();
  });

  it('全部 Form.Item 同挂载：name 输入与维护窗口添加按钮同屏可达', async () => {
    await renderCreateForm();
    expect(screen.getByPlaceholderText('daily-report')).toBeTruthy();
    expect(screen.getByRole('button', { name: /添加维护窗口/ })).toBeTruthy();
    expect(screen.getByText(/任务默认参数/)).toBeTruthy();
    expect(screen.getByText(/Runbook（markdown）/)).toBeTruthy();
  });

  it('创建态 Glue 区块为锁定占位（原 step3 语义：创建后才可编）；编辑态直接可编', async () => {
    await renderCreateForm();
    expect(screen.getByTestId('glue-locked-hint')).toBeTruthy();
    expect(screen.queryByTestId('glue-editor')).toBeNull();

    cleanup();
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'glue-job',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      executeMode: 'single',
      timeoutSeconds: 300,
      maxRetry: 3,
      params: {},
    } as never);
    render(<TaskFormPage />);
    expect(await screen.findByTestId('glue-editor')).toBeTruthy();
  });

  it('创建成功后 Glue 区块解锁（原 step3 行为语义：成功提示 + 编辑器 + 前往详情）', async () => {
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
    await renderCreateForm();
    fireEvent.change(screen.getByPlaceholderText('daily-report'), { target: { value: 'glue-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), { target: { value: 'tasks/main.py' } });
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    expect(await screen.findByTestId('glue-editor')).toBeTruthy();
    expect(await screen.findByText(/任务已创建成功/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /完成，前往任务详情/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /跳过，返回任务列表/ })).toBeTruthy();
  }, 15_000);
});

describe('UI-06 ② 触发预览接线', () => {
  it('manual（默认）不渲染预览；切 cron 且表达式合法 → 渲染 5 个时刻 Tag', async () => {
    await renderCreateForm();
    expect(screen.queryByTestId('trigger-preview')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Cron 定时/ }));
    const preview = await screen.findByTestId('trigger-preview');
    expect(preview).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/每周一至周五早8点/), {
      target: { value: '*/5 * * * *' },
    });
    // */5 分钟级表达式必有 5 次命中（一年窗口内必然凑满）。
    await vi.waitFor(() => {
      const tags = preview.querySelectorAll('.ant-tag');
      expect(tags.length).toBe(5);
    });
    // 预览标题与时区注记。
    expect(screen.getByText(/触发预览/)).toBeTruthy();
    expect(screen.getByText(/服务器默认时区/)).toBeTruthy();
  }, 15_000);

  it('cron 非法表达式 → 预览渲染占位警告（不阻塞表单）', async () => {
    await renderCreateForm();
    fireEvent.click(screen.getByRole('radio', { name: /Cron 定时/ }));
    await screen.findByTestId('trigger-preview');
    fireEvent.change(screen.getByPlaceholderText(/每周一至周五早8点/), {
      target: { value: '99 * * * *' },
    });
    expect(await screen.findByText(/暂无法预览/)).toBeTruthy();
  }, 15_000);

  it('fixed_rate → 渲染「每隔 N 秒」预览（now+interval 链）', async () => {
    await renderCreateForm();
    fireEvent.click(screen.getByRole('radio', { name: /固定间隔/ }));
    await screen.findByTestId('trigger-preview');
    // InputNumber parser 语义：裸数字按分钟解释（×60 秒）——输入 10 → 600 秒。
    fireEvent.change(screen.getByPlaceholderText('60（秒）'), { target: { value: '10' } });
    // 5 个时刻 Tag（fixed_rate 链必凑满）。
    const preview = screen.getByTestId('trigger-preview');
    await vi.waitFor(() => {
      expect(preview.querySelectorAll('.ant-tag').length).toBe(5);
    });
    // 「每隔 N 秒」文案渲染（值经 parser=600 秒）。
    expect(preview.textContent).toMatch(/每隔\s*600\s*秒/);
  }, 15_000);
});

describe('UI-06 ③ pinning/broadcast 互斥禁用', () => {
  it('选「指定执行器」（pinned）→ 广播 Radio 禁用 + 互斥锁标识渲染', async () => {
    await renderCreateForm();
    fireEvent.click(screen.getByRole('radio', { name: /指定执行器/ }));
    expect(screen.getByTestId('executor-mutex-lock')).toBeTruthy();
    // 广播 Radio 被禁用（文案合并「与指定执行器互斥」提示）。
    const broadcastRadio = screen
      .getByText(/与「指定执行器」互斥/)
      .closest('label')
      ?.querySelector('input[type="radio"]') as HTMLInputElement;
    expect(broadcastRadio).toBeTruthy();
    expect(broadcastRadio.disabled).toBe(true);
    // pinned 选择器渲染（Select 未选中时无 node-a 文本，断言占位与选择器存在）。
    expect(screen.getByText('选择执行器节点')).toBeTruthy();
  }, 15_000);

  it('切到 broadcast（需先经 auto：pinned 下广播被禁用，改从 auto 切）→ 提示卡渲染且选择器卸载', async () => {
    await renderCreateForm();
    // auto → pinned → auto → broadcast（pinned 下广播禁用，需先回 auto）。
    // 「自动调度」Radio 唯一化：取执行器策略组的 value=auto 输入（RUNTIME 组无 auto 值）。
    const autoRadios = () =>
      screen.getAllByRole('radio').filter((el) => (el as HTMLInputElement).value === 'auto');
    const pinnedRadio = () =>
      screen.getAllByRole('radio').filter((el) => (el as HTMLInputElement).value === 'pinned')[0];
    const broadcastRadio = () =>
      screen.getAllByRole('radio').filter((el) => (el as HTMLInputElement).value === 'broadcast')[0];
    fireEvent.click(pinnedRadio());
    // pinned 态下 broadcast 被禁用：点击不生效（防误触验证）。
    fireEvent.click(broadcastRadio());
    expect(screen.queryByTestId('broadcast-pin-cleared')).toBeNull();
    fireEvent.click(autoRadios()[0]);
    fireEvent.click(broadcastRadio());
    // broadcast 下 pinned 选择器随模式卸载（原行为），互斥提示卡渲染。
    expect(screen.getByTestId('broadcast-pin-cleared')).toBeTruthy();
    expect(screen.queryByText('选择执行器节点')).toBeNull();
  }, 15_000);

  it('broadcast 提交路径：executorId 显式 null（与 buildExecutorPayload 协同回归）', async () => {
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
    await renderCreateForm();
    fireEvent.change(screen.getByPlaceholderText('daily-report'), { target: { value: 'bcast-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), { target: { value: 'tasks/main.py' } });
    fireEvent.click(screen.getByRole('radio', { name: /广播（全部执行）/ }));
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.executeMode).toBe('broadcast');
    expect(payload.executorId).toBeNull();
  }, 15_000);
});
