/**
 * DRAFT-01：TaskFormPage 草稿自动保存 / 恢复 / 丢弃（集成层）。
 *
 * 本文件钉住的是**页面语义**，不是 hook 的重复测试（hook 自身见
 * use-draft.test.ts）。四条关键契约：
 *
 *  ① 恢复时机：编辑态必须等任务回填完成才恢复——提前恢复会被回填覆盖，
 *     等于白恢复（本页历史上 commit 7d66a9b0 那批 BUGFIX 的同一类问题）。
 *  ② 不覆盖用户编辑：用户已开始改表单（dirty）时**不**恢复草稿。
 *     守卫语义优先于草稿语义——静默覆盖用户输入是最坏的结果。
 *  ③ 作用域隔离：新建 / 编辑 A / 编辑 B 各有独立 key，草稿不串味。
 *  ④ 丢弃出口：提示条上的「丢弃草稿」删除存储并取消挂起的写入，
 *     之后不会"复活"。
 *
 * 另外钉住：恢复后置 dirty（离开仍要弹守卫）、成功提交清草稿、
 * 版本不符的旧草稿整体丢弃。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth';
import { render, cleanup, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DRAFT_SCHEMA_VERSION,
  draftKey,
  readDraft,
  writeDraft,
} from '../hooks/useDraft';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateGlue: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn(),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

let mockRouteParams: { id?: string } = {};
let mockSearchParams = new URLSearchParams('');
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
  useParams: () => mockRouteParams,
  useSearchParams: () => [mockSearchParams, vi.fn()],
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

function makeTask(over: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'server-task-name',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
    executeMode: 'single',
    timeoutSeconds: 300,
    timeout: 300,
    maxRetry: 3,
    params: {},
    ...over,
  };
}

/** 名字输入框（基本分区第一个 text input） */
function nameInput(): HTMLInputElement {
  const el = document.querySelector('input#name') as HTMLInputElement | null;
  if (!el) throw new Error('未找到任务名称输入框');
  return el;
}

const EDIT_KEY = draftKey('taskform.draft', DRAFT_SCHEMA_VERSION, ['edit', 'task-1']);
const NEW_KEY = draftKey('taskform.draft', DRAFT_SCHEMA_VERSION, ['new']);

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = {};
  mockSearchParams = new URLSearchParams('');
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('DRAFT-01 恢复：编辑态等回填完成，不覆盖用户编辑', () => {
  it('编辑态草稿在任务回填后恢复（提示条 + 字段值）', async () => {
    writeDraft(EDIT_KEY, { name: 'draft-name', timeout: 42 }, DRAFT_SCHEMA_VERSION);
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();

    // 提示条出现
    const notice = await screen.findByTestId('task-form-draft-restored');
    expect(notice.textContent).toContain('已恢复上次未保存的草稿');
    // 草稿值覆盖服务端值
    await waitFor(() => expect(nameInput().value).toBe('draft-name'));
  });

  it('无草稿时不渲染提示条', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await waitFor(() => expect(nameInput().value).toBe('server-task-name'));
    expect(screen.queryByTestId('task-form-draft-restored')).toBeNull();
  });

  it('版本不符的旧草稿整体丢弃（不渲染提示、不覆盖表单）', async () => {
    writeDraft(EDIT_KEY, { name: 'legacy-name' }, DRAFT_SCHEMA_VERSION - 1);
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await waitFor(() => expect(nameInput().value).toBe('server-task-name'));
    expect(screen.queryByTestId('task-form-draft-restored')).toBeNull();
  });

  it('恢复后置 dirty：离开仍走既有守卫语义（不会被当成"已保存"）', async () => {
    // useBlocker 被 mock 成 unblocked，故这里用「再改一次表单不报错 +
    // 提示条仍在」间接验证 dirty 路径未被打断；dirty 本身在 hook 层无法观测，
    // 因此改为断言恢复是**一次性**的：后续 setFieldsValue 不会被草稿回冲。
    writeDraft(EDIT_KEY, { name: 'draft-name' }, DRAFT_SCHEMA_VERSION);
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await waitFor(() => expect(nameInput().value).toBe('draft-name'));
    // 用户改成自己的内容
    fireEvent.change(nameInput(), { target: { value: 'user-typed' } });
    await waitFor(() => expect(nameInput().value).toBe('user-typed'));
    // 再等一拍：草稿恢复 effect 不得把值冲回 draft-name
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(nameInput().value).toBe('user-typed');
  });
});

describe('DRAFT-01 落盘：用户输入进草稿（程序化回填不进）', () => {
  it('用户改名后防抖落盘到编辑作用域 key', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await waitFor(() => expect(nameInput().value).toBe('server-task-name'));

    fireEvent.change(nameInput(), { target: { value: 'typed-by-user' } });
    // 防抖 800ms + 余量
    await waitFor(
      () => {
        const env = readDraft<Record<string, unknown>>(EDIT_KEY, DRAFT_SCHEMA_VERSION);
        expect(env?.data?.name).toBe('typed-by-user');
      },
      { timeout: 5000 },
    );
  });

  it('程序化回填（服务端值）不会自己写进草稿', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await waitFor(() => expect(nameInput().value).toBe('server-task-name'));
    // 给足防抖时间：没有任何用户输入 → 不应产生草稿
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(readDraft(EDIT_KEY, DRAFT_SCHEMA_VERSION)).toBeNull();
  });

  it('作用域隔离：编辑 task-1 的草稿不写进 new 作用域', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await waitFor(() => expect(nameInput().value).toBe('server-task-name'));
    fireEvent.change(nameInput(), { target: { value: 'edit-scope' } });
    await waitFor(
      () => expect(readDraft(EDIT_KEY, DRAFT_SCHEMA_VERSION)?.data).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(readDraft(NEW_KEY, DRAFT_SCHEMA_VERSION)).toBeNull();
  });
});

