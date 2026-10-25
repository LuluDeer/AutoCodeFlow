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
import { useAuthStore } from '../store/auth';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import {
  deriveExecutorMode,
  buildExecutorPayload,
  stripNonDtoPayloadKeys,
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
import { projectsApi } from '../api/projects';

// 隔离 api 层：底层 client 会拉起 axios 拦截器，测试只关心调用契约。
vi.mock('../api/tasks', () => ({ tasksApi: { get: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn(), listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }) } }));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
// TASK-PROJ-01: 归属项目候选。显式 mock 保证用例确定性（不 mock 时真实 client
// 会发请求并失败——虽然只 warn 不阻塞，但用例仍应显式控制该数据源）。
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
// F-01 配套：GlueEditor 重依赖（monaco）裁剪，策略同 task-form-ui06/task-save-as-template
// 等文件——组件级测试不加载真实 monaco（jsdom 缺 queryCommandSupported 等浏览器 API）。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
// 路由参数可切换：默认编辑态（id='task-1'）；创建态用例置为 {}。
// mock 工厂在测试执行期才调用 useParams/useSearchParams，届时变量已初始化。
let mockRouteParams: { id?: string } = { id: 'task-1' };
let mockSearch = '';
// useSearchParams 返回值按 mockSearch 内容缓存（真路由在 setSearchParams 后
// 返回更新后的参数对象；不变则稳定引用），避免每次渲染新对象误触 effect 依赖。
let mockSearchParamsCache: URLSearchParams | null = null;
let mockSearchParamsCacheKey = '';
// F-04：suggestCron 用例需要观察 setSearchParams（清参 + replace 导航）。
// 断言只需 next（清参结果），opts(replace) 不影响观察值——故实现不接收第二参，
// 避免 `_opts` 未使用触发 @typescript-eslint/no-unused-vars（CI lint 门禁）。
let mockSetSearchParams = vi.fn((next: URLSearchParams) => {
  mockSearch = next.toString();
});
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
  useParams: () => mockRouteParams,
  useSearchParams: () => {
    if (mockSearch !== mockSearchParamsCacheKey || !mockSearchParamsCache) {
      mockSearchParamsCacheKey = mockSearch;
      mockSearchParamsCache = new URLSearchParams(mockSearch);
    }
    return [mockSearchParamsCache, mockSetSearchParams];
  },
  // UI-03：TaskFormPage 页头 PageHeader 面包屑消费 Link——mock 补齐导出（纯锚点桩）
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
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



