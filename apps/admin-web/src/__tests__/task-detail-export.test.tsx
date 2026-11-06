/**
 * E-1（F-5 收口）：任务详情页「导出定义」入口的回归。
 *
 * ## 这一份测的边界
 *
 * 「任务定义导出」是最容易**静默写错**的一类端点：它用 `@Res()` library mode
 * 直写附件、**绕过全局信封**，且文件名只存在于 `Content-Disposition` 响应头。
 * 三处典型错法都不会报错、只会在真机上表现为「下载到一个坏文件 / 文件叫
 * `download` / 点什么都没发生」：
 *   ① 漏 `responseType: 'blob'`：axios 按 JSON 解析附件字节，拿到对象不是 Blob；
 *   ② 不读 `Content-Disposition`：后端 slug 化的名字永远不生效；
 *   ③ 无连点保护：双击发两次请求（导出大任务时是两次全量序列化）。
 *
 * 故本文件按「页面 → hook → api」三层各钉一条，而不是只测「点了没报错」。
 *
 * ## mock 层级：只 mock 最外层 HTTP 出口（`api/client`）
 *
 * 对齐 `large-transfer-timeout.test.ts` 的口径：mock 页面层的 `api/tasks` 会让
 * 用例检验到测试自己的 mock（「路径对不对」「responseType 传没传」全都测不到）。
 * 这里 mock `client.get` 并按 **URL 分派**，真实的 `api/tasks.ts` 全程在跑——
 * 于是「打哪个路径 / 带什么 config / 回调怎么串」都是生产代码在答。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDetailPage from '../pages/TaskDetailPage';
import { useAuthStore } from '../store/auth';
import { client } from '../api/client';
import { resolveExportFilename } from '../api/tasks';
import { showApiError } from '../utils/error';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
// showApiError 单独锚定：失败路径的「有没有提示」是用户可见契约的一部分。
vi.mock('../utils/error', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/error')>()),
  showApiError: vi.fn(),
}));
vi.mock('../api/ai', () => ({ aiApi: { suggestSchedule: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'task-1' }),
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({
  default: () => <div data-testid="dep-graph" />,
}));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

const mockedClient = vi.mocked(client, true);

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

const EXPORT_URL = '/tasks/task-1/export';

const BASE_TASK = {
  id: 'task-1',
  name: 'hooked-job',
  runtime: 'python',
  entrypoint: 'main.py',
  triggerType: 'cron',
  cronExpression: '*/5 * * * *',
  status: 'active',
  maxRetry: 3,
  timeout: 300,
  params: {},
};

/** 非导出请求的统一应答（详情页首屏会并发拉详情/执行记录/统计/webhook/执行器）。 */
function defaultResponse(url: string): unknown {
  if (url === '/tasks/task-1') return BASE_TASK;
  if (url.startsWith('/tasks/task-1/executions')) return { items: [], total: 0, page: 1, pageSize: 20 };
  if (url.startsWith('/tasks/task-1/stats')) {
    return { recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 };
  }
  if (url.startsWith('/tasks/task-1/webhook')) return { enabled: false, url: '' };
  if (url.startsWith('/executors')) return [];
  return {};
}

/**
 * 让 mock 的 `client.get` 忠实模拟 axios 对 `transformResponse` 的调用约定
 * （`(data, headers, status)`）——`api/tasks.ts` 正是靠它从响应头里取文件名的。
 * 不模拟的话，「头优先」这条路径在本文件里就是不可达的死代码。
 */
function respondWithExport(blob: Blob, headers: Record<string, string> = {}) {
  mockedClient.get.mockImplementation((async (url: unknown, config?: unknown) => {
    if (String(url) === EXPORT_URL) {
      const tr = (config as { transformResponse?: Array<(d: Blob, h: unknown) => Blob> } | undefined)
        ?.transformResponse;
      return tr && tr.length > 0 ? tr[0]!(blob, headers) : blob;
    }
    return defaultResponse(String(url));
  }) as never);
}

