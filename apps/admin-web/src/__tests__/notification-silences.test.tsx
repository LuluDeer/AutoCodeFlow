/**
 * FEAT-01 通知静默规则管理 UI 测试（NotificationSettingsPage 新增「静默规则」Tab）：
 *  1) 列表渲染：维度/渠道/有效期至/剩余时间/创建人/说明、过期条目标识（已过期 Tag）；
 *  2) 新建提交 payload 精确对齐后端 POST /notification/silences 形状；
 *  3) 删除：Popconfirm 确认后调用 DELETE，取消不调用（对齐 settings.history-rollback 先例）；
 *  4) 非 admin：不渲染「静默规则」Tab（零入口，不发起 ADMIN-only 请求）。
 *
 * 隔离 api 层（对齐 notification-settings.test 先例，页面消费 client.*）；
 * antd 汉字按钮自动插空格，定位用 querySelector + textContent 归一化匹配（同前）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import NotificationSettingsPage from '../pages/NotificationSettingsPage';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 notification-settings.test 先例）
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

const channelsFixture = [
  { key: 'email', name: '邮件', enabled: true, config: {}, description: 'SMTP 邮件通知' },
];

// 三条规则覆盖：全局生效中 / 指定任务即将过期 / 已过期条目
const NOW = Date.now();
const silencesFixture = [
  {
    id: 's-1',
    scope: 'global',
    channelType: null,
    taskId: null,
    applicationId: null,
    level: null,
    reason: '发布窗口静默',
    startTime: new Date(NOW - 60_000).toISOString(),
    endTime: new Date(NOW + 30 * 60_000).toISOString(),
    durationMinutes: 31,
    createdBy: 'root',
    createdAt: new Date(NOW - 60_000).toISOString(),
  },
  {
    id: 's-2',
    scope: 'task',
    channelType: 'dingtalk',
    taskId: '11111111-2222-3333-4444-555555555555',
    applicationId: null,
    level: null,
    reason: null,
    startTime: new Date(NOW - 60_000).toISOString(),
    endTime: new Date(NOW + 90_000).toISOString(),
    durationMinutes: 2,
    createdBy: 'dev',
    createdAt: new Date(NOW - 60_000).toISOString(),
  },
  {
    id: 's-3',
    scope: 'application',
    channelType: null,
    taskId: null,
    applicationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    level: null,
    reason: '历史维护',
    startTime: new Date(NOW - 3_600_000).toISOString(),
    endTime: new Date(NOW - 1_800_000).toISOString(),
    durationMinutes: 30,
    createdBy: 'root',
    createdAt: new Date(NOW - 3_600_000).toISOString(),
  },
];

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配 */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  // 注：antd 静态 message 的 body 级 holder 为单例——从 DOM 移除后其内部引用
  // 变成游离节点，后续 message.success 将渲染进不可见节点。故这里不做清理，
  // 跨用例残留的 toast 文案改用 *AllByText 容忍（下同）。
  vi.mocked(client.get).mockReset().mockImplementation((url: string) => {
    if (url === '/notification/silences') return Promise.resolve(silencesFixture);
    return Promise.resolve(channelsFixture);
  });
  vi.mocked(client.post).mockReset().mockResolvedValue(silencesFixture[0] as never);
  vi.mocked(client.delete).mockReset().mockResolvedValue(true as never);
  vi.mocked(client.patch).mockReset();
});

afterEach(() => {
  cleanup();
});

/** 管理员路径：渲染页面并进入「静默规则」Tab（等待列表数据渲染） */
async function openSilencesTab() {
  render(<NotificationSettingsPage />);
  fireEvent.click(await screen.findByRole('tab', { name: /静默规则/ }));
  await screen.findByText('发布窗口静默'); // 列表数据已渲染
}