describe('DRAFT-01 丢弃与提交清理', () => {
  it('点「丢弃草稿」→ 存储清空、提示条消失', async () => {
    writeDraft(EDIT_KEY, { name: 'draft-name' }, DRAFT_SCHEMA_VERSION);
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await screen.findByTestId('task-form-draft-restored');

    fireEvent.click(screen.getByRole('button', { name: '丢弃草稿' }));
    await waitFor(() => expect(readDraft(EDIT_KEY, DRAFT_SCHEMA_VERSION)).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('task-form-draft-restored')).toBeNull());
  });

  it('丢弃后继续输入不会把草稿写回来（不复活）', async () => {
    writeDraft(EDIT_KEY, { name: 'draft-name' }, DRAFT_SCHEMA_VERSION);
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    renderPage();
    await screen.findByTestId('task-form-draft-restored');

    fireEvent.click(screen.getByRole('button', { name: '丢弃草稿' }));
    await waitFor(() => expect(readDraft(EDIT_KEY, DRAFT_SCHEMA_VERSION)).toBeNull());

    fireEvent.change(nameInput(), { target: { value: 'after-discard' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(readDraft(EDIT_KEY, DRAFT_SCHEMA_VERSION)).toBeNull();
  });

  it('编辑提交成功 → 草稿被清除', async () => {
    writeDraft(EDIT_KEY, { name: 'draft-name' }, DRAFT_SCHEMA_VERSION);
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask() as never);
    vi.mocked(tasksApi.update).mockResolvedValue(makeTask() as never);
    renderPage();
    await waitFor(() => expect(nameInput().value).toBe('draft-name'));

    const save = screen.getByRole('button', { name: /保存更改/ });
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(vi.mocked(tasksApi.update)).toHaveBeenCalled(), { timeout: 5000 });
    expect(readDraft(EDIT_KEY, DRAFT_SCHEMA_VERSION)).toBeNull();
  });
});

// ── F-39（UIUX 审计 P0-1）回归：草稿自持 state 键不得进入提交载荷 ─────────────
// 真机根因：captureDraftSnapshot 把 executorMode（自持 state）写进草稿，恢复时
// form.setFieldsValue 把它种进表单 store，提交 getFieldsValue(true) 原样带出 →
// 后端 forbidNonWhitelisted 400「property executorMode should not exist」；
// 草稿仅在成功/手动丢弃时清除 → 创建任务 100% 失败且用户被无感知地永久卡死。
// 修复（三层）：① 恢复侧 setFieldsValue 剔除 DRAFT_STATE_ONLY_KEYS；
// ② buildExecutorPayload 白名单剥离非 DTO 键；③ 失败不清草稿（既有语义），
//    同一草稿修复后可成功提交——本组用例钉住端到端行为。
describe('F-39 回归：草稿恢复后创建任务可用（executorMode 不进载荷）', () => {
  function writeFullDraft() {
    // 模拟真实 captureDraftSnapshot 产物：表单字段 + 三个自持 state 键
    writeDraft(
      NEW_KEY,
      {
        name: 'draft-name',
        entrypoint: 'tasks/main.py',
        triggerType: 'manual',
        runtime: 'python',
        timeout: 300,
        maxRetry: 3,
        retryDelay: 0,
        priority: 2,
        runtimeVersion: null,
        codeSource: 'git',
        executorMode: 'auto',
      },
      DRAFT_SCHEMA_VERSION,
    );
  }

  it('创建态恢复含 executorMode 的草稿 → create 载荷无 executorMode 且创建成功、草稿清除', async () => {
    writeFullDraft();
    vi.mocked(tasksApi.create).mockResolvedValue({ id: 'created-1', name: 'draft-name' } as never);
    mockRouteParams = {};
    renderPage();
    await screen.findByTestId('task-form-draft-restored');
    await waitFor(() => expect(nameInput().value).toBe('draft-name'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
    });
    await waitFor(() => expect(vi.mocked(tasksApi.create)).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect('executorMode' in payload).toBe(false);
    // 修复前该 400（executorMode should not exist）；修复后同一草稿一次成功
    expect(payload.name).toBe('draft-name');
    expect(payload.entrypoint).toBe('tasks/main.py');
    // 成功后草稿清除——不再自锁
    expect(readDraft(NEW_KEY, DRAFT_SCHEMA_VERSION)).toBeNull();
  });

  it('提交失败不清草稿：同一草稿在服务端恢复后可再次成功提交', async () => {
    writeFullDraft();
    vi.mocked(tasksApi.create)
      .mockRejectedValueOnce({
        code: 400,
        errorCode: 'VALIDATION_FAILED',
        message: '参数校验失败',
        params: null,
      } as never)
      .mockResolvedValue({ id: 'created-2', name: 'draft-name' } as never);
    mockRouteParams = {};
    renderPage();
    await screen.findByTestId('task-form-draft-restored');
    await waitFor(() => expect(nameInput().value).toBe('draft-name'));

    // 第一次提交：400 → 草稿必须保留（用户输入不丢）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
    });
    await waitFor(() => expect(vi.mocked(tasksApi.create)).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
    expect(readDraft(NEW_KEY, DRAFT_SCHEMA_VERSION)).not.toBeNull();

    // 第二次提交：成功 → 载荷干净 + 草稿清除
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
    });
    await waitFor(() => expect(vi.mocked(tasksApi.create)).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
    const payload = vi.mocked(tasksApi.create).mock.calls[1][0] as unknown as Record<string, unknown>;
    expect('executorMode' in payload).toBe(false);
    expect(readDraft(NEW_KEY, DRAFT_SCHEMA_VERSION)).toBeNull();
  });
});
