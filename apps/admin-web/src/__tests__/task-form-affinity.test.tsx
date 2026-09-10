/**
 * NF-04 admin-web affinity/anti-affinity form wiring.
 *
 * These tests intentionally stay separate from the existing NF-02 pagination/
 * Abort coverage in task-form-page.test.tsx. The backend contract is:
 * affinity = OR match, anti-affinity = exclusion; both are orthogonal to
 * auto/group/broadcast, while pinned dispatch bypasses both filters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
  selectByLabel(label);
  await waitFor(() => expect(screen.getAllByText(tag).length).toBeGreaterThan(0));
  const matches = screen.getAllByText(tag);
  fireEvent.click(matches[matches.length - 1]);
}

beforeEach(() => {
  mockRouteParams = {};
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue(TAGS as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.list).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 500 } as never);
  const taskListAll = (tasksApi as unknown as { listAll?: ReturnType<typeof vi.fn> }).listAll;
  taskListAll?.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
});

afterEach(() => cleanup());

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
    render(<TaskFormPage />);
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
    render(<TaskFormPage />);

    expect(await screen.findByText('gpu')).toBeTruthy();
    expect(screen.getByText('windows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.executorAffinityTags).toEqual(['gpu']);
    expect(payload.executorAntiAffinityTags).toEqual(['windows']);
  }, 15_000);

  it('switching to broadcast keeps constraints and switching to pinned disables controls without dropping them', async () => {
    render(<TaskFormPage />);
    const broadcast = screen.getByRole('radio', { name: /广播/ });
    fireEvent.click(broadcast);
    expect(fieldSelect('亲和标签').classList.contains('ant-select-disabled')).toBe(false);
    await pickTag('亲和标签', 'edge');

    const pinned = screen.getByRole('radio', { name: /指定执行器/ });
    fireEvent.click(pinned);
    expect(screen.getByTestId('pinned-affinity-disabled')).toBeTruthy();
    expect(fieldSelect('亲和标签').classList.contains('ant-select-disabled')).toBe(true);
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
    render(<TaskFormPage />);
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
