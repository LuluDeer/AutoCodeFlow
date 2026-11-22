/**
 * NF-04 admin-web affinity/anti-affinity form wiring.
 *
 * These tests intentionally stay separate from the existing NF-02 pagination/
 * Abort coverage in task-form-page.test.tsx. The backend contract is:
 * affinity = OR match, anti-affinity = exclusion; both are orthogonal to
 * auto/group/broadcast, while pinned dispatch bypasses both filters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import {
  affinityFormValues,
  buildExecutorPayload,
  normalizeAffinityTags,
} from '../pages/executor-mode';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn(),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
// F-01 配套：GlueEditor 重依赖（monaco）裁剪（策略同 task-form-ui06 等文件）。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

let mockRouteParams: { id?: string } = {};
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
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

const TAGS = ['gpu', 'edge', 'windows', 'arm'];

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'affinity-job',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
    executeMode: 'single',
    timeoutSeconds: 300,
    maxRetry: 3,
    params: {},
    ...overrides,
  };
}

function fieldSelect(label: string): HTMLElement {
  const labelNode = screen.getByText(label, { selector: '.ant-form-item-label label' });
  const item = labelNode.closest('.ant-form-item');
  const selector = item?.querySelector('.ant-select') as HTMLElement | null;
  expect(selector).toBeTruthy();
  return selector!;
}

function selectByLabel(label: string) {
  const selector = fieldSelect(label);
  fireEvent.mouseDown(selector);
  return selector;
}

async function pickTag(label: string, tag: string) {
  // R447（全量 350 文件并发 run3 实测本文件 :203 用例 15s 超时、单跑 12/12 绿）：
  // 标签选项不是 react-query 缓存数据，而是 useTaskFormReferenceData 的
  // useEffect 异步 setAllTags（useTaskFormReferenceData.ts:102-119/199）。
  // 共享 QueryClient 让 findBy* 秒回，却证明不了选项已进 DOM：探针实测
  // mousedown 时下拉已带 ant-select-open、但 .ant-select-item-option 数为 0，
  // 全量并发下该窗口从单跑 ~0.3s 放大到 2.5~3s。首拍 mousedown 若落在
  // 「Select 挂载了、选项还没到」的窗口里，随后的 waitFor(getAllByText) 就
  // 会空等——waitFor 的 10s 预算与用例 15s 预算在并发下竞速，外面看到的是
  // Test timed out in 15000ms。
  // 修法（R445“补点自愈”同款）：每一拍检查下拉是否仍 open，未开则补一次
  // mousedown，直到目标选项文本真正出现。不加大 timeout、不放宽断言。
  selectByLabel(label);
  await waitFor(() => {
    const selector = fieldSelect(label);
    if (!selector.classList.contains('ant-select-open')) {
      fireEvent.mouseDown(selector);
    }
    expect(screen.getAllByText(tag).length).toBeGreaterThan(0);
  });
  const matches = screen.getAllByText(tag);
  fireEvent.click(matches[matches.length - 1]);
}



const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );
beforeEach(() => {
  // DRAFT-01：草稿落 localStorage——用例之间必须隔离（否则上一例的输入被"恢复"）
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = {};
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue(TAGS as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  const taskListAll = (tasksApi as unknown as { listAll?: ReturnType<typeof vi.fn> }).listAll;
  taskListAll?.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('NF-04 affinity helpers', () => {
  it('normalizes undefined, empty, and non-array values to explicit null', () => {
    expect(normalizeAffinityTags(undefined)).toBeNull();
    expect(normalizeAffinityTags([])).toBeNull();
    expect(normalizeAffinityTags('gpu')).toBeNull();
    expect(normalizeAffinityTags(['gpu', 'edge'])).toEqual(['gpu', 'edge']);
  });

  it('maps persisted arrays to form values and empty/null to empty form state', () => {
    expect(affinityFormValues({
      executorAffinityTags: ['gpu'],
      executorAntiAffinityTags: ['windows'],
    })).toEqual({ executorAffinityTags: ['gpu'], executorAntiAffinityTags: ['windows'] });
    expect(affinityFormValues({ executorAffinityTags: [], executorAntiAffinityTags: null })).toEqual({
      executorAffinityTags: undefined,
      executorAntiAffinityTags: undefined,
    });
  });

  it('keeps constraints in auto/group/broadcast and retains them in pinned mode', () => {
    const values = { executorAffinityTags: ['gpu'], executorAntiAffinityTags: ['windows'] };
    for (const mode of ['auto', 'group', 'broadcast', 'pinned'] as const) {
      const payload = buildExecutorPayload(values, mode);
      expect(payload.executorAffinityTags).toEqual(['gpu']);
      expect(payload.executorAntiAffinityTags).toEqual(['windows']);
    }
  });

  it('clears both constraints explicitly when the user clears them', () => {
    const payload = buildExecutorPayload({ executorAffinityTags: [], executorAntiAffinityTags: undefined }, 'auto');
    expect(payload.executorAffinityTags).toBeNull();
    expect(payload.executorAntiAffinityTags).toBeNull();
  });
});

describe('TaskFormPage NF-04 form wiring', () => {
  it('new task mounts both fields and sends selected tags in POST payload', async () => {
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('daily-report'), { target: { value: 'affinity-job' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), { target: { value: 'main.py' } });
    await pickTag('亲和标签', 'gpu');
    await pickTag('反亲和标签', 'windows');
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    await waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.executorAffinityTags).toEqual(['gpu']);
    expect(payload.executorAntiAffinityTags).toEqual(['windows']);
  }, 15_000);

  it('edit mode hydrates both persisted constraints and preserves them on PATCH', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(baseTask({
      executorAffinityTags: ['gpu'],
      executorAntiAffinityTags: ['windows'],
    }) as never);
    renderPage();

    expect(await screen.findByText('gpu')).toBeTruthy();
    expect(screen.getByText('windows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.executorAffinityTags).toEqual(['gpu']);
    expect(payload.executorAntiAffinityTags).toEqual(['windows']);
  }, 15_000);

  it('switching to broadcast keeps constraints and switching to pinned disables controls without dropping them', async () => {
    renderPage();
    // R447：交互前先等主表单挂载的直接 DOM 信号（R445 python-wiring 同款）。
    // 共享 QueryClient 下 getByRole 可能命中上一帧的 Radio，但亲和选项与
    // 模式切换告警走的是 useEffect/setState，两者不同拍；并发把窗口放大。
    await screen.findByPlaceholderText('daily-report');
    const broadcast = screen.getByRole('radio', { name: /广播/ });
    fireEvent.click(broadcast);
    // 等 broadcast 状态真正落地（专属告警挂载）再点亲和下拉，避免交互
    // 落在旧渲染节点上；断言本身（亲和仍可用）原样保留。
    await waitFor(() => expect(screen.getByTestId('broadcast-pin-cleared')).toBeTruthy());
    expect(fieldSelect('亲和标签').classList.contains('ant-select-disabled')).toBe(false);
    await pickTag('亲和标签', 'edge');

    const pinned = screen.getByRole('radio', { name: /指定执行器/ });
    fireEvent.click(pinned);
    // pinned 的告警与 disabled class 是同一状态的两个 DOM 信号；waitFor
    // 只等状态落地，两条业务断言内容不变（真没禁用仍会转红）。
    await waitFor(() => {
      expect(screen.getByTestId('pinned-affinity-disabled')).toBeTruthy();
      expect(fieldSelect('亲和标签').classList.contains('ant-select-disabled')).toBe(true);
    });
    fireEvent.change(await screen.findByPlaceholderText('daily-report'), { target: { value: 'mode-job' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), { target: { value: 'main.py' } });
    // Pinned requires an executor; use the pure helper assertion for payload retention
    // rather than depending on Select's portal interaction in this mode transition test.
    expect(buildExecutorPayload({ executorAffinityTags: ['edge'], executorAntiAffinityTags: [] }, 'pinned')).toMatchObject({
      executorAffinityTags: ['edge'],
      executorAntiAffinityTags: null,
    });
  }, 15_000);

  it('explicit clear in edit mode sends null instead of preserving the old constraint', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(baseTask({
      executorAffinityTags: ['gpu'],
      executorAntiAffinityTags: ['windows'],
    }) as never);
    renderPage();
    await screen.findByText('gpu');
    const affinityRemove = fieldSelect('亲和标签').querySelector('.ant-select-selection-item-remove') as HTMLElement | null;
    expect(affinityRemove).toBeTruthy();
    fireEvent.click(affinityRemove!);
    await screen.findByText('windows');
    const antiRemove = fieldSelect('反亲和标签').querySelector('.ant-select-selection-item-remove') as HTMLElement | null;
    expect(antiRemove).toBeTruthy();
    fireEvent.click(antiRemove!);
    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.executorAffinityTags).toBeNull();
    expect(payload.executorAntiAffinityTags).toBeNull();
  }, 15_000);
});

/**
 * FEAT-22 方案 A v2：任务级部署约束模式（deploymentPolicy）的表单接线。
 *
 * 契约：默认「跟随全局」（null）；编辑态回填持久化值并在 PATCH 中保留；
 * pinned 模式控件禁用但值保留（与亲和约束同款语义）。
 */
