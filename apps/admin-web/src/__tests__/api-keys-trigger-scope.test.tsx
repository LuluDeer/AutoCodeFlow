import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ApiKeysSettings from '../pages/settings/ApiKeysSettings';
import { apiKeysApi, ApiKeyView } from '../api/api-keys';

/**
 * A-14（R3-A 审计）: task:trigger 扩展域前端入口——scope=trigger 时展示
 * 「同时允许 task:trigger」附加勾选，创建载荷透传 scopes='task:trigger'；
 * 未勾选 / 其他 scope 不传该字段（后端 DTO 按无扩展域处理，零行为变化）。
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
  return { ...actual, Link: (p: { to: string; children: React.ReactNode }) => <a href={p.to}>{p.children}</a> };
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

/** 打开创建 Modal 并把 scope 切到 trigger。 */
async function openModalWithTriggerScope() {
  renderPage();
  fireEvent.click(await screen.findByTestId('apikey-create'));
  fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'ci-key' } });
  // antd Select（v5）：在 combobox 上 mouseDown 展开下拉，再点选 trigger 选项
  const combobox = await screen.findByRole('combobox');
  fireEvent.mouseDown(combobox);
  fireEvent.click(await screen.findByText('只读 + 任务触发（CI/CD 推荐）'));
  await waitFor(() => expect(screen.getByTestId('apikey-task-trigger')).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.list.mockResolvedValue([keyRow()]);
});

describe('A-14 task:trigger 扩展域勾选', () => {
  it('scope=trigger 时展示附加勾选；勾选后载荷透传 scopes="task:trigger"', async () => {
    mocked.create.mockResolvedValue({
      ...keyRow({ id: 3 }),
      plaintext: 'acf_' + 'ab'.repeat(32),
    });
    await openModalWithTriggerScope();

    fireEvent.click(screen.getByTestId('apikey-task-trigger'));
    fireEvent.click(screen.getByText('创 建'));

    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
    expect(mocked.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ci-key', scope: 'trigger', scopes: 'task:trigger' }),
    );
  });

  it('scope=trigger 但未勾选 → 载荷不含 scopes（后端按 null 处理）', async () => {
    mocked.create.mockResolvedValue({
      ...keyRow({ id: 3 }),
      plaintext: 'acf_' + 'ab'.repeat(32),
    });
    await openModalWithTriggerScope();

    // 不勾选，直接提交
    fireEvent.click(screen.getByText('创 建'));

    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
    const payload = mocked.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ name: 'ci-key', scope: 'trigger' });
    expect('scopes' in payload && payload.scopes).toBeFalsy();
  });

  it('默认 scope=readonly → 不展示勾选；载荷不含 scopes', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-create'));
    fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'r-key' } });

    expect(screen.queryByTestId('apikey-task-trigger')).toBeNull();

    fireEvent.click(screen.getByText('创 建'));
    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
    expect(mocked.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'r-key', scope: 'readonly' }),
    );
    const payload = mocked.create.mock.calls[0][0] as Record<string, unknown>;
    expect('scopes' in payload && payload.scopes).toBeFalsy();
  });
});
