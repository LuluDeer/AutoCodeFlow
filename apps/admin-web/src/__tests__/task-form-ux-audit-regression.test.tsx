/**
 * 本轮 admin-web UX 审计的三处**已证实**缺陷的反证回归（组件级）。
 *
 * 与纯函数单测的分工：这三处的根因都在"纯逻辑层的产物没有被正确接到
 * UI/提交链上"，只有组件级用例能拦住（纯函数本身是对的）。每条用例都在
 * 修复前实测为红、修复后实测为绿。
 *
 *  D1 fixed_rate 非 60 整数倍：聚焦后失焦即被静默改写（90s → 60s）
 *  D2 编辑态告警配置（alarmEmail/alarmChannels）不回填 → 改个无关字段保存即清空
 *  D3 「保存为模板」丢掉上游依赖（NF-02 dependencies 映射）
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
import { taskTemplatesApi } from '../api/task-templates';

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
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));
// F-01 配套：GlueEditor 重依赖（monaco）裁剪（策略同 task-form-page.test 先例）。
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
const APP_ID = '11111111-2222-3333-4444-555555555555';



const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );
beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([
    { id: APP_ID, name: 'zip-app', runtime: 'python' },
  ] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [{ id: UPSTREAM_ID, name: 'upstream-job' }], total: 1, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
  vi.mocked(taskTemplatesApi.create).mockReset().mockResolvedValue({ id: 'tpl-1' } as never);
});

afterEach(() => { cleanup(); });

// ── D1 ─────────────────────────────────────────────────────────────────────
describe('D1 fixed_rate 非 60 整数倍不得被静默改写', () => {
  it('fixedRate=90s：聚焦后失焦（未改字符）仍提交 90，不是 60', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'fixed-task',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'fixed_rate',
      fixedRate: 90, // ← 非 60 整数倍：展示为「1 分钟」
      timeoutSeconds: 300,
      maxRetry: 3,
      params: {},
    } as never);

    renderPage();
    await screen.findByDisplayValue('fixed-task');

    const input = itemByLabel(/执行间隔/).querySelector('input') as HTMLInputElement;
    // 展示侧：90s 向下取整为 1 分钟（formatter 语义，不是缺陷）
    expect(input.value).toBe('1 分钟');

    // 用户没改一个字符，只是点进输入框又点走（极常见的"看看配置"动作）
    fireEvent.focus(input);
    fireEvent.blur(input);

    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    // 反证点：修复前这里是 60（展示文本被回读成 1×60），用户的 90s 间隔丢了
    expect(payload.fixedRate).toBe(90);
  }, 30_000);

  it('用户真的改了分钟数时采纳新值（不得为了保原值而吞掉改动）', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1', name: 'fixed-task2', runtime: 'python', entrypoint: 'main.py',
      triggerType: 'fixed_rate', fixedRate: 90, timeoutSeconds: 300, maxRetry: 3, params: {},
    } as never);

    renderPage();
    await screen.findByDisplayValue('fixed-task2');

    const input = itemByLabel(/执行间隔/).querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);

    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.fixedRate).toBe(300);
  }, 30_000);
});

// ── D2 ─────────────────────────────────────────────────────────────────────
describe('D2 编辑态回填告警配置（alarmEmail / alarmChannels）', () => {
  it('编辑页渲染出任务已配的告警接收人与渠道', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1', name: 'alarm-task', runtime: 'python', entrypoint: 'main.py',
      triggerType: 'manual', timeoutSeconds: 300, maxRetry: 3, params: {},
      alarmEmail: 'ops@example.com',
      alarmChannels: ['email', 'slack'],
    } as never);

    renderPage();
    await screen.findByDisplayValue('alarm-task');
    await waitFor(() => expect(executorsApi.list).toHaveBeenCalled());

    const emailInput = itemByLabel(/告警邮件接收人/).querySelector('input') as HTMLInputElement;
    // 反证点：修复前这里是 ''（Task 接口未声明该字段 → 永远回填不了）
    expect(emailInput.value).toBe('ops@example.com');

    const ch = itemByLabel(/告警渠道/).querySelector('.ant-select') as HTMLElement;
    const chips = Array.from(ch.querySelectorAll('.ant-select-selection-item-content')).map(
      (el) => el.textContent,
    );
    expect(chips).toContain('邮件');
    expect(chips).toContain('Slack');
  }, 30_000);

  it('改个无关字段保存：告警配置原样保留（不因空态被清掉）', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1', name: 'alarm-task2', runtime: 'python', entrypoint: 'main.py',
      triggerType: 'manual', timeoutSeconds: 300, maxRetry: 3, params: {},
      alarmEmail: 'ops@example.com',
      alarmChannels: ['email'],
    } as never);

    renderPage();
    await screen.findByDisplayValue('alarm-task2');

    // 用户只改超时，完全没碰告警区
    const to = itemByLabel(/超时时间/).querySelector('input') as HTMLInputElement;
    fireEvent.change(to, { target: { value: '600' } });

    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    // 反证点：修复前两项都是 undefined（键缺失），保存即"清空"
    expect(payload.alarmEmail).toBe('ops@example.com');
    expect(payload.alarmChannels).toEqual(['email']);
  }, 30_000);
});

// ── D3 ─────────────────────────────────────────────────────────────────────
describe('D3 「保存为模板」固化上游依赖（NF-02）', () => {
  it('选中上游依赖后存模板：config.dependencies 携带映射，且不带载体键', async () => {
    mockRouteParams = {}; // 创建态（保存为模板只在创建态提供）
    renderPage();
    await screen.findByPlaceholderText('daily-report');
    fireEvent.change(screen.getByPlaceholderText('daily-report'), { target: { value: 'dep-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), { target: { value: 'main.py' } });

    const depSel = itemByLabel(/上游依赖/).querySelector('.ant-select') as HTMLElement;
    fireEvent.mouseDown(depSel);
    const opt = await screen.findByText('upstream-job', {
      selector: '.ant-select-item-option-content',
    });
    fireEvent.click(opt);

    fireEvent.click(screen.getByTestId('save-as-template'));
    await screen.findByTestId('tpl-name-input');
    fireEvent.change(screen.getByTestId('tpl-name-input'), { target: { value: '依赖模板' } });
    fireEvent.click(screen.getByTestId('tpl-save-confirm'));

    await waitFor(() => expect(taskTemplatesApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(taskTemplatesApi.create).mock.calls[0][0];
    const config = payload.config as Record<string, unknown>;
    // 反证点：修复前 dependencies 恒为 undefined（表单载体键不在 DTO 里，
    // 模板路径没走 applyDependenciesPayload 归一）
    expect(config.dependencies).toEqual({ [UPSTREAM_ID]: 'upstream-job' });
    // 载体键绝不能进 config：CreateTaskDto 未声明，后端 forbidNonWhitelisted 会 400
    expect(Object.keys(config)).not.toContain('upstreamDependencies');
  }, 30_000);
});