const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );
beforeEach(() => {
  // DRAFT-01：草稿落 localStorage——每个用例必须从干净状态起跑，否则上一个
  // 用例的输入会被下一个用例"恢复"进表单（真实产品行为，但测试需隔离）。
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  mockSearch = '';
  mockSearchParamsCache = null;
  mockSearchParamsCacheKey = '';
  mockSetSearchParams = vi.fn((next: URLSearchParams) => {
    mockSearch = next.toString();
  });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([
    { id: PIN_UUID, appName: 'node-a', address: '10.0.0.1:3001', status: 'online' },
  ] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([
    { id: 'p-1', name: 'Alpha' },
    { id: 'p-2', name: 'Beta' },
  ] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
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

  // FEAT-22 v2：任务级部署约束模式的 payload 归一——'global' 哨兵（表单的
  // 「跟随全局」选项）与 undefined（控件清空/未回填）都必须显式 null（PATCH
  // 缺省=保留旧覆盖值，否则「界面显示跟随全局、后端仍按旧值派发」）；选定值
  // 原样保留；pinned 模式同样保留不擦除。
  it('deploymentPolicy：global/undefined 归一显式 null，选定值各模式保留', () => {
    const cleared = buildExecutorPayload({ name: 't', deploymentPolicy: 'global' }, 'auto');
    expect(cleared.deploymentPolicy).toBeNull();
    const blank = buildExecutorPayload({ name: 't' }, 'auto');
    expect(blank.deploymentPolicy).toBeNull();

    const kept = buildExecutorPayload({ name: 't', deploymentPolicy: 'strict' }, 'group');
    expect(kept.deploymentPolicy).toBe('strict');

    const pinned = buildExecutorPayload(
      { name: 't', executorId: PIN_UUID, deploymentPolicy: 'prefer' },
      'pinned',
    );
    expect(pinned.executorId).toBe(PIN_UUID);
    expect(pinned.deploymentPolicy).toBe('prefer');
  });
});

// F-39（UIUX 审计 P0-1）②：提交载荷白名单——非 CreateTaskDto 声明的键一律剥离。
// 真机根因：草稿恢复把自持 state 键 executorMode 种进表单 store，提交
// getFieldsValue(true) 原样带出 → 后端 forbidNonWhitelisted 400「should not
// exist」且草稿仅在成功/手动丢弃时清除 → 创建任务被无感知地永久卡死。
describe('F-39 stripNonDtoPayloadKeys / buildExecutorPayload 白名单剥离', () => {
  it('剥离 executorMode 等自持 state 键与未知键，DTO 键原样保留', () => {
    const payload = buildExecutorPayload(
      {
        name: 't',
        triggerType: 'manual',
        runtime: 'python',
        entrypoint: 'tasks/main.py',
        executorMode: 'auto',
        runtimeVersion: null,
        codeSource: 'git',
        someLegacyFieldGoneFromForm: 'junk',
      },
      'auto',
    );
    expect('executorMode' in payload).toBe(false);
    expect('someLegacyFieldGoneFromForm' in payload).toBe(false);
    expect(payload.name).toBe('t');
    expect(payload.runtime).toBe('python');
    expect(payload.entrypoint).toBe('tasks/main.py');
  });

  it('表单载体键 upstreamDependencies 保留（外层 applyDependenciesPayload 消费后再删）', () => {
    const payload = buildExecutorPayload(
      { name: 't', upstreamDependencies: ['uuid-1'] },
      'auto',
    );
    expect(payload.upstreamDependencies).toEqual(['uuid-1']);
  });

  it('运行时字段照旧归一后仍在（executeMode/affinity null 化不受剥离影响）', () => {
    const payload = buildExecutorPayload(
      { name: 't', executorAffinityTags: [], executorAntiAffinityTags: undefined },
      'broadcast',
    );
    expect(payload.executeMode).toBe('broadcast');
    expect(payload.executorAffinityTags).toBeNull();
    expect(payload.executorAntiAffinityTags).toBeNull();
  });

  it('stripNonDtoPayloadKeys：纯函数、不改入参、空入参安全', () => {
    const input = { name: 't', junk: 1 };
    const out = stripNonDtoPayloadKeys(input);
    expect(out).toEqual({ name: 't' });
    expect(input.junk).toBe(1);
    expect(stripNonDtoPayloadKeys({})).toEqual({});
  });
});

describe('TaskFormPage 创建流程提交 payload 完整性（P0 回归，UI-06 单页语义）', () => {
  it('单页全挂载下直接提交：name/runtime/entrypoint 仍在 POST payload（不再依赖分步推进）', async () => {
    // 历史（e2e-full.spec.js 用例 25）：分步渲染卸载 step 0/1 的 Form.Item 后
    // validateFields() 只返回当前挂载字段 → POST 缺 name → 400。
    // UI-06 重构为分区单页（全部 Form.Item 同时挂载），缺陷土壤消除；
    // 本用例改单页语义：同屏填写后直接点提交，不再有「下一步」按钮。
    mockRouteParams = {}; // 创建态：无 :id
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);

    renderPage();

    // 单页：直接填写核心必填（runtime 由 initialValues 默认 python）。
    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'my-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    // 直接提交（单页下不再有 step 推进）。
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    // P0 回归点：全部字段同挂载，payload 完整。
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
  }, 15_000);

  // ── F-10（UIAUDIT P3-3）：params 64KB 提交前预检 ──────────────────────────
  // 后端 task/params-size.util 的 TASK_PARAMS_MAX_BYTES=65_536 对 create/update
  // 统一 400；此前超限只在提交后收到裸 400。表单在提交前以同口径（JSON utf8
  // 字节）拦下：不发起 POST、给出可读提示并滚到参数分区。
  it('F-10：params 超过 64KB 时提交前拦截——不发起 POST 并给出体积提示', async () => {
    mockRouteParams = {}; // 创建态：无 :id
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);

    renderPage();

    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'fat-params-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    // 塞一个 >64KB 的参数值（ParamsEditor 行内输入，70_000 字符 > 65_536 字节）
    fireEvent.click(screen.getByRole('button', { name: /添加参数/ }));
    fireEvent.change(screen.getByPlaceholderText('参数名'), { target: { value: 'big' } });
    fireEvent.change(screen.getByPlaceholderText('参数值'), {
      target: { value: 'x'.repeat(70_000) },
    });
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    // 提示出现在 UI-12 播报区（含实际体积与上限字节）
    await vi.waitFor(() =>
      expect(screen.getByTestId('task-form-validation-announcement').textContent).toContain('65536'),
    );
    expect(screen.getByTestId('task-form-validation-announcement').textContent).toContain('任务参数');
    // 关键：请求未发出（后端 400 的前置拦截）
    expect(tasksApi.create).not.toHaveBeenCalled();
  }, 20_000);
});

