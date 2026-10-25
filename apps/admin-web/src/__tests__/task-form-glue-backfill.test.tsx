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
 *
 * ## FLAKE 根治（2026-10-25）：mock 动态 import，而非等它解析
 *
 * 历史归因「Monaco mock 等待超时（findBy 默认 1s）」并不成立：test-setup.ts
 * 早已把 asyncUtilTimeout 全局抬到 10s，本文件仍在并行全量下间歇红（近 3 轮
 * 全量均红，单跑恒绿；5 并发单文件压测 5/5 全在第 1 条用例红、2/3 绿）。
 *
 * 真实时序：编辑态首帧即渲染 TaskFormGlueSection（glueTaskId=editId 非空），
 * 其内是 `React.lazy(() => import('../components/GlueEditor'))` + Suspense。
 * 本文件原先**放行真实动态 import**：首个用例要等 Vite 现场按需 transform 整个
 * GlueEditor 模块图（antd Select/Button、i18n、@monaco-editor/react、
 * monaco-setup、toast/error/api 链……），并行全量下该链路 + forks 冷启动 +
 * CPU 争抢可超 10s 无上界 → waitFor 趔预算。第 2/3 条用例复用已缓存模块图
 * 所以恒绿——这正是"负载相关、与被测行为无关"的假红特征。
 *
 * 修法对齐仓库既有先例（a11y-task-form / task-form-draft 等 10+ 文件同款）：
 * `vi.mock('../components/GlueEditor')` 直接替换动态 import 的目标模块，让
 * lazy chunk 的解析在模块图内同步完成；waitFor 只等「任务查询 resolve →
 * 回填 effect commit → 编辑器拿到终值 props」这条**真实被测链路**。模块加载
 * 时长不属于被测行为，不该进等待预算。Suspense 占位→挂载的时序本身已由
 * task-detail-glue-lazy.test.tsx 用受控 Promise 钉住，此处不重复覆盖。
 *
 * 另外：断言原在 waitFor 外一次性快照 `mockEditor.mock.calls` 末次调用——
 * 编辑器挂载与回填 commit 是两步异步，快照可能落在中间态（last.value 尚为
 * ''）。现在把断言写进 waitFor 轮询体，轮询到终值为止（同一编辑器组件的
 * sync effect 会以回填后的 props 重渲，mock 随之收到新调用记录）。
 *
 * ## 为什么每个 waitFor 都显式传 timeout（FLAKE 第二层根因，2026-10-25 实锤）
 *
 * test-setup.ts 的 `configure({ asyncUtilTimeout: 10_000 })` 在 forks 池下
 * **并不作用于测试文件的 waitFor**：setup 文件与测试文件经由两条模块管线
 * 加载出**两份不同的 @testing-library/dom 模块实例**（探针实证：setup 侧
 * `getConfig().asyncUtilTimeout = 10000`、测试侧同一查询 = 1000，模块对象
 * `globalThis.__SETUP_DOM === domMod` 为 false）。所以仓库里所有「默认
 * waitFor」实际都跑在 1s 预算上——这就是历次「超时」归因反复复发的底层
 * 原因。本文件不依赖那份失灵的全局 configure，逐个 waitFor 显式给预算。
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

// FLAKE 根治（见文件头注释）：直接 mock 掉 React.lazy 的动态 import 目标，
// 编辑器模块图不再进入等待预算；Monaco props 断言经 mockEditor 透出。
// 组件真实挂载链（Suspense 占位→chunk 解析→编辑器挂载）由
// task-detail-glue-lazy.test.tsx 的受控 Promise 独立钉住。
vi.mock('../components/GlueEditor', () => ({
  default: (props: {
    initialSource?: string;
    initialLanguage?: string;
    taskRuntime?: string;
  }) =>
    mockEditor({
      value: props.initialSource ?? '',
      language: props.initialLanguage ?? '',
    }),
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

/**
 * 编辑器 props 断言的统一等待：轮询直到「任务回填已 commit」且「mock 编辑器
 * 收到终值 props」。两个条件都在轮询体内（不是一次性快照），任一中间态
 * （表单未回填 / 编辑器还拿着旧 props）都会在下一轮收敛。
 *
 * 回填锚点用 `glue-job`（Form.Item name="name" 的回填值，出现在输入框里
 * 即代表编辑态 tasksApi.get 链路已 resolve 且字段树已挂载）——它把断言
 * 锚定在**数据链路**上，而不是某个组件恰好渲染与否。
 */
async function waitForEditorProp(expected: string, kind: 'value' | 'language') {
  await waitFor(
    () => {
      expect(
        (screen.getByRole('textbox', { name: /任务名/ }) as HTMLInputElement).value,
      ).toBe('glue-job');
      const last = mockEditor.mock.calls[mockEditor.mock.calls.length - 1]?.[0] as
        | { value?: string; language?: string }
        | undefined;
      expect(last?.[kind]).toBe(expected);
    },
    // 显式预算：全局 asyncUtilTimeout 因双模块实例失灵（见文件头注释），
    // 默认只有 1s——并行负载下任务查询回填链路可能超 1s。
    { timeout: 10_000 },
  );
}

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

    // 反证：漏传 initialSource 时这里是 ''（用户看到空白编辑器）
    await waitForEditorProp(GLUE_SOURCE, 'value');
  });

  it('编辑已有 glue 任务 → 回填真实语言（javascript 不得被 runtime 顶成 python）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(glueTask() as never);
    renderPage();

    // 断言传给 Monaco 的语言名。任务的 runtime 是 python，若用 runtime 兜底
    // language 会得到 python——脚本以错误语法高亮呈现，且一保存就把语言
    // 改写成 python（glueLanguage 被静默改写）。
    await waitForEditorProp('javascript', 'language');
  });

  it('无 glue 脚本的任务 → 编辑器为空（不得凭空注入模板内容）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(
      glueTask({ glueSource: null, glueLanguage: null, codeSource: 'git' }) as never,
    );
    renderPage();

    await waitForEditorProp('', 'value');
  });
});
