/**
 * FEAT-08 settings 页变更历史回滚测试：
 * - 管理员：每行渲染「回滚」，创建条目（oldValue 为 null）禁用并 Tooltip 说明；
 * - 确认（Popconfirm）后调用 configApi.rollback(id)，成功后刷新历史列表与
 *   当前配置读面（invalidate 触发 getHistory/findAll 重查）并提示成功；
 * - 非管理员：不渲染回滚入口（沿用页面 R4「不可见或禁用」先例，不做无谓 403）。
 *
 * 隔离 api 层（对齐 settings.ai.test 先例）；antd 汉字按钮会自动插空格，
 * 按钮定位用 querySelector + textContent 归一化匹配（同 notification-settings.test 注2）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsPage from '../pages/settings/index';
import { configApi } from '../api/config';
import { useAuthStore } from '../store/auth';

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
    findAll: vi.fn(),
    findOne: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    getHistory: vi.fn(),
    rollback: vi.fn(),
    generateExecutorToken: vi.fn(),
    getExecutorToken: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）
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

const historyFixture = [
  {
    id: 11,
    configKey: 'feature.x',
    action: 'update' as const,
    oldValue: 'old-1',
    newValue: 'cur',
    description: null,
    userId: '1',
    username: 'root',
    ipAddress: '127.0.0.1',
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 12,
    configKey: 'feature.x',
    action: 'create' as const,
    oldValue: null,
    newValue: 'init',
    description: null,
    userId: '1',
    username: 'root',
    ipAddress: '127.0.0.1',
    createdAt: '2026-08-31T00:00:00.000Z',
  },
];

const configFixture = [
  {
    id: 1,
    key: 'feature.x',
    value: 'cur',
    description: null,
    valueType: 'string' as const,
    isSecret: false,
    tag: null,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
];

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配 */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  vi.mocked(configApi.findAll).mockReset().mockResolvedValue(configFixture as never);
  vi.mocked(configApi.getHistory).mockReset().mockResolvedValue({ data: historyFixture, total: 2 } as never);
  vi.mocked(configApi.rollback).mockReset().mockResolvedValue({ key: 'feature.x', value: 'old-1' } as never);
  vi.mocked(configApi.getExecutorToken).mockReset().mockResolvedValue({ hasToken: false, token: null } as never);
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

/** 管理员路径：进入系统配置 Tab 并打开 feature.x 的变更历史抽屉（等待历史数据渲染） */
async function openHistoryAsAdmin() {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  renderSettings();
  fireEvent.click(screen.getByText('系统配置'));
  const keyCell = await screen.findByText('feature.x');
  const row = keyCell.closest('tr') as HTMLElement;
  const historyBtn = row.querySelector('button .anticon-history')?.closest('button') as HTMLButtonElement;
  fireEvent.click(historyBtn);
  await screen.findByText('变更历史：feature.x');
  await screen.findByText('old-1'); // 历史表数据已渲染
  const modal = (screen.getByText('变更历史：feature.x').closest('.ant-modal') ??
    document.body) as HTMLElement;
  return { modal, row };
}