beforeEach(() => {
  // 导出是读面操作——**故意用非管理员**驱动：若有人给它加了 isAdmin 门控，
  // 「按钮可点」这条断言会立刻红。
  useAuthStore.setState({ user: { id: 2, username: 'operator', role: 'user' } });
  mockedClient.get.mockReset();
  mockedClient.post.mockReset();
  vi.mocked(showApiError).mockReset();
  respondWithExport(new Blob(['{"schemaVersion":"1"}'], { type: 'application/json' }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );

/** 导出按钮：data-testid 锚定（文案随 exporting 切换，不适合按文本找）。 */
const exportButton = async (): Promise<HTMLButtonElement> =>
  (await screen.findByTestId('export-definition')) as HTMLButtonElement;

const exportCalls = () => mockedClient.get.mock.calls.filter(([url]) => String(url) === EXPORT_URL);

describe('E-1 导出定义 · 页面入口（读面操作，不受 isAdmin 门控）', () => {
  it('① 双击只发一次请求（连点保护），且在途期间按钮禁用', async () => {
    // 挂起的 promise：模拟「导出大任务时序列化没回来」，让第二次点击落在在途窗口内。
    let release!: (v: Blob) => void;
    mockedClient.get.mockImplementation((async (url: unknown) => {
      if (String(url) === EXPORT_URL) {
        return new Promise<Blob>((resolve) => {
          release = resolve;
        });
      }
      return defaultResponse(String(url));
    }) as never);

    renderPage();
    const btn = await exportButton();
    // 非管理员也必须可点：读权限与 GET /tasks/:id 同档（后端无 @Roles）。
    expect(btn.disabled).toBe(false);

    // 两次 click 落在**同一个 act 批次**里：首帧重渲染尚未发生 ⇒ 按钮的
    // disabled/loading 还没生效，此时唯一能挡住第二发的是 hook 里的 ref 闸门。
    // 这正是「去掉连点保护 ⇒ 本用例必红」的判据形态。
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    expect(exportCalls()).toHaveLength(1);
    // 在途态可见（loading + disabled），文案切到「导出中…」
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('导出中…')).toBeTruthy();

    await act(async () => {
      release(new Blob(['{}'], { type: 'application/json' }));
    });
    await waitFor(() => expect(btn.disabled).toBe(false));
    // 全程仍然只有一发
    expect(exportCalls()).toHaveLength(1);
  });

  it('② 导出失败 → 走 showApiError，且 loading 复位（按钮恢复可用）', async () => {
    const boom = { message: 'export exploded' };
    mockedClient.get.mockImplementation((async (url: unknown) => {
      if (String(url) === EXPORT_URL) throw boom;
      return defaultResponse(String(url));
    }) as never);

    renderPage();
    const btn = await exportButton();
    fireEvent.click(btn);

    await waitFor(() => expect(showApiError).toHaveBeenCalledTimes(1));
    // 兜底文案是新增的 i18n 键（不硬编码中英文）
    expect(vi.mocked(showApiError).mock.calls[0]![1]).toBe('导出任务定义失败');
    // loading 复位：finally 必须把在途标记清掉，否则按钮永久禁用（卡死页面）
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(screen.getByText('导出定义')).toBeTruthy();
  });
});

describe('E-1 导出定义 · api 层契约（responseType / 路径 / 文件名）', () => {
  it('③ 打 /tasks/:id/export 且 responseType=blob（端点不经信封，默认 json 解析会拿到对象）', async () => {
    const { tasksApi } = await import('../api/tasks');
    await tasksApi.exportDefinition('task-1', 'hooked-job');

    expect(exportCalls()).toHaveLength(1);
    const config = exportCalls()[0]![1] as { responseType?: string };
    expect(config.responseType).toBe('blob');

    // 第二段：**反证本用例有效**——把 config 换成默认（无 responseType），
    // 生产代码会在 axios 层拿不到 Blob；这里只能钉「config 上确实带了这个键」。
    expect(Object.keys(config)).toContain('responseType');
  });

  it('④ 文件名：Content-Disposition 优先取 filename，头缺失回落安全名', async () => {
    const { tasksApi } = await import('../api/tasks');
    const downloaded: string[] = [];
    // 捕获 <a download> 上真正被赋的值（objectURL 下载不读响应头，名字全由本层决定）
    const origCreateElement = document.createElement.bind(document);
    const createElSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = () => {
          downloaded.push((el as HTMLAnchorElement).download);
        };
      }
      return el;
    }) as typeof document.createElement);
    (URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:mock-def';
    (URL as unknown as Record<string, unknown>).revokeObjectURL = () => undefined;

    try {
      // (a) 头里给了名字 ⇒ 逐字用它
      respondWithExport(new Blob(['{}']), {
        'content-disposition': 'attachment; filename="x.json"',
      });
      await tasksApi.exportDefinition('task-1', 'hooked-job');

      // (b) 头缺失 ⇒ 回落 `<task.name>-<timestamp>.json`
      respondWithExport(new Blob(['{}']), {});
      await tasksApi.exportDefinition('task-1', 'hooked-job');

      // (c) 任务名里带路径分隔符/换行 ⇒ 必须被剔除（含 `/` 的名字会被浏览器
      //     当成子目录或被静默丢弃，`\` 与换行同理是坏文件名）
      respondWithExport(new Blob(['{}']), {});
      await tasksApi.exportDefinition('task-1', 'evil/name\\with\nbreaks');

      expect(downloaded).toHaveLength(3);
      expect(downloaded[0]).toBe('x.json');
      expect(downloaded[1]).toMatch(/^hooked-job-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/);
      expect(downloaded[2]).not.toMatch(/[/\\\n]/);
      expect(downloaded[2]).toMatch(/\.json$/);
    } finally {
      createElSpy.mockRestore();
    }
  });

  it('④b 文件名原语（纯函数，不经网络）：头优先 / 头缺失回落 / 非法字符剔除', () => {
    // 响应头优先（后端 slug 化的名字是唯一权威来源）
    expect(
      resolveExportFilename('attachment; filename="task-daily-backup.json"', '别的名字'),
    ).toBe('task-daily-backup.json');
    // RFC 5987 扩展参数（非 ASCII 名的正确编码形态）
    expect(
      resolveExportFilename("attachment; filename*=UTF-8''%E4%BB%BB%E5%8A%A1.json", 'x'),
    ).toBe('任务.json');
    // 头缺失 ⇒ 回落安全名：不含路径分隔符、控制字符与 Windows 保留字符
    const fallback = resolveExportFilename(undefined, 'a/b\\c:d*e?f"g<h>i|j\nk');
    expect(fallback).toMatch(/\.json$/);
    expect(fallback).not.toMatch(/[/\\:*?"<>|\n]/);
    // 头里带路径分隔符的恶意名：分隔符一律剔除，且**不留前导点**（`../x` 这类
    // 名字在某些平台上会被当成相对路径/隐藏文件）。不钉具体串——钉安全性质。
    const traversal = resolveExportFilename('attachment; filename="../../etc/passwd"', 'x');
    expect(traversal).not.toMatch(/[/\\]/);
    expect(traversal.startsWith('.')).toBe(false);
    expect(traversal).toContain('etc');
    // 任务名本身以 .json 结尾时不重复拼接扩展名
    expect(resolveExportFilename(undefined, 'already.json')).toMatch(/^already-\d{4}-/);
  });
});
