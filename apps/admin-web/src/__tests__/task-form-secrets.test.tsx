/**
 * SEC-02 续（生产故障）：TaskFormPage 的凭据字段接线。
 *
 * 三件事必须同时成立，缺一条就会变成生产事故：
 *  ① 编辑态**显示**已有凭据的键名（用户必须看得见"已经配了 FEISHU_APP_ID"，
 *     否则会以为平台没生效而反复重配——本故障的起因）；
 *  ② 已有凭据**不进表单值**（表单值只表达"本次要写什么"）：不进才不会在
 *     "只改超时"的保存里被当成真实值回写；
 *  ③ 未触碰凭据 → 请求体里**没有** secrets 键（后端据此一个 secret 都不碰）。
 *
 * 反证形态：若有人把 `secrets: task.secrets` 写回 setFieldsValue（"顺手回填"），
 * ②③ 立即转红——那正是把掩码 `******` 当真实凭据落库的路径，真实值不可逆损毁，
 * 而界面上键还在、任务却报「缺少凭据」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
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

/** 读路径形态的任务：secrets 一律是掩码（真实值永不出后端）。 */
function taskWithSecrets(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'refund-sync',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
    executeMode: 'single',
    timeoutSeconds: 300,
    maxRetry: 3,
    params: {},
    secrets: { FEISHU_APP_ID: '******', FEISHU_APP_SECRET: '******' },
    ...overrides,
  };
}

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockRouteParams = { id: 'task-1' };
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  const listAll = (tasksApi as unknown as { listAll?: ReturnType<typeof vi.fn> }).listAll;
  listAll?.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
});

afterEach(() => cleanup());

describe('SEC-02 续: 任务表单的凭据字段', () => {
  it('① 编辑态显示已有凭据的键名（掩码值不外显为真实值）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(taskWithSecrets() as never);
    renderPage();
    await waitFor(() =>
      expect(screen.getByDisplayValue('FEISHU_APP_ID')).toBeTruthy(),
    );
    expect(screen.getByDisplayValue('FEISHU_APP_SECRET')).toBeTruthy();
    // 掩码本身不得出现在任何输入框的值里（它只表达"已保存"）
    const values = Array.from(document.querySelectorAll('input')).map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(values).not.toContain('******');
  });

  it('②③ 未触碰凭据 → PATCH 请求体不含 secrets（后端一个 secret 都不碰）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(taskWithSecrets() as never);
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('FEISHU_APP_ID')).toBeTruthy());

    fireEvent.click(screen.getByText(/保存更改|Save changes/));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalled());

    const body = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect('secrets' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('******');
  });

  it('① 无凭据的任务不显示任何已保存项（空态不误导）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(
      taskWithSecrets({ secrets: null }) as never,
    );
    renderPage();
    await waitFor(() => expect(tasksApi.get).toHaveBeenCalled());
    expect(screen.queryByDisplayValue('FEISHU_APP_ID')).toBeNull();
  });
});
