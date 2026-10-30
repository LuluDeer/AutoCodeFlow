/**
 * G6 依赖别名可见性（组件级反证）。
 *
 * 缺口（改动前）：`dependencies` 的 key 就是下游脚本 `$upstream("别名")` 认的
 * 键，但依赖区只显示候选任务的**当前**名——用户看不到存的是哪个别名：
 *   ① 上游改名后已存 key 不刷新（`$upstream("新名")` 运行期 null），界面无提示；
 *   ② 两个上游同名时后者 key 静默降级为 taskId，用户以为 `$upstream("名字")` 能取到。
 *
 * 本轮只做「可见 + 提示」（不改 key、不改提交载荷）。反证方式：把
 * `buildDependencyAliasRows` 的 drifted / duplicateName 判据去掉（或把别名行
 * 整块删掉），下面用例立刻红——它们断言的是**用户能看见的那段文本**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn(),
    listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
// 组件级测试不加载真实 monaco（同 task-form-ux-audit-regression 先例）。
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
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/** 按可见 label 定位 antd Form.Item（label 含 Tooltip 图标时 textContent 有后缀） */
function itemByLabel(re: RegExp): HTMLElement {
  const items = Array.from(document.querySelectorAll('.ant-form-item')) as HTMLElement[];
  const hit = items.find((it) => {
    const label = it.querySelector('.ant-form-item-label') as HTMLElement | null;
    return !!label && re.test(label.textContent ?? '');
  });
  if (!hit) {
    throw new Error(
      `未找到字段：${re}（现有：${items
        .map((i) => i.querySelector('.ant-form-item-label')?.textContent)
        .join(' | ')}）`,
    );
  }
  return hit;
}

const UPSTREAM_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UPSTREAM2_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const SELF_ID = 'task-1';

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

/** 依赖区只读别名行（顺序 = 选择顺序）。 */
const aliasRows = () =>
  Array.from(document.querySelectorAll('[data-testid="dependency-alias-row"]')) as HTMLElement[];

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: SELF_ID };
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: SELF_ID } as never);
});

afterEach(() => { cleanup(); });

describe('G6 ① 已选依赖显示只读别名（dependencies 的 key）', () => {
  it('编辑态：别名行展示已存 key，与上游当前名一致时不报漂移', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: SELF_ID,
      name: 'downstream-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      // 已存依赖映射：key=显示名快照（= $upstream 的别名），value=上游 id
      dependencies: { 'stable-upstream': UPSTREAM_ID },
    } as never);
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [{ id: UPSTREAM_ID, name: 'stable-upstream' }], total: 1, page: 1, pageSize: 100,
    } as never);

    renderPage();
    await screen.findByDisplayValue('downstream-task');

    await waitFor(() => expect(aliasRows().length).toBe(1));
    const row = aliasRows()[0];
    expect(row.getAttribute('data-alias')).toBe('stable-upstream');
    // 只读别名：明确写出脚本里的取数形态
    expect(row.querySelector('[data-testid="dependency-alias-value"]')?.textContent)
      .toContain('别名：stable-upstream');
    expect(row.textContent).toContain('$upstream("stable-upstream")');
    // 反证点：名字与别名一致，不得误报漂移/同名
    expect(row.querySelector('[data-testid="dependency-alias-drift"]')).toBeNull();
    expect(row.querySelector('[data-testid="dependency-alias-duplicate"]')).toBeNull();
  }, 30_000);
});

