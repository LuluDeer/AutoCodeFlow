/**
 * FEAT-13：「保存为模板」表单通路。
 *  1) templateConfigFromFormValues 纯映射：表单值 → CreateTaskDto 子集 config
 *     （task-template-prefill 的反向通路，对齐 utils/task-template-extract 语义）；
 *  2) TaskFormPage 交互：入口按钮 → 表单校验门 → Modal 提交载荷 → 成功/失败反馈。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import TaskFormPage from '../pages/TaskFormPage';
import { templateConfigFromFormValues } from '../utils/task-template-config-from-form';
import { taskTemplatesApi } from '../api/task-templates';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

vi.mock('../api/tasks', () => ({ tasksApi: { get: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn(), listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }) } }));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));

// 路由参数可切换：默认创建态；编辑态用例置 { id: 'task-1' }。
let mockRouteParams: { id?: string } = {};
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => mockRouteParams,
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  mockRouteParams = {};
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({} as never);
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(taskTemplatesApi.create).mockReset().mockResolvedValue({ id: 'tpl-1' } as never);
});

afterEach(() => {
  cleanup();
});

describe('templateConfigFromFormValues 纯映射（FEAT-13）', () => {
  it('抽取 CreateTaskDto 白名单字段并做 timeout → timeoutSeconds 桥接', () => {
    const config = templateConfigFromFormValues({
      name: 'nightly-report', // 任务名不进 config（实例化时由用户提供）
      description: '表单描述不应进 config',
      applicationId: 'app-1', // 应用绑定关系不克隆
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'cron',
      cronExpression: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      timeout: 600,
      timeoutAction: 'kill_retry',
      timeoutWarnRatio: 80,
      maxRetry: 3,
      retryDelay: 60,
      priority: 3,
      params: { day: 'monday' },
      runbook: '## 排障步骤',
    });
    expect(config).toEqual({
      triggerType: 'cron',
      cronExpression: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      runtime: 'python',
      entrypoint: 'main.py',
      timeoutSeconds: 600,
      timeoutAction: 'kill_retry',
      timeoutWarnRatio: 80,
      maxRetry: 3,
      retryDelay: 60,
      priority: 3,
      params: { day: 'monday' },
      runbook: '## 排障步骤',
      executeMode: 'single',
    });
  });

  it('排除非配置元字段（name/description/applicationId/executorAppName 等）', () => {
    const config = templateConfigFromFormValues(
      { name: 't', description: 'd', applicationId: 'app-1', executorAppName: 'node-a', runtime: 'python' },
      { executorGroup: 'edge' },
    );
    const keys = Object.keys(config);
    for (const forbidden of ['name', 'description', 'applicationId', 'executorAppName']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('空集合归一为省略（params/dependencies/requirements/retryableErrors/executorTags/runbook）', () => {
    const config = templateConfigFromFormValues(
      { runtime: 'python', requirements: [], retryableErrors: [], runbook: '', params: {}, dependencies: {} },
      { executorTags: [] },
    );
    const keys = Object.keys(config);
    for (const k of ['requirements', 'retryableErrors', 'runbook', 'params', 'dependencies', 'executorTags']) {
      expect(keys).not.toContain(k);
    }
  });

  it('broadcast 策略：executeMode=broadcast 且不携带 pin/group/tags', () => {
    const config = templateConfigFromFormValues(
      { runtime: 'python' },
      { executeMode: 'broadcast', executorId: 'uuid-1', executorGroup: 'g', executorTags: ['t'] },
    );
    expect(config.executeMode).toBe('broadcast');
    expect(config.executorId).toBeUndefined();
    expect(config.executorGroup).toBeUndefined();
    expect(config.executorTags).toBeUndefined();
  });

  it('pinned/group 策略：executeMode=single 并保留对应限定字段', () => {
    const pinned = templateConfigFromFormValues(
      { runtime: 'python' },
      { executeMode: 'single', executorId: 'uuid-1' },
    );
    expect(pinned.executeMode).toBe('single');
    expect(pinned.executorId).toBe('uuid-1');

    const group = templateConfigFromFormValues(
      { runtime: 'python' },
      { executeMode: 'single', executorGroup: 'edge', executorTags: ['t1', 't2'] },
    );
    expect(group.executorGroup).toBe('edge');
    expect(group.executorTags).toEqual(['t1', 't2']);
  });

  it('priority 双形态：label 字符串归一为数字（toPriorityValue 桥接）', () => {
    expect(templateConfigFromFormValues({ priority: 'high' }).priority).toBe(3);
    expect(templateConfigFromFormValues({ priority: 2 }).priority).toBe(2);
  });
});

describe('TaskFormPage「保存为模板」交互（FEAT-13）', () => {
  /** 填完必填项后点击入口按钮，等 Modal 表单出现 */
  async function openTplModal() {
    render(<TaskFormPage />);
    await screen.findByTestId('save-as-template');
    fireEvent.change(screen.getByPlaceholderText('daily-report'), { target: { value: 'nightly-report' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), { target: { value: 'main.py' } });
    fireEvent.click(screen.getByTestId('save-as-template'));
    await screen.findByTestId('tpl-name-input');
  }

  it('必填项校验通过后点击入口打开 Modal（含 name/描述/分类）', async () => {
    await openTplModal();
    expect(screen.getByText('保存为自定义模板')).toBeTruthy();
    expect(screen.getByTestId('tpl-desc-input')).toBeTruthy();
    expect(screen.getByTestId('tpl-category-input')).toBeTruthy();
  });

  it('必填项缺失时入口被校验门拦截，不打开 Modal', async () => {
    render(<TaskFormPage />);
    fireEvent.click(await screen.findByTestId('save-as-template'));
    await waitFor(() => expect(screen.getByText('请输入任务名称')).toBeTruthy());
    expect(screen.queryByText('保存为自定义模板')).toBeNull();
  });

  it('提交载荷：元信息 + config 白名单（timeout→timeoutSeconds 桥接，不带 name/applicationId）', async () => {
    await openTplModal();
    fireEvent.change(screen.getByTestId('tpl-name-input'), { target: { value: '夜报模板' } });
    fireEvent.change(screen.getByTestId('tpl-desc-input'), { target: { value: '夜间报表' } });
    fireEvent.change(screen.getByTestId('tpl-category-input'), { target: { value: '巡检' } });
    fireEvent.click(screen.getByTestId('tpl-save-confirm'));

    await waitFor(() => expect(taskTemplatesApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(taskTemplatesApi.create).mock.calls[0][0];
    expect(payload.name).toBe('夜报模板');
    expect(payload.description).toBe('夜间报表');
    expect(payload.category).toBe('巡检');
    expect(payload.config).toMatchObject({
      entrypoint: 'main.py',
      runtime: 'python',
      timeoutSeconds: 300,
    });
    // 任务名与关联应用不进 config（模板实例化时由用户提供/不克隆绑定关系）
    expect(Object.keys(payload.config)).not.toContain('name');
    expect(Object.keys(payload.config)).not.toContain('description');
    expect(Object.keys(payload.config)).not.toContain('applicationId');
  });

  it('成功后 message 反馈（create 收到调用）', async () => {
    await openTplModal();
    fireEvent.change(screen.getByTestId('tpl-name-input'), { target: { value: '夜报模板' } });
    fireEvent.click(screen.getByTestId('tpl-save-confirm'));
    await waitFor(() => expect(screen.getByText(/已保存为模板/)).toBeTruthy());
    expect(taskTemplatesApi.create).toHaveBeenCalledTimes(1);
  });

  it('请求失败弹错误 toast（表单保留可重试）', async () => {
    vi.mocked(taskTemplatesApi.create).mockRejectedValueOnce(new Error('key conflict'));
    await openTplModal();
    fireEvent.change(screen.getByTestId('tpl-name-input'), { target: { value: '夜报模板' } });
    fireEvent.click(screen.getByTestId('tpl-save-confirm'));
    await waitFor(() => expect(screen.getByText('key conflict')).toBeTruthy());
    expect(screen.getByTestId('tpl-name-input')).toBeTruthy();
  });

  it('模板名称为空提交被表单校验拦截，不发起请求', async () => {
    await openTplModal();
    fireEvent.click(screen.getByTestId('tpl-save-confirm'));
    await waitFor(() => expect(screen.getByText('请输入模板名称')).toBeTruthy());
    expect(taskTemplatesApi.create).not.toHaveBeenCalled();
  });

  it('编辑态不渲染「保存为模板」入口（模板固化属于创建态语义）', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue({
      id: 'task-1', name: 't1', runtime: 'python', entrypoint: 'main.py',
      status: 'active', triggerType: 'manual', maxRetry: 3, timeout: 300,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    } as never);
    render(<TaskFormPage />);
    await waitFor(() => expect((screen.getByPlaceholderText('daily-report') as HTMLInputElement).value).toBe('t1'));
    expect(screen.queryByTestId('save-as-template')).toBeNull();
  });
});
