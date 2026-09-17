/**
 * python_task_multiversion 表单**接线**回归（TaskFormPage 组件级）。
 *
 * 与 python-multiversion-form.test.tsx 的分工：那个文件锚定纯逻辑的正确性
 * （applyCodeSourcePayload 的显式 null 纪律等），本文件只回答一个问题——
 * **页面真的调用了它们吗**。纯函数再正确，漏接线（或接到 payload 链的错误
 * 层级）依然会让 PATCH 带上两个冲突的代码来源，而这类缺陷只有组件级用例能拦。
 *
 * 独立成文件的另一原因：TaskFormPage 需要整组 api mock + react-router mock，
 * 与执行详情页用例的路由形态（真 MemoryRouter）不兼容，混在一个文件里
 * 只能二选一。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
// GlueEditor 是 monaco 重依赖（jsdom 缺浏览器 API），组件级用例一律桩掉
// （对齐 task-form-page.test.tsx 先例）。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

let mockRouteParams: { id?: string } = {};
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
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

const APP_ZIP_ID = '11111111-2222-3333-4444-555555555555';

/** 与共用断言同款：显式 null（键存在 + 值 null），绝不 undefined */
function expectExplicitNull(payload: Record<string, unknown>, key: string) {
  expect(Object.prototype.hasOwnProperty.call(payload, key), `键 ${key} 必须存在`).toBe(true);
  expect(payload[key], `${key} 必须是显式 null`).toBeNull();
}

/** 点击代码来源单选项（antd Radio 的 value 落在内部 input 上） */
function pickCodeSource(value: string) {
  fireEvent.click(screen.getByTestId(`code-source-${value}`));
}

async function fillRequiredAndSubmit() {
  fireEvent.change(await screen.findByPlaceholderText('daily-report'), {
    target: { value: 'my-task' },
  });
  fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
    target: { value: 'tasks/main.py' },
  });
  fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
}

