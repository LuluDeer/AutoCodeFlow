/**
 * P0（UX-AUDIT-2026-09-21 §P0-1）：编辑任务时 Glue 编辑器必须回填已有脚本。
 *
 * ## 这条守的是什么
 *
 * GlueEditor 的 source 初值来自 props（`initialSource || ''`），而保存时
 * **无条件**用当前 state 覆盖服务端（`tasksApi.updateGlue(taskId, source, language)`）。
 * 于是只要调用方漏传 `initialSource`，就会出现这条不可逆损毁链：
 *
 *   打开已有 glue 任务 → Monaco 显示空白（用户以为脚本没了）
 *   → 顺手点一下语言下拉（`onChange` 里 `setDirty(true)`，保存按钮变可用）
 *   → 点保存 → 服务端 `glueSource` 被空串覆盖
 *   → 后端 updateGlue 还顺带把 `codeSource` 改成 glue、`gitRepo` 置 null
 *
 * 全仓 `initialSource` 有两个调用点：`TaskDetailPage` 传了，`TaskFormPage` **漏了**。
 * 本文件钉住 TaskFormPage 这一侧——它是编辑任务的主入口，也是唯一漏点。
 *
 * ## 为什么在页面层而不是组件层测
 *
 * 组件层行为是对的（给什么就显示什么、保存就发什么，见 glue-editor.test.tsx ③）。
 * 缺陷在"调用方没给"，所以只有在页面层断言"编辑器拿到了真实源码"才能真正
 * 挡住回归——把断言写在组件层会全绿，什么也拦不住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

// Monaco 重依赖（worker/CDN）在 jsdom 不可用——按 glue-editor.test.tsx 惯例
// mock 掉，并把它收到的 props 暴露出来供断言（这正是本测试要检查的东西）。
const { mockEditor } = vi.hoisted(() => ({ mockEditor: vi.fn() }));

vi.mock('@monaco-editor/react', () => ({
  Editor: (props: unknown) => mockEditor(props),
  loader: { config: vi.fn(), init: vi.fn() },
}));
vi.mock('monaco-editor', () => ({ default: { editor: {}, languages: {} } }));
vi.mock('../components/monaco-setup', () => ({
  monaco: { editor: {}, languages: {} },
}));

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

let mockRouteParams: { id?: string } = {};
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
  useParams: () => mockRouteParams,
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) =>
    createElement('a', { href: props.to }, props.children),
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

mockEditor.mockImplementation((props: { value?: string; language?: string }) =>
  createElement('div', {
    'data-testid': 'mock-monaco-editor',
    'data-value': props.value ?? '',
    'data-language': props.language ?? '',
  }),
);

import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

const GLUE_SOURCE = "import os\nprint('real user script')\n";

/** 一个 glue 来源的已有任务（编辑态）。 */
function glueTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'glue-job',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
    executeMode: 'single',
    timeoutSeconds: 300,
    maxRetry: 3,
    params: {},
    codeSource: 'glue',
    glueSource: GLUE_SOURCE,
    glueLanguage: 'javascript',
    ...overrides,
  };
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  mockEditor.mockClear();
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  const listAll = (tasksApi as unknown as { listAll?: ReturnType<typeof vi.fn> }).listAll;
  listAll?.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
  vi.mocked(tasksApi.updateGlue).mockReset().mockResolvedValue(undefined as never);
});

afterEach(() => cleanup());

describe('P0-1: 编辑态 Glue 编辑器必须回填已有脚本', () => {
  it('编辑已有 glue 任务 → 编辑器拿到真实源码（不是空串）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(glueTask() as never);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy());
    const last = mockEditor.mock.calls[mockEditor.mock.calls.length - 1][0] as {
      value?: string;
    };
    // 反证：漏传 initialSource 时这里是 ''（用户看到空白编辑器）
    expect(last.value).toBe(GLUE_SOURCE);
    expect(last.value).not.toBe('');
  });

  it('编辑已有 glue 任务 → 回填真实语言（javascript 不得被 runtime 顶成 python）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(glueTask() as never);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy());
    // 断言传给 Monaco 的语言名。任务的 runtime 是 python，若用 runtime 兜底
    // language 会得到 python——脚本以错误语法高亮呈现，且一保存就把语言
    // 改写成 python（glueLanguage 被静默改写）。
    const last = mockEditor.mock.calls[mockEditor.mock.calls.length - 1][0] as {
      language?: string;
    };
    expect(last.language).toBe('javascript');
  });

  it('无 glue 脚本的任务 → 编辑器为空（不得凭空注入模板内容）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(
      glueTask({ glueSource: null, glueLanguage: null, codeSource: 'git' }) as never,
    );
    renderPage();

    await waitFor(() => expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy());
    const last = mockEditor.mock.calls[mockEditor.mock.calls.length - 1][0] as {
      value?: string;
    };
    expect(last.value).toBe('');
  });
});
