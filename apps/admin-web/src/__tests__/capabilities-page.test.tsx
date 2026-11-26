/**
 * P3 中台管控 · 能力注册表页面单测。
 *
 * 覆盖：列表字段渲染、ADMIN 按钮门控、创建 Modal 的 DTO（含 scope 组合）、
 * managed⇒L3 前端拦截、resolve 生效配置与决策徽标、dump 三栏审计表格。
 * API 全部按后端 6 条路由契约 mock，不触网。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CapabilitiesPage from '../pages/CapabilitiesPage';
import { capabilitiesApi, type Capability, type CapabilityDump } from '../api/capabilities';
import { message } from '../utils/toast';
import type { AuthUser } from '../store/auth';

const authState = vi.hoisted(() => ({
  user: { id: 7, username: 'tester', role: 'user' } as AuthUser | null,
}));

vi.mock('../api/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/capabilities')>();
  return {
    ...actual,
    capabilitiesApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      resolve: vi.fn(),
      dump: vi.fn(),
    },
  };
});

vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../store/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/auth')>();
  const fakeHook = ((
    selector?: (s: ReturnType<typeof actual.useAuthStore.getState>) => unknown,
  ) =>
    selector
      ? selector({ ...actual.useAuthStore.getState(), user: authState.user })
      : (undefined as never)) as typeof actual.useAuthStore;
  return { ...actual, useAuthStore: Object.assign(fakeHook, actual.useAuthStore) };
});

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

const CAPS: Capability[] = [
  {
    id: '11111111-2222-4333-8444-555555555555',
    key: 'browser',
    kind: 'mcp',
    label: '浏览器能力',
    description: '浏览器自动化',
    version: '1.2.0',
    source: { type: 'builtin' },
    visibility: 'global',
    scope: { mode: 'managed', guidance: 'L2' },
    manifest: { timeout: 60 },
    enabled: true,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    key: 'filesystem',
    kind: 'skill',
    label: '文件能力',
    description: null,
    version: '2.0.0',
    source: { type: 'registry', ref: 'local' },
    visibility: 'private',
    scope: { mode: 'self_service', guidance: 'L3' },
    manifest: {},
    enabled: false,
    createdBy: null,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
];

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CapabilitiesPage />
    </QueryClientProvider>,
  );
}

/** 从 antd Select 的下拉里点选一个选项（jsdom 没有真实点击定位）。 */
async function chooseOption(selectTestId: string, optionText: string) {
  const root = screen.getByTestId(selectTestId);
  // 当前 antd 版本的 Select 把 data-* 透传到外层容器，内部触发层是
  // .ant-select-content（旧版是 .ant-select-selector），两种结构都兼容。
  const target =
    (root.querySelector('.ant-select-selector') as HTMLElement | null) ??
    (root.querySelector('.ant-select-content') as HTMLElement | null) ??
    root;
  fireEvent.mouseDown(target);
  const option = await screen.findByText(optionText, {
    selector: '.ant-select-item-option-content',
  });
  fireEvent.click(option);
}

