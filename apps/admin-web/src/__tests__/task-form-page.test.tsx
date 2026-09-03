/**
 * R7 (N19) admin-web 任务表单消费 tasks.executorId 回归测试。
 *
 * 覆盖两层：
 *  1) 纯逻辑 helper——deriveExecutorMode（加载态 mode 映射，executorId 命中→pinned）
 *     与 buildExecutorPayload（提交 payload：pinned 带 executorId、auto/broadcast 清 null）。
 *  2) 组件级——编辑态加载一个 executorId-pin 的任务后，推进到"触发 & 执行器"步骤，
 *     pinned 选择器（绑定 executorId）应渲染，证明加载映射真正接线到 UI。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TaskFormPage, {
  deriveExecutorMode,
  buildExecutorPayload,
} from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

// 隔离 api 层：底层 client 会拉起 axios 拦截器，测试只关心调用契约。
vi.mock('../api/tasks', () => ({ tasksApi: { get: vi.fn(), create: vi.fn(), update: vi.fn() } }));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'task-1' }),
  useSearchParams: () => [new URLSearchParams('')],
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）。
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

const PIN_UUID = '550e8400-e29b-41d4-a716-446655440000';

beforeEach(() => {
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([
    { id: PIN_UUID, appName: 'node-a', address: '10.0.0.1:3001', status: 'online' },
  ] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
});

describe('deriveExecutorMode（加载态 mode 映射，N19）', () => {
  it('executorId 命中 → pinned（优先于 executorAppName 旧语义）', () => {
    expect(deriveExecutorMode({ executorId: PIN_UUID, executorAppName: 'node-a' })).toBe('pinned');
    expect(deriveExecutorMode({ executorId: PIN_UUID })).toBe('pinned');
  });

  it('broadcast 优先于一切', () => {
    expect(deriveExecutorMode({ executeMode: 'broadcast', executorId: PIN_UUID })).toBe('broadcast');
  });

  it('仅 executorAppName（legacy）→ pinned', () => {
    expect(deriveExecutorMode({ executorAppName: 'node-a' })).toBe('pinned');
  });

  it('group/tags → group；全空 → auto', () => {
    expect(deriveExecutorMode({ executorGroup: 'g1' })).toBe('group');
    expect(deriveExecutorMode({ executorTags: ['t1'] })).toBe('group');
    expect(deriveExecutorMode({})).toBe('auto');
  });
});

describe('buildExecutorPayload（提交 payload，N19）', () => {
  it('pinned：保留 executorId、清空 legacy executorAppName', () => {
    const payload = buildExecutorPayload(
      { name: 't', executorId: PIN_UUID, executorAppName: 'node-a', executorGroup: 'g', executorTags: ['x'] },
      'pinned',
    );
    expect(payload.executorId).toBe(PIN_UUID);
    expect(payload.executeMode).toBe('single');
    expect(payload.executorAppName).toBeNull();
    expect('executorGroup' in payload).toBe(false);
    expect('executorTags' in payload).toBe(false);
  });

  it('auto：显式清除 executorId（避免 PATCH 保留旧 pin）', () => {
    const payload = buildExecutorPayload({ name: 't', executorId: PIN_UUID }, 'auto');
    expect(payload.executorId).toBeNull();
    expect(payload.executeMode).toBe('single');
    expect('executorAppName' in payload).toBe(false);
  });

  it('broadcast：executorId 置 null 且 executeMode=broadcast', () => {
    const payload = buildExecutorPayload({ name: 't', executorId: PIN_UUID }, 'broadcast');
    expect(payload.executorId).toBeNull();
    expect(payload.executeMode).toBe('broadcast');
  });

  it('不修改入参对象（纯函数）', () => {
    const values = { name: 't', executorId: PIN_UUID, executorGroup: 'g' };
    buildExecutorPayload(values, 'auto');
    expect(values.executorId).toBe(PIN_UUID);
    expect(values.executorGroup).toBe('g');
  });
});

describe('TaskFormPage 编辑态加载 executorId → pinned 选择器', () => {
  it('加载 executorId-pin 任务后，步骤 1 渲染绑定 executorId 的选择器', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'pinned-job',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      executeMode: 'single',
      executorId: PIN_UUID,
      timeoutSeconds: 300,
      maxRetry: 3,
      params: {},
    } as never);

    render(<TaskFormPage />);
    // 等待加载态结束（loadingTask=false 后步骤 0 表单出现）。
    const nextBtn = await screen.findByRole('button', { name: /下一步：调度配置/ });
    fireEvent.click(nextBtn);
    // 推进到步骤 1（触发 & 执行器）。
    const step1Next = await screen.findByRole('button', { name: /下一步：参数配置/ });
    expect(step1Next).toBeTruthy();
    // pinned 模式才会渲染绑定 executorId 的选择器；executorId 命中列表项时
    // Select 展示选中项 label（appName + address），而非占位文案。
    expect(await screen.findByText(/node-a/)).toBeTruthy();
  });
});