// UIUX-F-43（审计 P2-1）：saving 置位在元信息校验之后，此前快速连点会全部
// 进入提交流程各自发 POST——真机实测 4 连点 = 4 个 POST（1×201 + 3×409）。
describe('UIUX-F-43 提交互斥锁', () => {
  it('连点 3 次只发 1 个 POST（校验 await 窗口内的连点被入口锁吞掉）', async () => {
    mockRouteParams = {}; // 创建态
    let resolveCreate!: (v: unknown) => void;
    vi.mocked(tasksApi.create).mockReset().mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }) as never,
    );

    renderPage();

    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'w2-race-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });

    const submit = screen.getByRole('button', { name: /创建任务/ });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);

    // 三次点击里只有第一次真正进入提交流程
    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveCreate({ id: 'new-task' });
    });
    expect(tasksApi.create).toHaveBeenCalledTimes(1);
  }, 15_000);
});

// UIUX-F-7（审计 P2-6）：secrets 键名镜像校验的提交闸门。行内红字在
// SecretsEditor；此处钉住：载荷里出现非法键（绕过行内校验/改名路径）时
// 提交被拦下且给出可读提示，而不是整批 400 到后端。
describe('UIUX-F-7 secrets 键名提交闸门', () => {
  it('新增行填非法键名 → 提交被拦（不发 POST），错误提示与行内红字在场', async () => {
    mockRouteParams = {}; // 创建态
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);

    renderPage();

    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'f7-secrets-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });

    // 凭据分区添加一行并填入非法键（连字符形状）
    fireEvent.click(screen.getByText(/添加凭据|Add credential/));
    const keyInputsAll = () =>
      Array.from(document.querySelectorAll('input.ant-input')).filter(
        (i) => !(i as HTMLInputElement).type || (i as HTMLInputElement).type === 'text',
      ) as HTMLInputElement[];
    fireEvent.change(keyInputsAll()[keyInputsAll().length - 1], {
      target: { value: 'my-key' },
    });
    const passwords = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    fireEvent.change(passwords[passwords.length - 1], { target: { value: 'tok' } });

    // 行内红字即时可见（不需要点提交才知道）
    expect(screen.getByText(/不是合法的环境变量名/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    // 闸门：POST 不发生，错误 toast 与 aria-live 播报双路在场（同一文案两处渲染）
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tasksApi.create).not.toHaveBeenCalled();
    expect(screen.getAllByText(/凭据键名不可用/).length).toBeGreaterThanOrEqual(1);
    expect(
      document.querySelector('[data-testid="task-form-validation-announcement"]')?.textContent,
    ).toContain('凭据键名不可用');
  }, 15_000);

  it('合法键名的凭据行不拦截（POST 正常发出且带 secrets）', async () => {
    mockRouteParams = {}; // 创建态
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);

    renderPage();

    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'f7-ok-secrets-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });

    fireEvent.click(screen.getByText(/添加凭据|Add credential/));
    const keyInputsAll = () =>
      Array.from(document.querySelectorAll('input.ant-input')).filter(
        (i) => !(i as HTMLInputElement).type || (i as HTMLInputElement).type === 'text',
      ) as HTMLInputElement[];
    fireEvent.change(keyInputsAll()[keyInputsAll().length - 1], {
      target: { value: 'FEISHU_APP_ID' },
    });
    const passwords = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    fireEvent.change(passwords[passwords.length - 1], { target: { value: 'tok' } });

    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.secrets).toEqual({ FEISHU_APP_ID: 'tok' });
  }, 15_000);
});