async function openCreateModal() {
  fireEvent.click(screen.getByRole('button', { name: /新建能力/ }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  authState.user = { id: 7, username: 'tester', role: 'user' };
  vi.mocked(capabilitiesApi.list).mockReset().mockResolvedValue(CAPS);
  vi.mocked(capabilitiesApi.create).mockReset().mockResolvedValue(CAPS[0]);
  vi.mocked(capabilitiesApi.update).mockReset().mockResolvedValue(CAPS[0]);
  vi.mocked(capabilitiesApi.remove).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(capabilitiesApi.resolve).mockReset().mockResolvedValue({
    key: 'browser',
    effective: { timeout: 60, model: 'gpt-x' },
    decision: 'ask',
  });
  vi.mocked(capabilitiesApi.dump).mockReset().mockResolvedValue({
    key: 'browser',
    dump: [
      {
        field: 'timeout',
        layers: [
          { name: 'managed', value: 60 },
          { name: 'project', value: 45 },
        ],
        effective: 45,
        source: 'project',
        rule: 'replace',
      },
      {
        field: 'apiKey',
        layers: [{ name: 'managed', value: '<redacted>' }],
        effective: '<redacted>',
        source: 'managed',
        rule: 'replace',
      },
    ] satisfies CapabilityDump['dump'],
  });
  vi.mocked(message.success).mockClear();
  vi.mocked(message.error).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('能力注册表页面', () => {
  it('列表渲染 key / kind / label / version / visibility / 作用域 / 启用状态', async () => {
    renderPage();
    await screen.findByText('browser');
    expect(screen.getByText('浏览器能力')).toBeTruthy();
    expect(screen.getByText('1.2.0')).toBeTruthy();
    expect(screen.getByText('global')).toBeTruthy();
    expect(screen.getByText('mcp')).toBeTruthy();
    expect(screen.getByTestId('cap-scope-browser').textContent).toContain('managed');
    expect(screen.getByTestId('cap-scope-browser').textContent).toContain('L2');
    expect(screen.getByTestId('cap-scope-filesystem').textContent).toContain('self_service × L3');
    expect(screen.getAllByText('启用').length).toBeGreaterThan(0);
    expect(screen.getAllByText('停用').length).toBeGreaterThan(0);
  });

  it('非 ADMIN 看不到新建/编辑/删除按钮，ADMIN 可见', async () => {
    renderPage();
    await screen.findByText('browser');
    expect(screen.queryByRole('button', { name: /新建能力/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除能力 browser' })).toBeNull();

    cleanup();
    authState.user = { id: 7, username: 'tester', role: 'admin' };
    renderPage();
    await screen.findByText('browser');
    expect(screen.getByRole('button', { name: /新建能力/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '编辑' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '删除能力 browser' })).toBeTruthy();
  });

  it('创建 Modal 提交正确 DTO（含 scope 组合与 JSON manifest）', async () => {
    authState.user = { id: 7, username: 'tester', role: 'admin' };
    renderPage();
    await screen.findByText('browser');
    const dialog = await openCreateModal();

    fireEvent.change(within(dialog).getByTestId('cap-key'), { target: { value: 'new_cap' } });
    fireEvent.change(within(dialog).getByTestId('cap-label'), { target: { value: '开发者工具' } });
    fireEvent.change(within(dialog).getByTestId('cap-manifest'), {
      target: { value: '{"timeout": 30}' },
    });
    await chooseOption('cap-kind', 'MCP 服务（mcp）');
    await chooseOption('cap-visibility', '项目（project）');
    await chooseOption('cap-scope-mode', '强监管（managed）');
    await chooseOption('cap-guidance', 'L2 · 需确认');
    await chooseOption('cap-source-type', '登记处（registry）');

    fireEvent.click(within(dialog).getByRole('button', { name: /提\s*交/ }));
    await waitFor(() => {
      expect(capabilitiesApi.create).toHaveBeenCalledTimes(1);
    });
    expect(capabilitiesApi.create).toHaveBeenCalledWith({
      key: 'new_cap',
      kind: 'mcp',
      label: '开发者工具',
      version: '1.0.0',
      visibility: 'project',
      scope: { mode: 'managed', guidance: 'L2' },
      source: { type: 'registry' },
      manifest: { timeout: 30 },
    });
    await waitFor(() => {
      expect(message.success).toHaveBeenCalled();
    });
  });

  it('managed + L3 在前端被拦住，不发创建请求', async () => {
    authState.user = { id: 7, username: 'tester', role: 'admin' };
    renderPage();
    await screen.findByText('browser');
    const dialog = await openCreateModal();

    fireEvent.change(within(dialog).getByTestId('cap-key'), { target: { value: 'bad_cap' } });
    fireEvent.change(within(dialog).getByTestId('cap-label'), { target: { value: '非法组合' } });
    await chooseOption('cap-scope-mode', '强监管（managed）');
    await chooseOption('cap-guidance', 'L3 · 高自治');

    fireEvent.click(within(dialog).getByRole('button', { name: /提\s*交/ }));
    await waitFor(() => {
      expect(message.error).toHaveBeenCalledWith(
        expect.stringContaining('L3'),
      );
    });
    expect(capabilitiesApi.create).not.toHaveBeenCalled();
  });

  it('resolve 区展示生效配置 JSON 与决策徽标', async () => {
    renderPage();
    await screen.findByText('browser');
    fireEvent.change(screen.getByTestId('resolve-project'), {
      target: { value: '{"timeout": 45}' },
    });
    fireEvent.click(screen.getByTestId('resolve-submit'));

    const result = await screen.findByTestId('resolve-result');
    expect(capabilitiesApi.resolve).toHaveBeenCalledWith({
      key: 'browser',
      layers: [
        { name: 'managed', config: {} },
        { name: 'project', config: { timeout: 45 } },
      ],
    });
    expect(within(result).getByTestId('resolve-decision').textContent).toContain('ask');
    expect(within(result).getByTestId('resolve-effective').textContent).toContain('gpt-x');
    expect(within(result).getByTestId('resolve-effective').textContent).toContain('timeout');
  });

  it('dump 区渲染字段 / 各层来源值 / 生效值 / 来源 / 规则三栏表格', async () => {
    renderPage();
    await screen.findByText('browser');
    fireEvent.click(screen.getByTestId('dump-submit'));

    const table = await screen.findByTestId('dump-table');
    expect(within(table).getByText('各层来源值')).toBeTruthy();
    expect(within(table).getByText('生效值')).toBeTruthy();
    expect(within(table).getByText('生效来源')).toBeTruthy();
    expect(within(table).getByText('合并规则')).toBeTruthy();
    expect(within(table).getAllByTestId('dump-layer-managed')[0].textContent).toContain('60');
    expect(within(table).getByTestId('dump-layer-project').textContent).toContain('45');
    expect(within(table).getAllByText('<redacted>').length).toBeGreaterThan(0);
    expect(capabilitiesApi.dump).toHaveBeenCalledWith('browser', {});
  });
});