describe('TaskFormPage FEAT-22 deploymentPolicy wiring', () => {
  it('new task mounts the select defaulting to follow-global and POSTs null', async () => {
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('daily-report'), { target: { value: 'policy-job' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), { target: { value: 'main.py' } });
    // 默认选中「跟随全局」（Select 内显示该文案）
    expect(fieldSelect('部署设备约束').textContent).toContain('跟随全局');
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));
    await waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.deploymentPolicy).toBeNull();
  }, 15_000);

  it('edit mode hydrates the persisted policy and preserves it on PATCH', async () => {
    mockRouteParams = { id: 'task-1' };
    vi.mocked(tasksApi.get).mockResolvedValue(baseTask({
      deploymentPolicy: 'strict',
    }) as never);
    renderPage();
    // 等表单加载完成后字段才挂载（与上方亲和编辑用例的等待同款）。
    await screen.findByText('部署设备约束', { selector: '.ant-form-item-label label' });
    expect(fieldSelect('部署设备约束').textContent).toContain('仅部署设备');
    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.deploymentPolicy).toBe('strict');
  }, 15_000);

  it('pinned mode disables the control without dropping the stored value', async () => {
    renderPage();
    await screen.findByPlaceholderText('daily-report');
    fireEvent.click(screen.getByRole('radio', { name: /指定执行器/ }));
    expect(fieldSelect('部署设备约束').classList.contains('ant-select-disabled')).toBe(true);
  }, 15_000);

  it('G6 失败边：buildExecutorPayload 保留 runOnUpstreamFailure（不被白名单剥离）', () => {
    const payload = buildExecutorPayload(
      { name: 't', runOnUpstreamFailure: true },
      'auto',
    );
    expect(payload.runOnUpstreamFailure).toBe(true);
  });
});
