/**
 * U1 回归：SSE 建流基址必须与 axios API 同源（页面内部复用 client.ts getApiBaseUrl，
 * 含 localStorage 内/外网开关 autoflow_use_external_api）。
 * 旧实现恒优先 VITE_API_URL_EXTERNAL → 双地址配置时内网环境 SSE 永远打外网。
 * 断言方式：stubEnv 双地址 + 渲染页面捕获 EventSource URL，与 getApiBaseUrl() 对照。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const INTERNAL = 'http://internal.test:3105';
const EXTERNAL = 'https://external.test/api';

// 隔离 api 层：页面只需 execution 返回非终态即可触发 SSE 效果。
// CORE-02: 详情页新增消费 get / executionsWithStatus——mock 补齐防 TypeError。
vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executionsWithStatus: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 task-form-page.test 先例）。
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

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

// stubEnv 后必须 resetModules + 动态 import：client.ts 在模块初始化时捕获 env 常量。
// 返回 EventSource 实际建流 URL 与同模块图内的 getApiBaseUrl()。
async function openSseWithToggle(useExternal: boolean): Promise<{ url: string; apiBase: string }> {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('autoflow_use_external_api', String(useExternal));

  // 与页面同一模块图：resetModules 后先取 tasksApi mock 再 import 页面。
  const { tasksApi } = await import('../api/tasks');
  vi.mocked(tasksApi.execution).mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status: 'running',
    triggerType: 'manual',
    createdAt: new Date().toISOString(),
  } as never);
  // CORE-02: 详情页新增消费——本套件不关注，空实现即可。
  vi.mocked(tasksApi.get).mockResolvedValue({ id: 't1', maxRetry: 3, retryDelay: 5 } as never);
  vi.mocked(tasksApi.executionsWithStatus).mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'running' }], total: 1, page: 1, pageSize: 100,
  } as never);
  const { useAuthStore } = await import('../store/auth');
  useAuthStore.getState().setAuth('tok-123', 'refresh-1', { id: 1, username: 'admin' });
  const { getApiBaseUrl } = await import('../api/client');
  const { default: ExecutionDetailPage } = await import('../pages/ExecutionDetailPage');

  render(
    <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
      <Routes>
        <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  return { url: FakeEventSource.instances[0].url, apiBase: getApiBaseUrl() };
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL_INTERNAL', INTERNAL);
  vi.stubEnv('VITE_API_URL_EXTERNAL', EXTERNAL);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('ExecutionDetailPage SSE 与 API 同源（U1）', () => {
  // 冷启动下动态 import 整页（antd 等）可能超过默认 5s，放宽超时。
  it('内网开关关闭：EventSource 连内网 base（旧实现会错打外网）', async () => {
    const { url, apiBase } = await openSseWithToggle(false);
    expect(apiBase).toBe(INTERNAL);
    expect(url.startsWith(`${INTERNAL}/tasks/t1/executions/e1/logs/stream`)).toBe(true);
    expect(url).not.toContain(EXTERNAL);
    expect(url).toContain('access_token=tok-123');
  }, 30_000);

  it('外网开关开启：EventSource 随 getApiBaseUrl 切到外网 base', async () => {
    const { url, apiBase } = await openSseWithToggle(true);
    expect(apiBase).toBe(EXTERNAL);
    expect(url.startsWith(`${EXTERNAL}/tasks/t1/executions/e1/logs/stream`)).toBe(true);
    expect(url).not.toContain(INTERNAL);
  }, 30_000);
});
