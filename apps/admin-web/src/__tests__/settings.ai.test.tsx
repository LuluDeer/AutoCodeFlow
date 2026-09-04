/**
 * R6 settings 页 AI 区块降级测试：
 * GET/POST /ai/config 收紧为 ADMIN-only 后，非管理员访问「AI 配置」Tab 必须
 * 降级为只读提示——不发起会 403 的 GET 请求、不渲染配置表单；
 * 管理员则正常发起查询并渲染表单。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsPage from '../pages/settings/index';
import { aiApi } from '../api/ai';
import { useAuthStore } from '../store/auth';

// 隔离 api 层：settings 页会 import configApi/aiApi（其底层 client 会拉起 axios 拦截器）
vi.mock('../api/ai', () => ({
  aiApi: {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    testConfig: vi.fn(),
    analyzeApp: vi.fn(),
    suggestSchedule: vi.fn(),
  },
}));
vi.mock('../api/config', () => ({
  configApi: {
    findAll: vi.fn().mockResolvedValue([]),
    getExecutorToken: vi.fn().mockResolvedValue({ hasToken: false, token: null }),
    generateExecutorToken: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    rollback: vi.fn(),
    getHistory: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐
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

const fakeAiConfig = {
  provider: 'disabled' as const,
  openaiModel: '',
  openaiBaseUrl: '',
  ollamaHost: '',
  ollamaModel: '',
  hasApiKey: false,
};

beforeEach(() => {
  vi.mocked(aiApi.getConfig).mockReset().mockResolvedValue(fakeAiConfig as never);
  useAuthStore.setState({ user: null });
});

afterEach(() => {
  cleanup();
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('settings 页 AI 配置区块（R6 ADMIN-only 降级）', () => {
  it('非管理员：AI Tab 降级为只读提示，不发起 GET /ai/config，不渲染表单', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderSettings();
    // 非管理员下 AI 是首个 Tab，默认激活
    expect(await screen.findByText('仅管理员可查看和配置 AI 分析')).toBeTruthy();
    expect(screen.queryByText('保存配置')).toBeNull();
    expect(screen.queryByText('AI 提供商')).toBeNull();
    expect(aiApi.getConfig).not.toHaveBeenCalled();
  });

  it('管理员：正常发起 GET /ai/config 并渲染配置表单', async () => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    renderSettings();
    // 管理员首个 Tab 是执行器 Token，需切到 AI 配置
    fireEvent.click(screen.getByText('AI 配置'));
    await waitFor(() => expect(aiApi.getConfig).toHaveBeenCalled());
    expect(await screen.findByText('保存配置')).toBeTruthy();
  });
});
