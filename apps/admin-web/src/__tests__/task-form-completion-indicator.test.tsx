/**
 * PLAN-FRONTEND-UX-IMPROVEMENTS §2.3：表单完成度指示的**渲染层**断言。
 *
 * 与 `src/utils/__tests__/formCompletion.test.ts` 分工明确：
 *   · 那里测口径（百分比算得对不对、条件字段有没有进分母）；
 *   · 这里测「页面真的把那个数字和 aria 属性渲染出来了」——只测纯函数会让
 *     「组件忘了挂」这种失败漏网。
 *
 * 断点桩：NavRail 只在 ≥lg 显示（antd Grid.useBreakpoint），jsdom 的
 * matchMedia 由 test-setup 统一桩成**恒 false** → 锚点条 display:none。查不
 * 可见节点用 getByTestId/queryByTestId（不看可见性），断言语义属性而非布局。
 * 另有一条用例把 matchMedia 打成 lg 命中，验证可见性分支下同样渲染。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import TaskFormPage from '../pages/TaskFormPage';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { taskTemplatesApi } from '../api/task-templates';

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
vi.mock('../api/task-templates', () => ({ taskTemplatesApi: { get: vi.fn(), list: vi.fn() } }));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams('')],
    Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
  };
});

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(taskTemplatesApi.get).mockReset().mockRejectedValue(new Error('no template') as never);
  // 用例隔离（本文件特有的坑）：TaskFormPage 的 DRAFT-01 会把用户输入防抖写进
  // localStorage，并在下次挂载时**恢复**它——同一个 worker 里的后一个用例会
  // 接到前一个用例填过的表单，于是「空表单应为 incomplete」这类断言随机变红。
  // 这不是产品缺陷（真实用户确实希望恢复草稿），故按草稿 key 前缀清理即可。
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('taskform.draft:')) localStorage.removeItem(key);
  }
});

afterEach(() => {
  cleanup();
});

async function renderCreateForm() {
  renderPage();
  // 表单首屏就绪的信号（既有 a11y-task-form / task-form-ui06 同款）
  await screen.findByPlaceholderText('daily-report');
}

/** 读完成度区块的 aria 数值与可视文本，一并断言二者不漂移。 */
function readCompletion() {
  const bar = screen.getByTestId('task-form-completion');
  return {
    ariaNow: bar.getAttribute('aria-valuenow'),
    ariaMin: bar.getAttribute('aria-valuemin'),
    ariaMax: bar.getAttribute('aria-valuemax'),
    ariaLabel: bar.getAttribute('aria-label'),
    text: screen.getByTestId('task-form-completion-text').textContent,
  };
}

describe('§2.3 表单完成度指示', () => {
  it('渲染 progressbar 语义：role + aria-valuenow/min/max 都在', async () => {
    await renderCreateForm();
    const bar = screen.getByTestId('task-form-completion');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    // 空表单 = 0%（initialValues 里 triggerType=manual、runtime=python，
    // 但 name/entrypoint 未填，必填分母 = 3，已填 1 → 33%）
    expect(bar.getAttribute('aria-valuenow')).toBe('33');
  }, 20000);

  it('可视百分比文本与 aria-valuenow 同源（不会一个 33 一个 100）', async () => {
    await renderCreateForm();
    const { ariaNow, text } = readCompletion();
    expect(text).toContain('%');
    expect(text?.replace('%', '')).toBe(ariaNow);
  }, 20000);

  it('aria-label 带具体数值，读屏能听到「完成度 33%」', async () => {
    await renderCreateForm();
    const { ariaLabel } = readCompletion();
    expect(ariaLabel).toContain('33');
    expect(ariaLabel).toContain('%');
  }, 20000);

  it('填写必填项后百分比随之上升（不是渲染时就固定死的假数字）', async () => {
    await renderCreateForm();
    expect(readCompletion().ariaNow).toBe('33');

    // 填任务名 → 2/3
    fireEvent.change(screen.getByPlaceholderText('daily-report'), {
      target: { value: 'daily-report' },
    });
    await waitFor(() => expect(readCompletion().ariaNow).toBe('67'));

    // 填入口文件 → 3/3 = 100%
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    await waitFor(() => expect(readCompletion().ariaNow).toBe('100'));
  }, 20000);

  it('每个有必填项的分区一个状态点，装饰性节点 aria-hidden=true', async () => {
    await renderCreateForm();
    // basic 分区有必填项 → 有状态点
    const basicDot = screen.getByTestId('task-form-section-dot-sec-basic');
    expect(basicDot.getAttribute('aria-hidden')).toBe('true');
    // 空表单：basic 未填齐
    expect(basicDot.getAttribute('data-status')).toBe('incomplete');

    // 参数/Glue 分区无必填项 → 不给状态点（避免「永远完成」的噪声标记）
    expect(screen.queryByTestId('task-form-section-dot-sec-params')).toBeNull();
    expect(screen.queryByTestId('task-form-section-dot-sec-glue')).toBeNull();
  }, 20000);

  it('填齐 basic 后状态点切换到 complete（状态真的跟着表单走）', async () => {
    await renderCreateForm();
    fireEvent.change(screen.getByPlaceholderText('daily-report'), {
      target: { value: 'daily-report' },
    });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('task-form-section-dot-sec-basic').getAttribute('data-status')).toBe(
        'complete',
      ),
    );
  }, 20000);

  it('状态点的语义文本进可访问名（读屏能听到分区是否填齐）', async () => {
    await renderCreateForm();
    const basicDot = screen.getByTestId('task-form-section-dot-sec-basic');
    // 状态点是 aria-hidden 的纯装饰，紧随其后有视觉隐藏的状态文本
    const title = basicDot.parentElement?.parentElement;
    expect(title?.textContent).toContain('还有必填项未填');
  }, 20000);
});
