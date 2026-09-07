/**
 * R7 (N19) admin-web 任务表单消费 tasks.executorId 回归测试。
 *
 * 覆盖两层：
 *  1) 纯逻辑 helper——deriveExecutorMode（加载态 mode 映射，executorId 命中→pinned）
 *     与 buildExecutorPayload（提交 payload：pinned 带 executorId、auto/broadcast 清 null）。
 *  2) 组件级——编辑态加载一个 executorId-pin 的任务后，推进到"触发 & 执行器"步骤，
 *     pinned 选择器（绑定 executorId）应渲染，证明加载映射真正接线到 UI。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TaskFormPage from '../pages/TaskFormPage';
import {
  deriveExecutorMode,
  buildExecutorPayload,
  applyRequirementsPayload,
} from '../pages/executor-mode';
import { applyMaintenanceWindowsPayload } from '../pages/maintenance-windows';
import {
  applyTimeoutPolicyPayload,
  timeoutPolicyFormValues,
} from '../pages/timeout-policy';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

// 隔离 api 层：底层 client 会拉起 axios 拦截器，测试只关心调用契约。
vi.mock('../api/tasks', () => ({ tasksApi: { get: vi.fn(), create: vi.fn(), update: vi.fn() } }));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
// 路由参数可切换：默认编辑态（id='task-1'）；创建态用例置为 {}。
// mock 工厂在测试执行期才调用 useParams，届时变量已初始化。
let mockRouteParams: { id?: string } = { id: 'task-1' };
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => mockRouteParams,
  useSearchParams: () => [new URLSearchParams('')],
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）。
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

const PIN_UUID = '550e8400-e29b-41d4-a716-446655440000';

beforeEach(() => {
  mockRouteParams = { id: 'task-1' };
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([
    { id: PIN_UUID, appName: 'node-a', address: '10.0.0.1:3001', status: 'online' },
  ] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
});

describe('deriveExecutorMode（加载态 mode 映射，N19）', () => {
  it('executorId 命中 → pinned（优先于 executorAppName 旧语义）', () => {
    expect(deriveExecutorMode({ executorId: PIN_UUID, executorAppName: 'node-a' })).toBe('pinned');
    expect(deriveExecutorMode({ executorId: PIN_UUID })).toBe('pinned');
  });

  it('broadcast 优先于一切', () => {
    expect(deriveExecutorMode({ executeMode: 'broadcast', executorId: PIN_UUID })).toBe('broadcast');
  });

  it('仅 executorAppName（legacy）→ pinned', () => {
    expect(deriveExecutorMode({ executorAppName: 'node-a' })).toBe('pinned');
  });

  it('group/tags → group；全空 → auto', () => {
    expect(deriveExecutorMode({ executorGroup: 'g1' })).toBe('group');
    expect(deriveExecutorMode({ executorTags: ['t1'] })).toBe('group');
    expect(deriveExecutorMode({})).toBe('auto');
  });
});

describe('buildExecutorPayload（提交 payload，N19 + R8/N28）', () => {
  it('pinned：保留 executorId、显式 null 清空 legacy executorAppName/group/tags', () => {
    const payload = buildExecutorPayload(
      { name: 't', executorId: PIN_UUID, executorAppName: 'node-a', executorGroup: 'g', executorTags: ['x'] },
      'pinned',
    );
    expect(payload.executorId).toBe(PIN_UUID);
    expect(payload.executeMode).toBe('single');
    expect(payload.executorAppName).toBeNull();
    // N28：清理必须是显式 null（PATCH 缺省 = 后端保留旧值），不能是 delete/缺键
    expect(payload.executorGroup).toBeNull();
    expect(payload.executorTags).toBeNull();
  });

  it('auto：executorId 与 legacy 三字段全部显式 null（避免 PATCH 保留旧值）', () => {
    const payload = buildExecutorPayload(
      { name: 't', executorId: PIN_UUID, executorAppName: 'node-a', executorGroup: 'g', executorTags: ['x'] },
      'auto',
    );
    expect(payload.executorId).toBeNull();
    expect(payload.executeMode).toBe('single');
    expect(payload.executorAppName).toBeNull();
    expect(payload.executorGroup).toBeNull();
    expect(payload.executorTags).toBeNull();
  });

  it('group：清 executorId/executorAppName；本模式 group/tags 被清空（undefined）时也置 null', () => {
    const payload = buildExecutorPayload(
      { name: 't', executorAppName: 'node-a', executorGroup: undefined, executorTags: undefined },
      'group',
    );
    expect(payload.executorId).toBeNull();
    expect(payload.executorAppName).toBeNull();
    expect(payload.executorGroup).toBeNull();
    expect(payload.executorTags).toBeNull();
    // 用户实际选定的 group/tags 原样保留
    const kept = buildExecutorPayload({ name: 't', executorGroup: 'g1', executorTags: ['a'] }, 'group');
    expect(kept.executorGroup).toBe('g1');
    expect(kept.executorTags).toEqual(['a']);
  });

  it('broadcast：executorId 置 null、executeMode=broadcast、legacy 三字段显式 null', () => {
    const payload = buildExecutorPayload(
      { name: 't', executorId: PIN_UUID, executorAppName: 'node-a', executorGroup: 'g' },
      'broadcast',
    );
    expect(payload.executorId).toBeNull();
    expect(payload.executeMode).toBe('broadcast');
    expect(payload.executorAppName).toBeNull();
    expect(payload.executorGroup).toBeNull();
    expect(payload.executorTags).toBeNull();
  });

  it('不修改入参对象（纯函数）', () => {
    const values = { name: 't', executorId: PIN_UUID, executorGroup: 'g' };
    buildExecutorPayload(values, 'auto');
    expect(values.executorId).toBe(PIN_UUID);
    expect(values.executorGroup).toBe('g');
  });
});

describe('TaskFormPage 创建流程跨步骤提交 payload 完整性（P0 回归）', () => {
  it('step 0 填写的 name/runtime/entrypoint 在 step 2 提交时仍存在于 POST payload', async () => {
    // E2E 实证（e2e-full.spec.js 用例 25）：分步渲染卸载 step 0/1 的
    // Form.Item 后，validateFields() 只返回当前挂载字段 → POST 缺 name → 400。
    // 修复后 handleSubmit 用 getFieldsValue(true) 取全量 store 值。
    mockRouteParams = {}; // 创建态：无 :id
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);

    render(<TaskFormPage />);

    // step 0：填写核心必填（runtime 由 initialValues 默认 python）。
    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'my-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    fireEvent.click(screen.getByRole('button', { name: /下一步：调度配置/ }));

    // step 1：默认 manual 触发 + auto 调度，直接前进。
    fireEvent.click(await screen.findByRole('button', { name: /下一步：参数配置/ }));

    // step 2：提交创建。
    fireEvent.click(await screen.findByRole('button', { name: /创建任务/ }));

    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    // P0 回归点：已卸载步骤的字段必须仍在 payload 中。
    expect(payload.name).toBe('my-task');
    expect(payload.runtime).toBe('python');
    expect(payload.entrypoint).toBe('tasks/main.py');
    expect(payload.triggerType).toBe('manual');
    // N28：auto 模式下 legacy 三字段 + executorId 显式 null（非缺键）。
    expect(payload.executorId).toBeNull();
    expect(payload.executorAppName).toBeNull();
    expect(payload.executorGroup).toBeNull();
    expect(payload.executorTags).toBeNull();
    expect(payload.executeMode).toBe('single');
    // 该用例冷启动实测 3.4~4.3s，与新增测试文件并行时贴默认 5s 超时偶发超时，放宽到 15s。
  }, 15_000);
});

describe('TaskFormPage 编辑态加载 executorId → pinned 选择器', () => {
  it('加载 executorId-pin 任务后，步骤 1 渲染绑定 executorId 的选择器', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'pinned-job',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      executeMode: 'single',
      executorId: PIN_UUID,
      timeoutSeconds: 300,
      maxRetry: 3,
      params: {},
    } as never);

    render(<TaskFormPage />);
    // 等待加载态结束（loadingTask=false 后步骤 0 表单出现）。
    const nextBtn = await screen.findByRole('button', { name: /下一步：调度配置/ });
    fireEvent.click(nextBtn);
    // 推进到步骤 1（触发 & 执行器）。
    const step1Next = await screen.findByRole('button', { name: /下一步：参数配置/ });
    expect(step1Next).toBeTruthy();
    // pinned 模式才会渲染绑定 executorId 的选择器；executorId 命中列表项时
    // Select 展示选中项 label（appName + address），而非占位文案。
    expect(await screen.findByText(/node-a/)).toBeTruthy();
  });
});

// W-21: requirements 提交序列化——trim/丢空 + 空集显式 null（PATCH 缺省=后端保留旧值，
// 删除全部依赖必须发 null，复用 N28 教训）+ 字段未挂载（glue 任务）归一为 null。
describe('applyRequirementsPayload（W-21）', () => {
  it('逐条 trim 并丢弃空字符串项', () => {
    const payload = applyRequirementsPayload({
      requirements: ['  requests>=2.31  ', '', '  ', 'rich==13.7.1'],
    });
    expect(payload.requirements).toEqual(['requests>=2.31', 'rich==13.7.1']);
  });

  it('全部为空 → 显式 null（非缺省/[] 以外语义）', () => {
    const payload = applyRequirementsPayload({
      requirements: ['  ', ''],
    });
    expect(payload.requirements).toBeNull();
  });

  it('字段未挂载（glue 任务/undefined）→ 归一为 null', () => {
    const payload = applyRequirementsPayload({ name: 't' });
    expect(payload.requirements).toBeNull();
  });

  it('非字符串元素被丢弃（tags 模式理论不产出，防御性）', () => {
    const payload = applyRequirementsPayload({
      requirements: ['ok', 42, null],
    });
    expect(payload.requirements).toEqual(['ok']);
  });

  it('保留其它字段不变（仅接管 requirements）', () => {
    const payload = applyRequirementsPayload({
      name: 't',
      executorId: 'e1',
      requirements: ['flask'],
    });
    expect(payload.name).toBe('t');
    expect(payload.executorId).toBe('e1');
    expect(payload.requirements).toEqual(['flask']);
  });
});

// FEAT-06: 维护窗口——提交序列化 + 组件级动态行增删与编辑回填。
describe('applyMaintenanceWindowsPayload（FEAT-06）', () => {
  it('trim cron/说明并丢弃全空幽灵行', () => {
    const payload = applyMaintenanceWindowsPayload({
      maintenanceWindows: [
        { start: ' 30 2 * * * ', end: '0 4 * * * ', description: ' 发布冻结 ' },
        { start: '', end: '' },
        { start: undefined, end: undefined },
      ],
    });
    expect(payload.maintenanceWindows).toEqual([
      { start: '30 2 * * *', end: '0 4 * * *', description: '发布冻结' },
    ]);
  });

  it('说明为空串/空白 → 归一为 undefined（后端 @IsOptional 语义）', () => {
    const payload = applyMaintenanceWindowsPayload({
      maintenanceWindows: [{ start: '0 1 * * *', end: '0 2 * * *', description: '  ' }],
    });
    expect(payload.maintenanceWindows).toEqual([{ start: '0 1 * * *', end: '0 2 * * *' }]);
  });

  it('空集/未挂载 → 显式 null（N28：PATCH 缺省=保留，删除全部须发 null）', () => {
    expect(applyMaintenanceWindowsPayload({ maintenanceWindows: [] }).maintenanceWindows).toBeNull();
    expect(applyMaintenanceWindowsPayload({}).maintenanceWindows).toBeNull();
    expect(applyMaintenanceWindowsPayload({ name: 't' }).maintenanceWindows).toBeNull();
  });

  it('半填行保留（交给后端结构校验 400，不静默吞掉半截输入）', () => {
    const payload = applyMaintenanceWindowsPayload({
      maintenanceWindows: [{ start: '30 2 * * *', end: '' }],
    });
    expect(payload.maintenanceWindows).toEqual([{ start: '30 2 * * *', end: '' }]);
  });
});

describe('TaskFormPage 维护窗口动态行（FEAT-06 组件级）', () => {
  it('添加行 → 填写 cron → 删除行：输入随行增删', async () => {
    mockRouteParams = {}; // 创建态
    render(<TaskFormPage />);

    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'mw-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    fireEvent.click(screen.getByRole('button', { name: /下一步：调度配置/ }));

    // 默认无行：添加 → 出现一对 cron 输入
    fireEvent.click(await screen.findByRole('button', { name: /添加维护窗口/ }));
    const startInput = await screen.findByPlaceholderText('开始 Cron，如 30 2 * * *');
    const endInput = screen.getByPlaceholderText('结束 Cron，如 0 4 * * *');
    fireEvent.change(startInput, { target: { value: '30 2 * * *' } });
    fireEvent.change(endInput, { target: { value: '0 4 * * *' } });

    // 删除 → 输入消失
    fireEvent.click(screen.getByRole('button', { name: /删除维护窗口 1/ }));
    await vi.waitFor(() =>
      expect(screen.queryByPlaceholderText('开始 Cron，如 30 2 * * *')).toBeNull(),
    );
  }, 15_000);

  it('填写窗口后提交：payload.maintenanceWindows 带结构化数组', async () => {
    mockRouteParams = {}; // 创建态
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
    render(<TaskFormPage />);

    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'mw-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    fireEvent.click(screen.getByRole('button', { name: /下一步：调度配置/ }));

    fireEvent.click(await screen.findByRole('button', { name: /添加维护窗口/ }));
    fireEvent.change(await screen.findByPlaceholderText('开始 Cron，如 30 2 * * *'), {
      target: { value: '30 2 * * *' },
    });
    fireEvent.change(screen.getByPlaceholderText('结束 Cron，如 0 4 * * *'), {
      target: { value: '0 4 * * *' },
    });
    fireEvent.click(screen.getByRole('button', { name: /下一步：参数配置/ }));
    fireEvent.click(await screen.findByRole('button', { name: /创建任务/ }));

    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.maintenanceWindows).toEqual([{ start: '30 2 * * *', end: '0 4 * * *' }]);
  }, 15_000);

  it('编辑态回填已有窗口：行输入带后端值', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'windowed-job',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      executeMode: 'single',
      timeoutSeconds: 300,
      maxRetry: 3,
      params: {},
      maintenanceWindows: [
        { start: '0 22 * * 5', end: '0 6 * * 6', description: '发布冻结' },
      ],
    } as never);

    render(<TaskFormPage />);
    fireEvent.click(await screen.findByRole('button', { name: /下一步：调度配置/ }));
    expect(await screen.findByDisplayValue('0 22 * * 5')).toBeTruthy();
    expect(screen.getByDisplayValue('0 6 * * 6')).toBeTruthy();
    expect(screen.getByDisplayValue('发布冻结')).toBeTruthy();
  });
});

// CORE-04: 超时策略分级——表单序列化纯逻辑（payload 归一 + 加载态映射）。
// PATCH 语义（N28 同源）：timeoutAction undefined → null（回缺省 kill）；
// timeoutWarnRatio 空串/undefined/非法 → null（真正关闭预警）。
describe('applyTimeoutPolicyPayload（CORE-04）', () => {
  it('合法值原样保留（三动作 + 0/90 边界阈值）', () => {
    const a = applyTimeoutPolicyPayload({ timeoutAction: 'kill_retry', timeoutWarnRatio: 80 });
    expect(a.timeoutAction).toBe('kill_retry');
    expect(a.timeoutWarnRatio).toBe(80);
    const b = applyTimeoutPolicyPayload({ timeoutAction: 'notify_only', timeoutWarnRatio: 0 });
    expect(b.timeoutWarnRatio).toBe(0);
    const c = applyTimeoutPolicyPayload({ timeoutAction: 'kill', timeoutWarnRatio: 90 });
    expect(c.timeoutWarnRatio).toBe(90);
  });

  it('timeoutAction undefined（未挂载）→ null（回缺省 kill）', () => {
    const payload = applyTimeoutPolicyPayload({ name: 't' });
    expect(payload.timeoutAction).toBeNull();
  });

  it('timeoutWarnRatio 空串/undefined/非法/越界 → null（关闭预警）', () => {
    expect(applyTimeoutPolicyPayload({ timeoutWarnRatio: '' }).timeoutWarnRatio).toBeNull();
    expect(applyTimeoutPolicyPayload({ timeoutWarnRatio: undefined }).timeoutWarnRatio).toBeNull();
    expect(applyTimeoutPolicyPayload({ timeoutWarnRatio: null }).timeoutWarnRatio).toBeNull();
    expect(applyTimeoutPolicyPayload({ timeoutWarnRatio: 91 }).timeoutWarnRatio).toBeNull();
    expect(applyTimeoutPolicyPayload({ timeoutWarnRatio: -1 }).timeoutWarnRatio).toBeNull();
    expect(applyTimeoutPolicyPayload({ timeoutWarnRatio: 12.5 }).timeoutWarnRatio).toBeNull();
  });

  it('保留其它字段不变（仅接管超时策略两字段）', () => {
    const payload = applyTimeoutPolicyPayload({ name: 't', timeout: 600, executorId: 'e1' });
    expect(payload.name).toBe('t');
    expect(payload.timeout).toBe(600);
    expect(payload.executorId).toBe('e1');
  });
});

describe('timeoutPolicyFormValues（CORE-04 编辑态加载映射）', () => {
  it('后端读回值映射到表单形态；未知/缺省动作归 kill', () => {
    expect(timeoutPolicyFormValues({ timeoutAction: 'kill_retry', timeoutWarnRatio: 80 })).toEqual({
      timeoutAction: 'kill_retry',
      timeoutWarnRatio: 80,
    });
    expect(timeoutPolicyFormValues({ timeoutAction: 'notify_only' })).toEqual({
      timeoutAction: 'notify_only',
      timeoutWarnRatio: undefined,
    });
    expect(timeoutPolicyFormValues({ timeoutAction: null }).timeoutAction).toBe('kill');
    expect(timeoutPolicyFormValues({}).timeoutAction).toBe('kill');
    expect(timeoutPolicyFormValues({ timeoutWarnRatio: null }).timeoutWarnRatio).toBeUndefined();
  });
});