describe('TaskFormPage 请求生命周期', () => {
  it('页面 GET 请求共享 AbortSignal，编辑请求卸载后不写入表单，也不提示旧请求错误', async () => {
    let resolveTask: ((task: unknown) => void) | undefined;
    vi.mocked(tasksApi.get).mockReset().mockImplementation(() => new Promise((resolve) => {
      resolveTask = resolve;
    }) as never);
    const { unmount } = renderPage();

    await vi.waitFor(() => {
      expect(executorsApi.getGroups).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(executorsApi.getTags).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(executorsApi.list).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(applicationsApi.list).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(tasksApi.listAll).toHaveBeenCalledWith({}, expect.any(AbortSignal));
      expect(tasksApi.get).toHaveBeenCalledWith('task-1', expect.any(AbortSignal));
    });
    const requestSignal = vi.mocked(tasksApi.get).mock.calls[0][1];
    expect(requestSignal).toBeInstanceOf(AbortSignal);

    unmount();
    expect(requestSignal?.aborted).toBe(true);
    resolveTask?.({
      id: 'task-1',
      name: 'stale-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
    });
    await Promise.resolve();
    expect(screen.queryByDisplayValue('stale-task')).toBeNull();
  });
});

describe('TaskFormPage 编辑态加载 executorId → pinned 选择器（UI-06 单页语义）', () => {
  it('加载 executorId-pin 任务后，单页直接渲染绑定 executorId 的选择器', async () => {
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

    renderPage();
    // 单页：无需推进步骤，pinned 选择器同屏渲染；executorId 命中列表项时
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

describe('TaskFormPage 维护窗口动态行（FEAT-06 组件级，UI-06 单页语义）', () => {
  it('添加行 → 填写 cron → 删除行：输入随行增删', async () => {
    mockRouteParams = {}; // 创建态
    renderPage();

    // 单页：维护窗口区块同屏可达，无需推进步骤。
    const addButton = await screen.findByRole('button', { name: /添加维护窗口/ });
    fireEvent.click(addButton);
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

  it('P2-2：添加按钮始终显示 (n/10) 取值范围，满员前不再静默变灰', async () => {
    mockRouteParams = {}; // 创建态
    renderPage();

    // 旧实现按钮只有「添加维护窗口」、无计数；加满到上限后 disabled 静默变灰。
    const addButton = await screen.findByRole('button', { name: /添加维护窗口（0\/10）/ });
    fireEvent.click(addButton);
    expect(
      await screen.findByRole('button', { name: /添加维护窗口（1\/10）/ }),
    ).toBeTruthy();
  }, 15_000);

  it('填写窗口后提交：payload.maintenanceWindows 带结构化数组', async () => {
    mockRouteParams = {}; // 创建态
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
    renderPage();

    // 单页：同屏填写 name/entrypoint + 维护窗口后直接提交。
    fireEvent.change(await screen.findByPlaceholderText('daily-report'), {
      target: { value: 'mw-task' },
    });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /添加维护窗口/ }));
    fireEvent.change(await screen.findByPlaceholderText('开始 Cron，如 30 2 * * *'), {
      target: { value: '30 2 * * *' },
    });
    fireEvent.change(screen.getByPlaceholderText('结束 Cron，如 0 4 * * *'), {
      target: { value: '0 4 * * *' },
    });
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

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

    renderPage();
    // 单页：回填行同屏可见，无需推进步骤。
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

// F-04（DEEP_REVIEW @0ef3bbe）：详情页「应用建议 Cron」→ /tasks/:id/edit?suggestCron=...
// 此前全仓无消费方（死链）。回归覆盖：编辑态等任务回填完成后建议值覆盖库内旧值、
// i18n toast、URL 参数以 replace 清除（防刷新重复应用）、创建态挂载即应用。
describe('TaskFormPage suggestCron（F-04 AI 建议 Cron 死链修复）', () => {
  it('编辑态带 ?suggestCron=：任务回填完成后建议值覆盖 cronExpression，URL 参数被清除（replace）', async () => {
    mockRouteParams = { id: 'task-1' };
    mockSearch = `suggestCron=${encodeURIComponent('0 */2 * * *')}`;
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'ai-cron-job',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'cron',
      // 库内旧值——若建议值未在回填后应用，displayValue 会停在旧值上
      cronExpression: '0 2 * * *',
      timeoutSeconds: 300,
      maxRetry: 3,
    } as never);

    renderPage();

    // cron 字段（triggerType=cron）渲染建议值而非库内旧值
    expect(await screen.findByDisplayValue('0 */2 * * *')).toBeTruthy();
    expect(screen.queryByDisplayValue('0 2 * * *')).toBeNull();

    // URL 清参：suggestCron 被移除且走 replace 导航（不新增历史记录）
    await vi.waitFor(() => expect(mockSetSearchParams).toHaveBeenCalledTimes(1));
    const [nextParams, opts] = mockSetSearchParams.mock.calls[0] as unknown as [
      URLSearchParams,
      { replace?: boolean },
    ];
    expect(nextParams.get('suggestCron')).toBeNull();
    expect(opts).toEqual({ replace: true });
    expect(mockSearch).not.toContain('suggestCron');

    // i18n toast（zh 默认 locale）
    expect(await screen.findByText('已应用 AI 建议 Cron：0 */2 * * *，保存任务后生效')).toBeTruthy();
  }, 15_000);

  it('创建态带 ?suggestCron=：挂载即应用（toast + 清参各一次，cron 字段未挂载也不报错）', async () => {
    mockRouteParams = {}; // 创建态：无 :id
    mockSearch = `suggestCron=${encodeURIComponent('30 7 * * 1')}`;
    vi.mocked(tasksApi.get).mockReset();

    renderPage();

    // 创建态 triggerType=manual，cronExpression 字段未挂载——setFieldValue 仍写入
    // 表单 store（preserve），以 toast 断言应用行为
    expect(await screen.findByText('已应用 AI 建议 Cron：30 7 * * 1，保存任务后生效')).toBeTruthy();
    await vi.waitFor(() => expect(mockSetSearchParams).toHaveBeenCalledTimes(1));
    const [nextParams, opts] = mockSetSearchParams.mock.calls[0] as unknown as [
      URLSearchParams,
      { replace?: boolean },
    ];
    expect(nextParams.get('suggestCron')).toBeNull();
    expect(opts).toEqual({ replace: true });
    // 创建态不应发起任务详情请求
    expect(tasksApi.get).not.toHaveBeenCalled();
  }, 15_000);
});

/**
 * TASK-PROJ-01（本轮审计）：任务归属项目。
 *
 * 背景：`tasks.projectId` 由迁移 1790000000008 建立并回填了**存量**任务，但该迁移
 * 注释写明「新建任务在 DTO 未接 projectId 前一律落 NULL」——收尾项一直没做。于是
 * 新建任务永远 NULL，而 project-access.service 把 NULL 按 DEFAULT_PROJECT_ID 判定，
 * 「项目隔离」对所有新任务都塌缩到默认项目、形同虚设。
 */
describe('TASK-PROJ-01 归属项目选择器', () => {
  beforeEach(() => {
    localStorage.clear(); // DRAFT-01：创建态草稿同样按用例隔离
    mockRouteParams = {}; // 创建态
    mockSearch = '';
    vi.mocked(tasksApi.get).mockReset();
  });

  it('渲染归属项目选择器（候选来自 projectsApi.list）', async () => {
    renderPage();
    expect(await screen.findByTestId('task-project-select')).toBeTruthy();
    expect(projectsApi.list).toHaveBeenCalled();
  });

  it('选中项目后提交 payload 携带 projectId', async () => {
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
    renderPage();
    await screen.findByTestId('task-project-select');

    // 填必填项（与既有 P0 用例同款定位）
    fireEvent.change(await screen.findByPlaceholderText('daily-report'), {
      target: { value: 'proj-task' },
    });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });

    // 选择项目（antd Select 先例：mouseDown 打在 .ant-select 容器上）
    fireEvent.mouseDown(
      screen.getByTestId('task-project-select').closest('.ant-select') as HTMLElement,
    );
    const option = await screen.findByText('Alpha', {
      selector: '.ant-select-item-option-content',
    });
    fireEvent.click(option);

    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.projectId).toBe('p-1');
  }, 15_000);

  it('不选项目时提交 projectId 为 undefined（= 未分配，既有行为不变）', async () => {
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
    renderPage();
    await screen.findByTestId('task-project-select');

    fireEvent.change(await screen.findByPlaceholderText('daily-report'), {
      target: { value: 'no-proj' },
    });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });

    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    // 未分配：不得把项目塞进去（后端 @IsOptional 接受 undefined/null）
    expect(payload.projectId).toBeUndefined();
  }, 15_000);

  it('项目列表拉取失败只 warn，不阻塞表单（未分配仍是合法取值）', async () => {
    vi.mocked(projectsApi.list).mockRejectedValue(new Error('boom') as never);
    renderPage();
    // 表单仍可用：选择器在场、必填项可填
    expect(await screen.findByTestId('task-project-select')).toBeTruthy();
    expect(document.querySelector('#name')).toBeTruthy();
  }, 15_000);
});

