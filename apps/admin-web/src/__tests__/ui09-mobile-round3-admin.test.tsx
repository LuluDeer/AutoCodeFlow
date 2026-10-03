/**
 * UI-09 第三轮收官：管理面 6 页 375px 走查回归——
 *   settings/index（Token+系统配置）/ ApiKeysSettings / EventSubscriptionsSettings /
 *   SecuritySettings / NotificationSettingsPage（静默规则）/ RegistryPage。
 *
 * 断言口径对齐 round-3 兄弟文件（ui09-mobile-round3-content / mobile-ui09）：
 * jsdom 无布局引擎，只断言「渲染产物」——本批 6 页均为管理面低流量页，按 R5
 * 惯例**不做**卡片化，移动端适配走：
 *   · 表格次要列 ui09-hide-mobile 类（onHeaderCell/onCell 双端挂，≤768px 由
 *     index.css 媒体查询隐藏——DOM 类契约两侧一致，像素级由真实 375px 实测承担）；
 *   · 工具栏/卡头操作行 flexWrap（内联样式，桌面单行不受影响）；
 *   · 弹窗超屏由 index.css 既有 .ant-modal max-width 兜底（无抽屉，无 JS 分支）。
 * 故 jsdom 里 mobile/desktop 的 DOM 一致，移动用例断言类与样式契约，桌面回归
 * 用例断言列内容不丢。
 *
 * a11y 断言：icon-only 按钮显式 aria-label（antd Tooltip 不自动注入）；
 * 随文字出现的装饰图标 aria-hidden；Typography copyable 复制按钮以显式
 * tooltips 兼作可访问名（antd 以 tooltip 文本注入 aria-label）。
 *
 * 枚举标签断言：settings 配置表 valueType 列由裸 <Tag>{v}</Tag> 改为
 * VALUE_TYPE_T_KEYS 映射（已知值 i18n、未知值回退原始 token，对齐
 * utils/agent-label.ts 哲学；词表以 src/api/config.ts DTO 为准）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsPage from '../pages/settings';
import ApiKeysSettings from '../pages/settings/ApiKeysSettings';
import EventSubscriptionsSettings from '../pages/settings/EventSubscriptionsSettings';
import SecuritySettings from '../pages/settings/SecuritySettings';
import NotificationSettingsPage from '../pages/NotificationSettingsPage';
import RegistryPage from '../pages/RegistryPage';
import { configApi, type SystemConfig } from '../api/config';
import { aiApi } from '../api/ai';
import { apiKeysApi, type ApiKeyView } from '../api/api-keys';
import { eventSubscriptionsApi } from '../api/event-subscriptions';
import type { EventSubscription, EventSubscriptionDeadLetter } from '../api/event-subscriptions';
import { authApi, type AuthSession } from '../api/auth';
import { registryApi } from '../api/registry';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';

import '../i18n';
// UX-WALK scroll.x 契约：列题断言走 i18n 唯一事实源（上方 import 已初始化）
import i18n from '../i18n';

// ───────────────────────── API mock ─────────────────────────
vi.mock('../api/config', () => ({
  configApi: {
    findAll: vi.fn(),
    findOne: vi.fn(),
    upsert: vi.fn(),
    batchUpsert: vi.fn(),
    remove: vi.fn(),
    getHistory: vi.fn(),
    rollback: vi.fn(),
    generateExecutorToken: vi.fn(),
    getExecutorToken: vi.fn(),
  },
}));
vi.mock('../api/ai', () => ({
  aiApi: { getConfig: vi.fn(), saveConfig: vi.fn(), testConfig: vi.fn() },
}));
vi.mock('../api/api-keys', () => ({
  apiKeysApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}));
// EVENT_TYPE_OPTIONS 是模块级常量（订阅表事件类型 Tag 渲染依赖），保留原实现
vi.mock('../api/event-subscriptions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/event-subscriptions')>();
  return {
    ...actual,
    eventSubscriptionsApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      listDeadLetters: vi.fn(),
      replayDeadLetter: vi.fn(),
    },
  };
});
vi.mock('../api/auth', () => ({
  authApi: {
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    totpDisable: vi.fn(),
  },
}));
vi.mock('../api/registry', () => ({
  registryApi: { listPypiPackages: vi.fn(), listNpmPackages: vi.fn(), uploadPypiPackage: vi.fn() },
}));
// NotificationSettingsPage 直接消费 client（notificationApi + silencesApi 内部同走 client）
vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有页面测试先例）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// useIsMobile / antd 内部断点共用的 matchMedia 桩：mobile 模式仅命中
// (max-width: 768px)。本批页面无 JS 结构级分支（卡片化豁免），桩保证
// ≤768px 环境下渲染路径与真实 375px 一致（其余 antd 查询不命中）。
function stubMatchMedia(isMobile: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: isMobile && q.includes('max-width: 768px'),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage(node: React.ReactElement, path = '/') {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// NotificationSettingsPage 是重量级页面（多 Tab + Query），首个用例给足预算
// （对齐 notification-silences 先例，避免 CI 2 核下超时假红）
vi.setConfig({ testTimeout: 20_000 });

// ───────────────────────── 夹具 ─────────────────────────
const configRows: SystemConfig[] = [
  {
    id: 1, key: 'runtime.mode', value: 'safe', description: '运行模式说明',
    valueType: 'json', isSecret: false, tag: 'core',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  },
  {
    // 未知枚举值：后端新增取值而词表未跟 → 回退原始 token（不渲染成 i18n 键名）
    id: 2, key: 'legacy.entry', value: '1', description: null,
    valueType: 'weird' as SystemConfig['valueType'], isSecret: false, tag: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  },
];

function keyRow(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: 1,
    name: 'ci-deploy',
    keyPrefix: 'acf_dead',
    scope: 'trigger',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: '2026-09-08T10:00:00Z',
    createdAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

const subscription = {
  id: 'sub-1',
  url: 'https://ci.example.com/hooks',
  eventTypes: ['execution.completed'],
  enabled: true,
  consecutiveFailures: 2,
  lastFailureAt: '2026-09-08T09:00:00Z',
  lastFailureError: 'connect timeout',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-08T09:00:00Z',
} as unknown as EventSubscription;

const deadLetter = {
  id: 'dl-1',
  eventType: 'execution.failed',
  payload: { executionId: 'exec-1' },
  error: 'boom',
  attempts: 3,
  createdAt: '2026-09-08T09:30:00Z',
} as unknown as EventSubscriptionDeadLetter;

const sessions: AuthSession[] = [
  { id: 1, createdAt: '2026-09-08T08:00:00Z', expiresAt: '2026-10-08T08:00:00Z', userAgent: 'Mozilla/5.0 (X11; Linux) Firefox/128.0', ip: '10.0.0.1', current: true },
  { id: 2, createdAt: '2026-09-07T08:00:00Z', expiresAt: '2026-10-07T08:00:00Z', userAgent: 'curl/8.0', ip: '10.0.0.2', current: false },
];

const NOW = Date.now();
const silenceRow = {
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
};

const channelsFixture = [
  // config 带 titleTemplate → 渠道模板面板默认展开（InfoCircle 触发器可断言）
  { key: 'email', name: '邮件', enabled: true, config: { titleTemplate: 'T' }, description: 'SMTP 邮件通知' },
];

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);

  vi.mocked(configApi.findAll).mockResolvedValue(configRows);
  vi.mocked(configApi.getExecutorToken).mockResolvedValue({ hasToken: true, token: 'x'.repeat(40) });
  vi.mocked(aiApi.getConfig).mockResolvedValue({ provider: 'disabled' } as never);

  vi.mocked(apiKeysApi.list).mockResolvedValue([
    keyRow(),
    keyRow({ id: 2, name: 'old-key', scope: 'readonly', revokedAt: '2026-09-01T00:00:00Z' }),
  ]);

  vi.mocked(eventSubscriptionsApi.list).mockResolvedValue([subscription]);
  vi.mocked(eventSubscriptionsApi.listDeadLetters).mockResolvedValue({ data: [deadLetter] } as never);

  vi.mocked(authApi.listSessions).mockResolvedValue(sessions);

  vi.mocked(registryApi.listPypiPackages).mockResolvedValue(['demo-pkg']);
  vi.mocked(registryApi.listNpmPackages).mockResolvedValue([
    { name: 'demo-npm', latest: '1.0.0', description: 'A demo package' },
  ] as never);

  vi.mocked(client.get).mockImplementation(((url: string) => {
    if (url === '/notification/channels') return Promise.resolve(channelsFixture);
    if (url.startsWith('/notification/silences')) return Promise.resolve([silenceRow]);
    return Promise.resolve([]);
  }) as typeof client.get);

  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ───────────────── settings/index（系统配置 Tab）─────────────────
describe('UI-09 R3 settings 系统配置 375px 产物', () => {
  it('移动端：类型/标签/说明三列挂 ui09-hide-mobile 类（键/值/操作保留）', async () => {
    renderPage(<SettingsPage />, '/settings?tab=config');
    expect(await screen.findByText('runtime.mode')).toBeTruthy();
    const th = document.querySelectorAll('th.ui09-hide-mobile');
    expect(th.length).toBe(3);
    // 双端挂类：数据行单元格同步（2 行 × 3 列）
    expect(document.querySelectorAll('td.ui09-hide-mobile').length).toBe(6);
  });

  // UX-WALK 2026-10 防回归：此前配置表无 scroll 属性——375px 下按定宽列
  // min-content(~520px) 溢出且被祖先 overflow:hidden 裁剪、无滚动条，值列不可达。
  // 修复：值列声明 width 180 + scroll.x 820（antd 自建横滚容器，对齐全站先例）。
  // jsdom 无布局引擎，钉「配置声明」；像素级由真 Chromium 375 走查复测承担。
  it('移动端：配置表声明 scroll.x=820 横滚，值列有 width（375px 可达）', async () => {
    renderPage(<SettingsPage />, '/settings?tab=config');
    expect(await screen.findByText('runtime.mode')).toBeTruthy();
    const table = document.querySelector('.ant-table table') as HTMLTableElement;
    expect(table).toBeTruthy();
    // scroll.x 落为 <table> 内联宽度 → 横滚容器存在，窄屏不再依赖祖先 overflow
    // （820 = 定宽列 220+180+80+100+120=700 + 说明列弹性下限 120）
    expect(table.style.width).toBe('820px');
    const ths = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
    const cols = Array.from(table.querySelectorAll('colgroup col')) as HTMLElement[];
    expect(ths.length).toBe(cols.length);

    // 值列必须声明 width ≥180——它曾是全表唯二无宽度列，被挤压即重蹈裁剪覆辙
    const valueThIndex = ths.findIndex((th) => th.textContent === i18n.t('sysSettings.config.col.value'));
    expect(valueThIndex).toBeGreaterThan(-1);
    expect(parseFloat(cols[valueThIndex].style.width)).toBeGreaterThanOrEqual(180);

    // 唯一无宽度列 = 说明列（吃剩余空间），且 scroll.x 为其保底 ≥120
    const widthless = cols.filter((c) => !/^[\d.]+px$/.test(c.style.width.trim()));
    expect(widthless.length).toBe(1);
    const descThIndex = ths.findIndex((th) => th.textContent === i18n.t('sysSettings.config.col.desc'));
    expect(descThIndex).toBeGreaterThan(-1);
    expect(cols.indexOf(widthless[0])).toBe(descThIndex);
    expect(parseFloat(table.style.width)).toBeGreaterThanOrEqual(700 + 120);
  });

  it('valueType 枚举标签：已知值渲染 i18n 词条（json→JSON），未知值回退原始 token', async () => {
    renderPage(<SettingsPage />, '/settings?tab=config');
    await screen.findByText('runtime.mode');
    expect(screen.getByText('JSON')).toBeTruthy();
    expect(screen.getByText('weird')).toBeTruthy();
  });

  it('移动端：配置表上方操作行 flexWrap（说明文字与刷新/新建换行不溢出）', async () => {
    renderPage(<SettingsPage />, '/settings?tab=config');
    await screen.findByText('runtime.mode');
    // 从刷新按钮上溯：button → Space → 配置表操作行（flex 容器）
    const refresh = screen.getByRole('button', { name: /刷新/ });
    const row = refresh.closest('.ant-space')?.parentElement;
    expect(row?.style.flexWrap).toBe('wrap');
  });

  it('a11y：随文字的刷新/新建图标纯装饰（aria-hidden）', async () => {
    renderPage(<SettingsPage />, '/settings?tab=config');
    await screen.findByText('runtime.mode');
    for (const sel of ['.anticon-reload', '.anticon-plus', '.anticon-key']) {
      const icon = document.querySelector(sel) as HTMLElement | null;
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('a11y：Token 显隐切换 icon-only 按钮显式 aria-label，且随状态切换', async () => {
    renderPage(<SettingsPage />, '/settings');
    const eye = await screen.findByRole('button', { name: '显示 Token' });
    expect(eye.getAttribute('aria-label')).toBe('显示 Token');
    fireEvent.click(eye);
    expect(screen.getByRole('button', { name: '隐藏 Token' })).toBeTruthy();
  });

  it('桌面端回归：表格保留全部列，valueType 词条照常渲染', async () => {
    stubMatchMedia(false);
    renderPage(<SettingsPage />, '/settings?tab=config');
    await screen.findByText('runtime.mode');
    expect(document.querySelector('.ant-table table')).not.toBeNull();
    expect(screen.getByText('JSON')).toBeTruthy();
    expect(screen.getByText('weird')).toBeTruthy();
  });
});

// ─────────────────────── ApiKeysSettings ───────────────────────
describe('UI-09 R3 ApiKeysSettings 375px 产物', () => {
  it('移动端：前缀/最后使用两列挂 ui09-hide-mobile 类（名称/Scope/过期/状态/操作保留）', async () => {
    renderPage(<ApiKeysSettings />);
    await screen.findByText('ci-deploy');
    expect(document.querySelectorAll('th.ui09-hide-mobile').length).toBe(2);
    expect(document.querySelectorAll('td.ui09-hide-mobile').length).toBe(4);
  });

  it('a11y：一次性密钥复制按钮可访问名可读（复制密钥），复制/警示图标纯装饰', async () => {
    vi.mocked(apiKeysApi.create).mockResolvedValue({
      ...keyRow({ id: 3 }),
      plaintext: `acf_${'ab'.repeat(32)}`,
    } as never);
    renderPage(<ApiKeysSettings />);
    fireEvent.click(await screen.findByTestId('apikey-create'));
    fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'new-key' } });
    fireEvent.click(screen.getByText(/创\s*建/));
    const copyBtn = await screen.findByRole('button', { name: /复制密钥/ });
    // 可访问名来自按钮文字（非图标 aria-label）
    expect((copyBtn.textContent ?? '').replace(/\s/g, '')).toBe('复制密钥');
    const copyIcon = document.querySelector('.ant-modal .anticon-copy') as HTMLElement | null;
    expect(copyIcon).not.toBeNull();
    expect(copyIcon!.getAttribute('aria-hidden')).toBe('true');
    const warnIcon = document.querySelector('.ant-modal .anticon-warning') as HTMLElement | null;
    expect(warnIcon).not.toBeNull();
    expect(warnIcon!.getAttribute('aria-hidden')).toBe('true');
  });

  it('a11y：卡头标题/新建按钮图标纯装饰（aria-hidden）', async () => {
    renderPage(<ApiKeysSettings />);
    await screen.findByText('ci-deploy');
    for (const sel of ['.anticon-api', '.anticon-plus']) {
      const icon = document.querySelector(sel) as HTMLElement | null;
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('桌面端回归：表格保留，前缀列内容仍在 DOM', async () => {
    stubMatchMedia(false);
    renderPage(<ApiKeysSettings />);
    await screen.findByText('ci-deploy');
    expect(document.querySelector('.ant-table table')).not.toBeNull();
    expect(screen.getAllByText(/acf_dead…/).length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────── EventSubscriptionsSettings ────────────────────
describe('UI-09 R3 EventSubscriptionsSettings 375px 产物', () => {
  it('移动端：投递状态列 + 死信尝试次数/时间列挂 ui09-hide-mobile 类', async () => {
    renderPage(<EventSubscriptionsSettings />);
    expect(await screen.findByText('https://ci.example.com/hooks')).toBeTruthy();
    // 死信查询独立于订阅列表，等骨架屏落为表格再断言
    await screen.findByText('boom');
    // 订阅表 1 列（投递状态）+ 死信表 2 列（尝试次数/时间）
    expect(document.querySelectorAll('th.ui09-hide-mobile').length).toBe(3);
    expect(document.querySelectorAll('td.ui09-hide-mobile').length).toBe(3);
  });

  it('a11y：重放按钮可访问名可读（文字），装饰图标 aria-hidden，删除 icon-only 按钮 aria-label', async () => {
    renderPage(<EventSubscriptionsSettings />);
    const replay = await screen.findByTestId('dead-letter-replay-dl-1');
    expect((replay.textContent ?? '').replace(/\s/g, '')).toBe('重放');
    const bolt = document.querySelector('.anticon-thunderbolt') as HTMLElement | null;
    expect(bolt).not.toBeNull();
    expect(bolt!.getAttribute('aria-hidden')).toBe('true');
    const del = await screen.findByTestId('sub-delete-sub-1');
    expect(del.getAttribute('aria-label')).toBe('删除此事件订阅');
    for (const sel of ['.anticon-bell', '.anticon-plus', '.anticon-edit']) {
      const icon = document.querySelector(sel) as HTMLElement | null;
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('桌面端回归：订阅与死信表保留，次要列内容仍在 DOM', async () => {
    stubMatchMedia(false);
    renderPage(<EventSubscriptionsSettings />);
    await screen.findByText('https://ci.example.com/hooks');
    await screen.findByText('boom');
    expect(document.querySelectorAll('.ant-table table').length).toBe(2);
    expect(screen.getByText('3')).toBeTruthy();
  });
});

// ─────────────────────── SecuritySettings ───────────────────────
describe('UI-09 R3 SecuritySettings 375px 产物', () => {
  it('移动端：会话表 IP/是否当前两列挂 ui09-hide-mobile 类（本机标识由操作列承担）', async () => {
    renderPage(<SecuritySettings />);
    expect(await screen.findByText('Firefox · Linux')).toBeTruthy();
    expect(document.querySelectorAll('th.ui09-hide-mobile').length).toBe(2);
    expect(document.querySelectorAll('td.ui09-hide-mobile').length).toBe(4);
  });

  it('移动端：会话卡卡头操作 Space wrap（刷新/批量吊销换行不挤压标题）', async () => {
    renderPage(<SecuritySettings />);
    await screen.findByText('Firefox · Linux');
    // 从卡头刷新按钮上溯到 extra 的 Space（antd 6 wrap 为内联 flexWrap，无独立类名）
    const refresh = screen.getByRole('button', { name: /刷新/ });
    const extraSpace = refresh.closest('.ant-space') as HTMLElement | null;
    expect(extraSpace).not.toBeNull();
    expect(extraSpace!.style.flexWrap).toBe('wrap');
  });

  it('a11y：设备/刷新等装饰图标 aria-hidden', async () => {
    renderPage(<SecuritySettings />);
    await screen.findByText('Firefox · Linux');
    for (const sel of ['.anticon-desktop', '.anticon-reload', '.anticon-user', '.anticon-lock', '.anticon-safety']) {
      const icon = document.querySelector(sel) as HTMLElement | null;
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('桌面端回归：IP 列内容仍在 DOM', async () => {
    stubMatchMedia(false);
    renderPage(<SecuritySettings />);
    await screen.findByText('Firefox · Linux');
    expect(screen.getByText('10.0.0.2')).toBeTruthy();
  });
});

// ────────────────── NotificationSettingsPage（静默规则 Tab）──────────────────
describe('UI-09 R3 NotificationSettingsPage 静默规则 375px 产物', () => {
  it('移动端：剩余时间/创建人两列挂 ui09-hide-mobile 类', async () => {
    renderPage(<NotificationSettingsPage />, '/notifications?tab=silences');
    expect(await screen.findByText('发布窗口静默')).toBeTruthy();
    expect(document.querySelectorAll('th.ui09-hide-mobile').length).toBe(2);
    expect(document.querySelectorAll('td.ui09-hide-mobile').length).toBe(2);
  });

  it('a11y：模板面板信息触发图标纯装饰（aria-hidden）', async () => {
    renderPage(<NotificationSettingsPage />, '/notifications?tab=silences');
    await screen.findByText('发布窗口静默');
    // 渠道面板（antd Tabs 懒挂载）需点击「邮件」Tab 后才渲染模板面板
    fireEvent.click(screen.getByRole('tab', { name: /邮件/ }));
    await screen.findByText('消息模板（可选）');
    // 页面级/静默面板的 Alert 图标（.ant-alert 内）不归本页治理；只断言
    // 模板面板标题（卡头）与字段标签（Form label）两处触发图标
    const titleIcon = document.querySelector('.ant-card-head .anticon-info-circle') as HTMLElement | null;
    expect(titleIcon).not.toBeNull();
    expect(titleIcon!.getAttribute('aria-hidden')).toBe('true');
    const labelIcon = document.querySelector('.ant-form-item-label .anticon-info-circle') as HTMLElement | null;
    expect(labelIcon).not.toBeNull();
    expect(labelIcon!.getAttribute('aria-hidden')).toBe('true');
  });

  it('桌面端回归：创建人列内容仍在 DOM', async () => {
    stubMatchMedia(false);
    renderPage(<NotificationSettingsPage />, '/notifications?tab=silences');
    await screen.findByText('发布窗口静默');
    expect(screen.getByText('root')).toBeTruthy();
  });
});

// ─────────────────────────── RegistryPage ───────────────────────────
describe('UI-09 R3 RegistryPage 375px 产物', () => {
  it('a11y：PyPI 复制按钮可访问名可读（tooltips→aria-label「复制命令」），装饰图标 aria-hidden', async () => {
    renderPage(<RegistryPage />);
    expect(await screen.findByText('demo-pkg')).toBeTruthy();
    const copyButtons = document.querySelectorAll('button.ant-typography-copy');
    expect(copyButtons.length).toBe(2);
    copyButtons.forEach((b) => expect(b.getAttribute('aria-label')).toBe('复制命令'));
    for (const sel of ['.anticon-upload', '.anticon-reload']) {
      const icon = document.querySelector(sel) as HTMLElement | null;
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('移动端：npm 表最新版本/描述两列挂 ui09-hide-mobile 类（包名/安装命令保留）', async () => {
    renderPage(<RegistryPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /npm/ }));
    expect(await screen.findByText('demo-npm')).toBeTruthy();
    expect(document.querySelectorAll('th.ui09-hide-mobile').length).toBe(2);
    expect(document.querySelectorAll('td.ui09-hide-mobile').length).toBe(2);
  });

  it('a11y：npm 安装命令复制按钮可访问名同口径（复制命令）', async () => {
    renderPage(<RegistryPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /npm/ }));
    await screen.findByText('demo-npm');
    // PyPI(2) + npm 安装列/npm 提示卡(2)，共 4 个可复制入口全部可读
    const copyButtons = document.querySelectorAll('button.ant-typography-copy');
    expect(copyButtons.length).toBeGreaterThanOrEqual(4);
    copyButtons.forEach((b) => expect(b.getAttribute('aria-label')).toBe('复制命令'));
  });

  it('桌面端回归：npm 描述列内容仍在 DOM', async () => {
    stubMatchMedia(false);
    renderPage(<RegistryPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /npm/ }));
    await screen.findByText('demo-npm');
    expect(screen.getByText('A demo package')).toBeTruthy();
  });
});

// 防 vi.mock 漏接：确保被 mock 的 api 确实替换了真实实现
describe('mock 接线自检', () => {
  it('configApi/aiApi 已 mock', () => {
    expect(vi.isMockFunction(configApi.findAll)).toBe(true);
    expect(vi.isMockFunction(aiApi.getConfig)).toBe(true);
    expect(vi.isMockFunction(apiKeysApi.list)).toBe(true);
    expect(vi.isMockFunction(eventSubscriptionsApi.list)).toBe(true);
    expect(vi.isMockFunction(authApi.listSessions)).toBe(true);
    expect(vi.isMockFunction(registryApi.listPypiPackages)).toBe(true);
    expect(vi.isMockFunction(client.get)).toBe(true);
  });
});
