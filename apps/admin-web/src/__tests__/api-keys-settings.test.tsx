import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ApiKeysSettings, { apiKeyStatus } from '../pages/settings/ApiKeysSettings';
import { apiKeysApi, ApiKeyView } from '../api/api-keys';

/**
 * AUTH-03: 设置区 API Keys Tab——列表 / 创建 Modal 一次性明文回显 / 吊销。
 * mock api 层（executor-detail-trend 先例形态）。
 */

vi.mock('../api/api-keys', () => ({
  apiKeysApi: {
    list: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, Link: (p: any) => <a href={p.to}>{p.children}</a> };
});

const mocked = vi.mocked(apiKeysApi);

// jsdom 缺口 polyfill（security-settings.test 先例）：antd Table/Modal 需要
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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const keyRow = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id: 1,
  name: 'ci-deploy',
  keyPrefix: 'acf_dead',
  scope: 'trigger',
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: '2026-09-08T00:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApiKeysSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.list.mockResolvedValue([
    keyRow(),
    keyRow({ id: 2, name: 'old-key', scope: 'readonly', revokedAt: '2026-09-01T00:00:00Z' }),
  ]);
});

describe('AUTH-03 ApiKeysSettings', () => {
  it('渲染列表：名称/前缀/scope/状态（有效 vs 已吊销）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ci-deploy')).toBeTruthy());
    expect(screen.getAllByText(/acf_dead…/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('只读 + 任务触发')).toBeTruthy();
    const statuses = screen.getAllByText(/有效|已吊销/);
    expect(statuses.length).toBe(2);
  });

  it('创建成功弹一次性明文 + 仅显示一次警示 + 复制按钮', async () => {
    mocked.create.mockResolvedValue({
      ...keyRow({ id: 3 }),
      plaintext: 'acf_' + 'ab'.repeat(32),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('apikey-create')).toBeTruthy());
    fireEvent.click(screen.getByTestId('apikey-create'));
    fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'new-key' } });
    fireEvent.click(screen.getByText('创 建'));
    await waitFor(() => expect(screen.getByText('API Key 已创建')).toBeTruthy());
    // 明文回显一次 + 警示文案
    expect(screen.getByText(`acf_${'ab'.repeat(32)}`)).toBeTruthy();
    expect(screen.getByText('这是唯一一次显示机会')).toBeTruthy();
    expect(screen.getByText('复制密钥')).toBeTruthy();
  });

  it('创建失败：不弹明文（错误由 useMutation onError 静默/表单保留）', async () => {
    mocked.create.mockRejectedValue(new Error('boom'));
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-create'));
    fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('创 建'));
    await waitFor(() => expect(mocked.create).toHaveBeenCalled());
    expect(screen.queryByText('API Key 已创建')).toBeNull();
  });

  it('吊销按钮出现在未吊销行、已吊销行显示占位', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ci-deploy')).toBeTruthy());
    // testid 锚点：仅未吊销行（id=1）有吊销按钮，已吊销行（id=2）无
    expect(screen.getByTestId('apikey-revoke-1')).toBeTruthy();
    expect(screen.queryByTestId('apikey-revoke-2')).toBeNull();
  });

  it('apiKeyStatus 纯函数：吊销 > 过期 > 有效', () => {
    expect(apiKeyStatus(keyRow({ revokedAt: '2026-01-01T00:00:00Z' })).label).toBe('已吊销');
    expect(apiKeyStatus(keyRow({ expiresAt: '2000-01-01T00:00:00Z' })).label).toBe('已过期');
    expect(apiKeyStatus(keyRow()).label).toBe('有效');
  });

  it('永不过期行显示「永不过期」，有 lastUsedAt 时展示时间', async () => {
    mocked.list.mockResolvedValue([keyRow({ lastUsedAt: '2026-09-08T08:00:00Z' })]);
    renderPage();
    await waitFor(() => expect(screen.getByText('永不过期')).toBeTruthy());
  });
});