beforeEach(() => {
  mockRouteParams = {};
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([
    { id: APP_ZIP_ID, name: 'zip-app', runtime: 'python' },
  ] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
});

afterEach(() => {
  cleanup();
});

describe('TaskFormPage：代码来源选择器接线（FR-18/AC-17b）', () => {
  it('三个来源选项同屏；默认 git 显示 gitRepo 与「关联应用」绑定入口', async () => {
    render(<TaskFormPage />);
    await screen.findByPlaceholderText('daily-report');

    for (const v of ['git', 'application_zip', 'glue']) {
      expect(screen.getByTestId(`code-source-${v}`)).toBeTruthy();
    }
    // git 来源：仓库地址 / 分支可见
    expect(screen.getByPlaceholderText('https://github.com/org/repo.git')).toBeTruthy();
    expect(screen.getByPlaceholderText('main')).toBeTruthy();
    // 非 zip 来源仍保留 applicationId（部署绑定语义），且不是"必填"标题
    expect(screen.getByText('关联应用（可选）')).toBeTruthy();
  });

  it('切到 zip 来源：applicationId 变为必填载体，gitRepo 输入框消失', async () => {
    render(<TaskFormPage />);
    await screen.findByPlaceholderText('daily-report');
    pickCodeSource('application_zip');

    expect(screen.getByText('关联应用（必填）')).toBeTruthy();
    expect(screen.queryByPlaceholderText('https://github.com/org/repo.git')).toBeNull();
    expect(screen.queryByPlaceholderText('main')).toBeNull();
  });

  it('切到 glue 来源：给出"去下方 Glue 区块编辑"的说明，gitRepo 隐藏', async () => {
    render(<TaskFormPage />);
    await screen.findByPlaceholderText('daily-report');
    pickCodeSource('glue');

    expect(screen.getByTestId('code-source-glue-hint')).toBeTruthy();
    expect(screen.queryByPlaceholderText('https://github.com/org/repo.git')).toBeNull();
  });

  it('zip 来源未选应用：提交被本地拦截（不发请求），并给出分类文案', async () => {
    render(<TaskFormPage />);
    await screen.findByPlaceholderText('daily-report');
    pickCodeSource('application_zip');
    await fillRequiredAndSubmit();

    // 本地必填拦截：后端不会收到注定 400 的请求
    expect(tasksApi.create).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const announced = screen.getByTestId('task-form-validation-announcement').textContent ?? '';
      // 播报区（或 message 浮层）应提到缺失项 = 关联应用（必填）
      expect(document.body.textContent).toContain('关联应用（必填）');
      expect(announced.length).toBeGreaterThan(0);
    });
  });

  it('zip 来源应用 runtime 与任务 runtime 不一致：就地显示内联错误', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([
      { id: APP_ZIP_ID, name: 'node-app', runtime: 'node' },
    ] as never);
    render(<TaskFormPage />);
    await screen.findByPlaceholderText('daily-report');
    pickCodeSource('application_zip');

    // 选中有 runtime 冲突的应用（任务 runtime 默认 python）
    const select = screen.getByText('选择要部署的 zip 应用');
    fireEvent.mouseDown(select);
    fireEvent.click(await screen.findByTitle('node-app'));

    await vi.waitFor(() => {
      const alert = screen.getByTestId('code-source-runtime-mismatch');
      expect(alert.textContent).toContain('node');
      expect(alert.textContent).toContain('python');
    });
  }, 20_000);

  it('新建任务（默认 git 来源）提交：载体字段逐键显式 null，不产生冲突来源', async () => {
    render(<TaskFormPage />);
    await fillRequiredAndSubmit();
    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));

    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    // FR-06：未声明版本 = 显式 null（走宿主默认解释器），不是省略键
    expectExplicitNull(payload, 'runtimeVersion');
    // FR-18：git 来源下两个"非 git"载体被无条件显式 null（git 分支里写死的），
    // 这正是防「切了来源但旧值仍在后端生效」的关键
    expectExplicitNull(payload, 'gitRepo');
    expectExplicitNull(payload, 'gitBranch');
    expectExplicitNull(payload, 'glueSource');
    // 载荷无法自证（gitRepo 为空）时不声明 codeSource（发 null 回到后端隐式
    // 推断语义，避免「声明漂移」400）
    expectExplicitNull(payload, 'codeSource');
    // applicationId 例外：它只在「离开 zip 来源」时才被清。新建任务本就没有
    // 该绑定，键不出现即等价（后端无旧值可保留）——**不得**在这里补 null，
    // 否则会把 placement/部署绑定语义一起抹掉（见 applyCodeSourcePayload 注释）。
    expect(payload.applicationId).toBeUndefined();
    // W-21：requirements 未被来源归一误伤
    expectExplicitNull(payload, 'requirements');
  }, 20_000);

  it('切到 glue 后提交：gitRepo 显式 null，且不写 glueSource（不得删用户的脚本）', async () => {
    render(<TaskFormPage />);
    await screen.findByPlaceholderText('daily-report');
    pickCodeSource('glue');
    await fillRequiredAndSubmit();
    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));

    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expectExplicitNull(payload, 'gitRepo');
    expectExplicitNull(payload, 'gitBranch');
    // 关键：glueSource 归 GlueEditor 所有，表单**不得**写 null（= 静默删除脚本）
    expect(Object.prototype.hasOwnProperty.call(payload, 'glueSource')).toBe(false);
  }, 20_000);

  it('git 来源填了仓库地址：声明 codeSource=git（载荷自证）', async () => {
    render(<TaskFormPage />);
    await screen.findByPlaceholderText('daily-report');
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo.git'), {
      target: { value: 'https://github.com/acme/demo.git' },
    });
    await fillRequiredAndSubmit();
    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));

    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.codeSource).toBe('git');
    expect(payload.gitRepo).toBe('https://github.com/acme/demo.git');
    // 非 git 载体仍必须显式清理（否则后端会保留上一次的 glue 脚本/zip 载体）
    expectExplicitNull(payload, 'glueSource');
    // applicationId 例外见上一个用例：非 zip 且未离开 zip → 不触碰（部署绑定）
    expect(payload.applicationId).toBeUndefined();
  }, 20_000);
});