// UIUX-F-46（审计 P2-4）：编辑不存在任务（/tasks/999999/edit）此前渲染 33% 完成
// 度的空白新建表单，无任何加载失败提示。分流口径对齐 TaskDetailPage 的 W1 修复
// （U7/F-41）：404 → 「任务不存在」空态 + 返回列表；其它错误 → 错误态 + 重试 +
// 返回列表；两种形态都不再渲染新建表单。
describe('UIUX-F-46 编辑态详情加载失败', () => {
  it('404（__status=404）→ 「任务不存在」空态 + 返回列表，不渲染新建表单', async () => {
    vi.mocked(tasksApi.get).mockReset().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), { __status: 404 }) as never,
    );

    renderPage();

    expect(await screen.findByText('任务不存在')).toBeTruthy();
    expect(screen.getByText('返回任务列表')).toBeTruthy();
    // 表单主体不渲染（name 字段不存在 = 不是空白新建表单）
    expect(document.querySelector('#name')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存修改/ })).toBeNull();
  }, 15_000);

  it('5xx → 错误态（任务详情加载失败 + 重试 + 返回列表），点重试重新拉取详情', async () => {
    vi.mocked(tasksApi.get)
      .mockReset()
      .mockRejectedValueOnce(new Error('Request failed with status code 500') as never)
      .mockResolvedValue({ id: 'task-1', name: 'ok-task', runtime: 'python', entrypoint: 'main.py', updatedAt: '2026-01-01T00:00:00Z' } as never);

    renderPage();

    expect(await screen.findByText('任务详情加载失败')).toBeTruthy();
    expect(screen.getByText('返回任务列表')).toBeTruthy();
    expect(document.querySelector('#name')).toBeNull();

    // 重试：详情请求重新发起，成功后表单回填
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await vi.waitFor(() => expect(tasksApi.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByDisplayValue('ok-task')).toBeTruthy();
    expect(screen.queryByText('任务详情加载失败')).toBeNull();
  }, 15_000);
});