describe('settings 变更历史回滚（FEAT-08）', () => {
  it('管理员：每行渲染「回滚」，创建条目（oldValue null）禁用并带 Tooltip 说明，其余启用', async () => {
    const { modal } = await openHistoryAsAdmin();

    await waitFor(() => expect(findBtn(modal, '回滚')).toBeTruthy());
    const rollbackBtns = (Array.from(modal.querySelectorAll('button')) as HTMLButtonElement[]).filter(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === '回滚',
    );
    expect(rollbackBtns).toHaveLength(2);

    // update 行（含旧值 old-1）启用
    const updateRow = (screen.getByText('old-1').closest('tr') as HTMLElement);
    expect(findBtn(updateRow, '回滚')?.disabled).toBe(false);
    // create 行（动作=创建，oldValue null）禁用：点击不弹确认框、不发请求
    // （对齐 application-list-rbac「禁用按钮 click 无效，Popconfirm 不弹出」先例；
    //   行内 Tooltip 说明在 jsdom 悬停下不可靠，不在断言范围）
    const createRow = (Array.from(modal.querySelectorAll('tr')) as HTMLElement[]).find(
      (tr) => tr.textContent?.includes('创建'),
    ) as HTMLElement;
    expect(createRow).toBeTruthy();
    const createBtn = findBtn(createRow, '回滚') as HTMLButtonElement;
    expect(createBtn?.disabled).toBe(true);
    fireEvent.click(createBtn);
    expect(screen.queryByText('确认回滚到此版本？')).toBeNull();
    expect(configApi.rollback).not.toHaveBeenCalled();
  });

  it('管理员：确认后调用 rollback(id)，成功提示并刷新历史与配置读面', async () => {
    const { modal } = await openHistoryAsAdmin();
    const initialHistoryCalls = vi.mocked(configApi.getHistory).mock.calls.length;
    const initialFindAllCalls = vi.mocked(configApi.findAll).mock.calls.length;

    const updateRow = (screen.getByText('old-1').closest('tr') as HTMLElement);
    fireEvent.click(findBtn(updateRow, '回滚') as HTMLButtonElement);

    // Popconfirm 弹出 → 点击确认键（精确 token 匹配弹层根节点，避免命中
    // ant-popover-title 等子节点；ok 键为弹出层最后一个按钮）
    const confirmText = await screen.findByText('确认回滚到此版本？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = (Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[]);
    const okBtn = layerBtns[layerBtns.length - 1] as HTMLButtonElement;
    expect(okBtn).toBeTruthy();
    expect((okBtn.textContent ?? '').replace(/\s/g, '')).toBe('回滚');
    fireEvent.click(okBtn);

    await waitFor(() => expect(configApi.rollback).toHaveBeenCalledTimes(1));
    expect(configApi.rollback).toHaveBeenCalledWith(11);
    // 其余行（创建条目）未被调用
    expect(configApi.rollback).not.toHaveBeenCalledWith(12);

    // 成功 message
    expect(await screen.findByText('已回滚')).toBeTruthy();

    // 刷新：历史列表 + 当前配置读面均重新拉取
    await waitFor(() =>
      expect(vi.mocked(configApi.getHistory).mock.calls.length).toBeGreaterThan(initialHistoryCalls),
    );
    await waitFor(() =>
      expect(vi.mocked(configApi.findAll).mock.calls.length).toBeGreaterThan(initialFindAllCalls),
    );
    void modal;
  });

  // ── UI-15：回滚失败反馈断言（onError 补齐后文案可见）──
  it('回滚失败 → 错误 toast（UI-15 onError 补齐）', async () => {
    vi.mocked(configApi.rollback).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '配置已被并发修改' } } }),
    );
    // 只清残留 notice，不清 .ant-message holder 单例（notification-silences
    // 先例注记：holder 被 remove 后内部引用成游离节点，后续 toast 渲染进不可见节点）
    document.body.querySelectorAll('.ant-message-notice').forEach((el) => el.remove());
    await openHistoryAsAdmin();
    const updateRow = (screen.getByText('old-1').closest('tr') as HTMLElement);
    fireEvent.click(findBtn(updateRow, '回滚') as HTMLButtonElement);

    const confirmText = await screen.findByText('确认回滚到此版本？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = (Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[]);
    fireEvent.click(layerBtns[layerBtns.length - 1] as HTMLButtonElement);

    await waitFor(() => expect(configApi.rollback).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('配置已被并发修改')).toBeTruthy();
  });

  it('非管理员：不渲染回滚入口，也不发起回滚请求', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderSettings();
    fireEvent.click(screen.getByText('系统配置'));
    const keyCell = await screen.findByText('feature.x');
    const row = keyCell.closest('tr') as HTMLElement;
    const historyBtn = row.querySelector('button .anticon-history')?.closest('button') as HTMLButtonElement;
    fireEvent.click(historyBtn);
    await screen.findByText('变更历史：feature.x');

    // 无任何「回滚」按钮，仅剩取消等非回滚按钮
    const rollbackBtns = (Array.from(document.body.querySelectorAll('button')) as HTMLButtonElement[]).filter(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === '回滚',
    );
    expect(rollbackBtns).toHaveLength(0);
    expect(configApi.rollback).not.toHaveBeenCalled();
  });

  it('确认取消（Popconfirm 取消）不发起回滚', async () => {
    // antd message 挂在 body 上、不随组件 cleanup 卸载，先清掉上一用例的
    // 「已回滚」残留，避免误判本用例的失败提示语义
    document.body.querySelectorAll('.ant-message').forEach((el) => el.remove());
    await openHistoryAsAdmin();
    const updateRow = (screen.getByText('old-1').closest('tr') as HTMLElement);
    fireEvent.click(findBtn(updateRow, '回滚') as HTMLButtonElement);

    const confirmText = await screen.findByText('确认回滚到此版本？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    // 取消键为弹出层第一个按钮（ok 键为最后一个）；测试环境无 zh-CN
    // ConfigProvider，antd 默认 locale 下取消键文案为 'Cancel'
    const layerBtns = (Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[]);
    const cancelBtn = layerBtns[0] as HTMLButtonElement;
    expect(['取消', 'Cancel']).toContain((cancelBtn.textContent ?? '').replace(/\s/g, ''));
    fireEvent.click(cancelBtn);

    // 取消后不发起回滚、无成功提示（弹层 DOM 由 rc-motion 延迟移除，
    // jsdom 下不等待动画，仅断言行为语义）
    await waitFor(() => expect(configApi.rollback).not.toHaveBeenCalled());
    expect(screen.queryByText('已回滚')).toBeNull();
  });
});