describe('G6 ② 改名漂移提示（key ≠ 上游当前名）', () => {
  it('别名仍是旧名、上游当前名已变 → 行内 Warning 提示「新名取不到」', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: SELF_ID,
      name: 'downstream-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      // 存的是旧名，上游现在叫 renamed-upstream
      dependencies: { 'legacy-upstream': UPSTREAM_ID },
    } as never);
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [{ id: UPSTREAM_ID, name: 'renamed-upstream' }], total: 1, page: 1, pageSize: 100,
    } as never);

    renderPage();
    await screen.findByDisplayValue('downstream-task');

    const drift = await waitFor(() => {
      const el = document.querySelector('[data-testid="dependency-alias-drift"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // 反证点：改动前这里没有提示（用户不知道 $upstream("新名") 会 null）
    expect(drift.textContent).toContain('renamed-upstream');
    expect(drift.textContent).toContain('legacy-upstream');
    expect(drift.textContent).toContain('$upstream("renamed-upstream") 取不到');
    // 别名本身仍是旧名（**不自动改名**）
    expect(aliasRows()[0].getAttribute('data-alias')).toBe('legacy-upstream');
    expect(aliasRows()[0].textContent).toContain('别名：legacy-upstream');
  }, 30_000);

  it('保存后提交的 dependencies 仍是旧名 key（只提示、不改行为）', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: SELF_ID,
      name: 'downstream-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      dependencies: { 'legacy-upstream': UPSTREAM_ID },
    } as never);
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [{ id: UPSTREAM_ID, name: 'renamed-upstream' }], total: 1, page: 1, pageSize: 100,
    } as never);

    renderPage();
    await screen.findByDisplayValue('downstream-task');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="dependency-alias-drift"]')).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    // 关键：载荷与改动前完全一致（key 仍是旧名，value 仍是 id）
    expect(payload.dependencies).toEqual({ 'legacy-upstream': UPSTREAM_ID });
  }, 30_000);
});

describe('G6 ③ 同名冲突提示（别名将退化为任务 ID）', () => {
  const sameNameTask = (id: string) => ({
    id,
    name: 'duplicate-upstream',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
  });

  it('候选下拉标出「同名，别名将退化为任务 ID」', async () => {
    mockRouteParams = {}; // 创建态：依赖候选全部来自 listAll
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [
        { id: UPSTREAM_ID, name: 'duplicate-upstream' },
        { id: UPSTREAM2_ID, name: 'duplicate-upstream' },
        { id: 'cccccccc-dddd-eeee-ffff-000000000000', name: 'unique-upstream' },
      ], total: 3, page: 1, pageSize: 100,
    } as never);

    renderPage();
    await screen.findByPlaceholderText('daily-report');

    const depSel = itemByLabel(/上游依赖/).querySelector('.ant-select') as HTMLElement;
    fireEvent.mouseDown(depSel);

    // 同名候选各带一枚提示 Tag（唯名的那个不带）
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="dependency-option-duplicate"]').length).toBe(2),
    );
    const tags = Array.from(
      document.querySelectorAll('[data-testid="dependency-option-duplicate"]'),
    ) as HTMLElement[];
    for (const tag of tags) expect(tag.textContent).toContain('同名，别名将退化为任务 ID');

    // Tag 不破坏选项文本契约（F-11 的 ellipsis span 仍是纯任务名）
    const nameSpan = screen.getByText('unique-upstream', {
      selector: '.ant-select-item-option-content span',
    });
    expect(nameSpan).toBeTruthy();
  }, 30_000);

  it('选中两个同名上游 → 已选区提示，后者的别名退化为任务 ID', async () => {
    mockRouteParams = {};
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [sameNameTask(UPSTREAM_ID), sameNameTask(UPSTREAM2_ID)],
      total: 2, page: 1, pageSize: 100,
    } as never);

    renderPage();
    await screen.findByPlaceholderText('daily-report');

    const depSel = itemByLabel(/上游依赖/).querySelector('.ant-select') as HTMLElement;
    fireEvent.mouseDown(depSel);
    const options = await waitFor(() => {
      const list = Array.from(document.querySelectorAll('.ant-select-item-option')) as HTMLElement[];
      expect(list.length).toBe(2);
      return list;
    });
    // 依次选中两个同名候选（先到者保留名字形态的别名）
    fireEvent.click(options[0]);
    fireEvent.click(options[1]);

    await waitFor(() => expect(aliasRows().length).toBe(2));
    const [first, second] = aliasRows();
    // 先到者：别名 = 名字，并提示同名（名字形态的 key 已被占用）
    expect(first.getAttribute('data-alias')).toBe('duplicate-upstream');
    expect(first.textContent).toContain('别名：duplicate-upstream');
    expect(first.querySelector('[data-testid="dependency-alias-duplicate"]')?.textContent)
      .toContain('同名，别名将退化为任务 ID');
    // 后者：别名退化为任务 ID，且明说只能用 id 形态引用
    expect(second.getAttribute('data-alias')).toBe(UPSTREAM2_ID);
    expect(second.querySelector('[data-testid="dependency-alias-value"]')?.textContent)
      .toContain('已退化为任务 ID');
    expect(second.querySelector('[data-testid="dependency-alias-duplicate"]')).not.toBeNull();
  }, 30_000);
});