describe('静默规则列表渲染（FEAT-01）', () => {
  it('渲染维度/渠道/有效期至/剩余时间/创建人/说明，过期条目带「已过期」标识', async () => {
    await openSilencesTab();

    // 维度（三行 fixture：全局 / 指定任务 / 指定应用）
    expect(screen.getByText('全局')).toBeTruthy();
    expect(screen.getByText('11111111-2222-3333-4444-555555555555')).toBeTruthy();
    expect(screen.getByText('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeTruthy();
    // 渠道（空 = 全部渠道；两行命中 → getAllByText；「钉钉」与页面下方
    // 全局测试区 checkbox 同名，同样用 getAllByText）
    expect(screen.getAllByText('全部渠道').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('钉钉').length).toBeGreaterThanOrEqual(1);
    // 创建人与说明（root 两行命中；「发布窗口静默」因 toast 残留可能重复出现）
    expect(screen.getAllByText('root').length).toBe(2);
    expect(screen.getByText('dev')).toBeTruthy();
    expect(screen.getAllByText('发布窗口静默').length).toBeGreaterThanOrEqual(1);
    // 过期条目标识（s-3 endTime 已过）+ 生效条目剩余时间（s-2 为"X 分钟"量纲；
    // /分钟/ 与新建表单的 addonAfter 同命中 → getAllByText）
    expect(screen.getByText('已过期')).toBeTruthy();
    expect(screen.getAllByText(/分钟/).length).toBeGreaterThanOrEqual(2);
  });

  it('展示与后端 isSilenced 语义一致的抑制提示文案', async () => {
    await openSilencesTab();
    expect(screen.getByText('静默生效期间，命中规则的告警将被抑制发送')).toBeTruthy();
    expect(screen.getByText(/命中任务与级别的告警在发送前即被拦截、不会推送到任何通知渠道/)).toBeTruthy();
  });
});

describe('新建静默规则（FEAT-01）', () => {
  it('默认全局维度：提交 payload 精确为 scope/durationMinutes/reason 三键', async () => {
    await openSilencesTab();

    fireEvent.change(screen.getByPlaceholderText('如 30'), { target: { value: '30' } });
    fireEvent.change(screen.getByPlaceholderText('静默原因，如：发布窗口、线上维护'), {
      target: { value: '发版维护' },
    });
    fireEvent.click(findBtn(document.body, '新建静默规则') as HTMLButtonElement);

    await waitFor(() => expect(client.post).toHaveBeenCalledTimes(1));
    expect(client.post).toHaveBeenCalledWith('/notification/silences', {
      scope: 'global',
      durationMinutes: 30,
      reason: '发版维护',
    });
  });

  it('说明为空串时不携带 reason 键（后端 reason 可空）', async () => {
    await openSilencesTab();

    fireEvent.change(screen.getByPlaceholderText('如 30'), { target: { value: '15' } });
    fireEvent.click(findBtn(document.body, '新建静默规则') as HTMLButtonElement);

    await waitFor(() => expect(client.post).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(client.post).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.scope).toBe('global');
    expect(payload.durationMinutes).toBe(15);
    expect('reason' in payload).toBe(false);
  });

  it('创建成功后提示并刷新列表（GET /notification/silences 重拉）', async () => {
    await openSilencesTab();
    const initialCalls = vi.mocked(client.get).mock.calls.filter(
      (c) => c[0] === '/notification/silences',
    ).length;

    fireEvent.change(screen.getByPlaceholderText('如 30'), { target: { value: '30' } });
    fireEvent.click(findBtn(document.body, '新建静默规则') as HTMLButtonElement);

    // toast 可能与上一用例残留重复（body 级 holder 跨用例存活），用 *AllByText
    expect((await screen.findAllByText('静默规则已创建')).length).toBeGreaterThanOrEqual(1);
    await waitFor(() =>
      expect(
        vi.mocked(client.get).mock.calls.filter((c) => c[0] === '/notification/silences').length,
      ).toBeGreaterThan(initialCalls),
    );
  });
});

describe('删除静默规则（FEAT-01）', () => {
  it('Popconfirm 取消：不发起 DELETE 请求', async () => {
    await openSilencesTab();
    const row = (screen.getByText('发布窗口静默').closest('tr') as HTMLElement);
    fireEvent.click(findBtn(row, '删除') as HTMLButtonElement);

    const confirmText = await screen.findByText('确认删除此静默规则？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = (Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[]);
    // 取消键为第一个（测试环境默认 locale 下为 'Cancel'，对齐 settings.history-rollback）
    const cancelBtn = layerBtns[0] as HTMLButtonElement;
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(client.delete).not.toHaveBeenCalled());
  });

  it('Popconfirm 确认后调用 DELETE /notification/silences/:id 并提示成功', async () => {
    await openSilencesTab();
    const row = (screen.getByText('发布窗口静默').closest('tr') as HTMLElement);
    fireEvent.click(findBtn(row, '删除') as HTMLButtonElement);

    const confirmText = await screen.findByText('确认删除此静默规则？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = (Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[]);
    // 确认键为弹出层最后一个按钮（对齐 settings.history-rollback 断言方式）
    const okBtn = layerBtns[layerBtns.length - 1] as HTMLButtonElement;
    expect((okBtn.textContent ?? '').replace(/\s/g, '')).toBe('删除');
    fireEvent.click(okBtn);

    await waitFor(() => expect(client.delete).toHaveBeenCalledTimes(1));
    expect(client.delete).toHaveBeenCalledWith('/notification/silences/s-1');
    // toast 可能与其它用例残留重复（body 级 holder 跨用例存活），用 *AllByText
    expect((await screen.findAllByText('静默规则已删除')).length).toBeGreaterThanOrEqual(1);
  });
});

// ── UI-15：失败反馈断言（此前创建/删除 useRequest 无 onError 失败静默）──
describe('静默规则失败反馈（UI-15）', () => {
  it('创建失败 → 错误 toast（getErrMsg 兜底文案）', async () => {
    vi.mocked(client.post).mockRejectedValue(new Error('quota exceeded'));
    await openSilencesTab();
    fireEvent.change(screen.getByPlaceholderText('如 30'), { target: { value: '30' } });
    fireEvent.click(findBtn(document.body, '新建静默规则') as HTMLButtonElement);
    await waitFor(() => expect(client.post).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('quota exceeded')).toBeTruthy();
  });

  it('删除失败 → 错误 toast（后端 message 透出）', async () => {
    vi.mocked(client.delete).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '规则已被删除' } } }),
    );
    await openSilencesTab();
    const row = (screen.getByText('发布窗口静默').closest('tr') as HTMLElement);
    fireEvent.click(findBtn(row, '删除') as HTMLButtonElement);

    const confirmText = await screen.findByText('确认删除此静默规则？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = (Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[]);
    fireEvent.click(layerBtns[layerBtns.length - 1] as HTMLButtonElement);

    await waitFor(() => expect(client.delete).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('规则已被删除')).toBeTruthy();
  });
});

describe('非管理员零入口（FEAT-01）', () => {
  it('非 admin 不渲染「静默规则」Tab，也不发起 silences 请求', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    render(<NotificationSettingsPage />);

    // 等渠道 Tab 加载完成（页面就绪的信号）
    await screen.findByRole('tab', { name: /邮件/ });
    expect(screen.queryByRole('tab', { name: /静默规则/ })).toBeNull();
    // 从未发起 ADMIN-only 的 silences 请求
    expect(vi.mocked(client.get).mock.calls.some((c) => c[0] === '/notification/silences')).toBe(false);
    expect(vi.mocked(client.post).mock.calls.some((c) => c[0] === '/notification/silences')).toBe(false);
  });
});