describe('TaskFormPage：编辑态来源回填与 runtimeVersion（FR-06/AC-17b）', () => {
  it('glue 任务：来源回填为 glue，保存时 glueSource 原值写回（幂等不删脚本）', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'glue-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      glueSource: 'print("hi")',
      runtimeVersion: '3.12',
    } as never);

    render(<TaskFormPage />);
    await screen.findByDisplayValue('glue-task');
    // 来源由 glueSource 推导（无 codeSource 列时）
    expect(screen.getByTestId('code-source-glue-hint')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await vi.waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));

    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.glueSource).toBe('print("hi")');
    expect(payload.codeSource).toBe('glue');
    expectExplicitNull(payload, 'gitRepo');
    // 编辑态回填的版本原样提交
    expect(payload.runtimeVersion).toBe('3.12');
  }, 20_000);

  it('runtime 改成 node：runtimeVersion 显式 null（后端拒绝非 python 声明版本）', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'py-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      runtimeVersion: '3.11',
    } as never);

    render(<TaskFormPage />);
    await screen.findByDisplayValue('py-task');
    // 编辑态回填后版本字段可见（runtime=python）
    expect(document.querySelector('[data-testid="runtime-version-select"]')).toBeTruthy();

    // 切到 node：版本字段整体消失，提交必须显式清掉旧声明
    fireEvent.click(screen.getByRole('radio', { name: 'Node.js' }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="runtime-version-select"]')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await vi.waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.runtime).toBe('node');
    expectExplicitNull(payload, 'runtimeVersion');
  }, 20_000);

  it('application_zip 任务：来源回填为 zip，必需的应用选择器带既有绑定', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'zip-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      codeSource: 'application_zip',
      applicationId: APP_ZIP_ID,
    } as never);

    render(<TaskFormPage />);
    await screen.findByDisplayValue('zip-task');
    // 显式 codeSource 优先：即便 applicationId 命中推导也是同一结果
    expect(screen.getByText('关联应用（必填）')).toBeTruthy();
    expect(screen.queryByPlaceholderText('https://github.com/org/repo.git')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await vi.waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.codeSource).toBe('application_zip');
    expect(payload.applicationId).toBe(APP_ZIP_ID);
  }, 20_000);
});

// ===========================================================================
// P2-4：解释器能力**读面咨询**（非阻断；AC-06c「解释器先下载后有」）
// 版本 state 经编辑态回填进入（rc-select combobox 的自由输入在 jsdom 下不提交
// state，故用编辑态夹具——与既有 runtimeVersion 回填用例同款通路）。
// ===========================================================================

describe('TaskFormPage：解释器能力咨询（P2-4，非阻断）', () => {
  /** 在线舰队只缓存了 3.12.13：3.7 无一台满足，3.12 满足；离线机不算数。 */
  function mockFleetWith312Only() {
    vi.mocked(executorsApi.list).mockReset().mockResolvedValue([
      {
        id: 'ex-1',
        appName: 'ex-1',
        address: 'http://127.0.0.1:9100',
        status: 'online',
        interpreters: [{ version: '3.12.13', available: true }],
      },
      {
        id: 'ex-off',
        appName: 'ex-off',
        address: 'http://127.0.0.1:9101',
        status: 'offline',
        interpreters: [{ version: '3.7.9', available: true }],
      },
    ] as never);
  }

  function renderEditTask(runtimeVersion: string | null) {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'py-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      runtimeVersion,
    } as never);
    render(<TaskFormPage />);
    return screen.findByDisplayValue('py-task');
  }

  it('声明 3.7 而在线舰队无一台满足：出现咨询（文案带版本号），但不阻止保存', async () => {
    mockFleetWith312Only();
    await renderEditTask('3.7');

    const advisory = await screen.findByTestId('runtime-version-capability-advisory');
    expect(advisory.textContent).toContain('3.7');

    // 非阻断红线：咨询存在时保存仍可提交，runtimeVersion 原样带上（不被预检拦截）。
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await vi.waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.runtimeVersion).toBe('3.7');
  }, 20_000);

  it('在线舰队已有满足版本（3.12）：不出现咨询', async () => {
    mockFleetWith312Only();
    await renderEditTask('3.12');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="runtime-version-select"]')).toBeTruthy();
    });
    expect(screen.queryByTestId('runtime-version-capability-advisory')).toBeNull();
  }, 20_000);

  it('没有在线执行器（舰队离线/列表未加载）：不提示，避免误报', async () => {
    // beforeEach 默认 list → []：unknown 态，即便任务声明 3.7 也不提示。
    await renderEditTask('3.7');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="runtime-version-select"]')).toBeTruthy();
    });
    expect(screen.queryByTestId('runtime-version-capability-advisory')).toBeNull();
  }, 20_000);
});
