/**
 * 设置区**缓存键契约**：把「页面实际用的 queryKey」与「写后失效用的 queryKey」
 * 钉成可执行断言，防止一次改名静默掐断缓存失效。
 *
 * ## 为什么需要这个文件（缺陷类型，不是假想）
 *
 * TanStack Query 的失效是**纯前缀字符串匹配**：
 *
 *   `invalidateQueries({ queryKey: ['foo'] })` 命中所有以 `['foo', …]` 开头的查询；
 *   没有任何查询用这个键时，它**不报错、不重取、不打日志**——完全静默的空操作。
 *
 * 这个仓库真的踩过两次同型缺陷：
 *
 *  ① `pages/ExecutorDetailPage.tsx:98` 用 `['projects', 'me', 'roles']`，而
 *     `api/queries.ts` 的 `queryKeys.projects` 命名空间前缀同样是 `projects`——
 *     于是 `ProjectsPage` 里 `invalidateQueries({ queryKey: queryKeys.projects.list })`
 *     的失效**到不了**执行器详情的 roles 查询：成员变更后，非 admin 的入口可见性
 *     停在旧快照，必须整页刷新才更新。
 *  ② `pages/settings/SecuritySettings.tsx` 的 TOTP 开关曾 `invalidateQueries(
 *     ['auth-profile'])`，而**全仓没有任何** `queryKey: ['auth-profile']` 的查询
 *     （profile 的真实来源是 zustand store），同样是静默空操作。
 *
 * 当时全量 225 个测试文件全绿——因为**没有任何测试断言过「用的键」与
 * 「失效的键」是同一个**。`cache-key-consistency.r138.test.tsx` 做的是**静态
 * 源码扫描**（每个字面量失效键的根必须能在某处找到消费者），它能挡住「完全
 * 孤立的键」，但挡不住更隐蔽的一类：
 *
 *   · **前缀相同但语义不同**（ExecutorDetailPage 那种：都叫 `projects`，
 *     读写方各自手拼后缀）；
 *   · **键里少了某个参数**（如 `['config-history', key]` 漏掉 key，导致所有
 *     配置项共用一个历史缓存条目，切换配置项看到别人的历史——不报错）；
 *   · **失效方改名前缀、读取方没改**（静态扫描只看"根"，`['api-keys', x]`
 *     与 `['api-keys']` 根相同，扫描器认为一致，实际前缀匹配仍命中——这类是
 *     安全的；但反过来读取方改成 `['apiKey-list']` 时，静态扫描的「消费者
 *     集合」也跟着变，可能仍然自洽通过）。
 *
 * 本文件改用**运行时实测**：真的把页面渲染起来，读 QueryClient 里**实际注册
 * 的键**，再真的触发一次写操作，读 `invalidateQueries` **实际收到的键**，然后
 * 断言两者满足「失效键是读取键的前缀」这一**运行时契约**。改名、少参数、
 * 换命名空间，任一发生都会让断言变红。
 *
 * ## 覆盖范围（任务指定的 settings 区 + EventSubscriptions）
 *
 *   · settings/index.tsx      —— executor-token / system-configs /
 *                                config-history[key] / ai-config
 *   · ApiKeysSettings.tsx     —— api-keys（4 处字面量：1 读 3 写）
 *   · EventSubscriptionsSettings.tsx —— event-subscriptions + event-dead-letters[id]
 *                                （**8 处字面量，本区密度最高**）
 *   · SecuritySettings.tsx    —— auth-sessions
 *
 * ## 每条用例都能失败
 *
 * 任一页面把 `queryKey: ['api-keys']` 改成 `['apiKey-list']` 而忘记改失效侧，
 * 第二组（失效键必须前缀命中已注册键）立刻红；反过来只改失效侧，同样红。
 *
 * ## 隔离方式
 *
 * 对齐 cache-key-consistency.r138.test.tsx 与 settings.history-rollback.test.tsx：
 * 模块级 mock api 层、QueryClientProvider 包裹、MemoryRouter、jsdom shim。
 * 用**自建 QueryClient 实例**而不是全局单例——这样能同时读 `getQueryCache()`
 * （读取方注册了哪些键）并 spy `invalidateQueries`（写入方失效了哪些键）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../pages/settings/index';
import ApiKeysSettings from '../pages/settings/ApiKeysSettings';
import EventSubscriptionsSettings from '../pages/settings/EventSubscriptionsSettings';
import SecuritySettings from '../pages/settings/SecuritySettings';
import { configApi } from '../api/config';
import { aiApi } from '../api/ai';
import { apiKeysApi } from '../api/api-keys';
import { eventSubscriptionsApi } from '../api/event-subscriptions';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';

vi.mock('../api/ai', () => ({
  aiApi: {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    testConfig: vi.fn(),
    analyzeApp: vi.fn(),
    suggestSchedule: vi.fn(),
    listProviders: vi.fn().mockResolvedValue({
      providers: [],
      errors: [],
      routes: {
        analysis: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
        agent: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
        video: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
      },
    }),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    assignRoute: vi.fn(),
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
vi.mock('../api/api-keys', () => ({
  apiKeysApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn(), remove: vi.fn() },
}));
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
    login: vi.fn(),
    verifyLogin: vi.fn(),
    me: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    totpDisable: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    refresh: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（既有先例）
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

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s/g, '');
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => norm(b.textContent) === norm(text),
  ) ?? null;

/** 把 QueryClient 里**实际注册**的键序列化成可比较的字符串集合。 */
function registeredKeys(qc: QueryClient): string[] {
  return qc
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey));
}

/**
 * 运行时判定「`invalidate` 键能命中 `read` 键」——即 v5 的前缀语义。
 *
 * 逐元素严格相等直到 invalidate 键用尽（`exact: false` 的默认行为）。
 * 这是本文件的**核心判据**：读取方与失效方只要有一方改名（哪怕只改末段），
 * 或失效方多带/少带一段参数，这里就返回 false。
 */
function prefixMatches(invalidateKey: readonly unknown[], readKey: readonly unknown[]): boolean {
  if (invalidateKey.length > readKey.length) return false;
  return invalidateKey.every((seg, i) => JSON.stringify(seg) === JSON.stringify(readKey[i]));
}

/** 从 spy 的调用里取出所有 queryKey 实参。 */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls
    .map((c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey)
    .filter((k): k is unknown[] => Array.isArray(k));
}

interface Harness {
  qc: QueryClient;
  invalidateSpy: ReturnType<typeof vi.spyOn>;
}

/** 建一个带 spy 的 QueryClient（retry 关掉，测试里不要重试噪声）。 */
function makeClient(): Harness {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  return { qc, invalidateSpy };
}

function wrap(qc: QueryClient, ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

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

const apiKeyFixture = {
  id: 1,
  name: 'ci-deploy',
  keyPrefix: 'acf_dead',
  scope: 'trigger' as const,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: '2026-09-08T00:00:00Z',
};

const subFixture = {
  id: 'e1111111-1111-4111-8111-111111111111',
  eventTypes: ['execution.failed'],
  url: 'https://ci.example.com/hooks',
  secret: '******',
  enabled: true,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastFailureError: null,
  userId: 1,
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z',
};

const deadLetterFixture = {
  id: 'd1111111-1111-4111-8111-111111111111',
  subscriptionId: subFixture.id,
  eventType: 'execution.failed',
  payload: { event: 'execution.failed' },
  error: 'ECONNREFUSED',
  attempts: 3,
  createdAt: '2026-09-08T01:00:00Z',
};

const sessionFixture = {
  id: 2,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
  ip: '10.0.0.2',
  current: false,
  createdAt: '2026-09-08T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(configApi.findAll).mockReset().mockResolvedValue(configFixture as never);
  vi.mocked(configApi.getExecutorToken)
    .mockReset()
    .mockResolvedValue({ hasToken: false, token: null } as never);
  vi.mocked(configApi.getHistory).mockReset().mockResolvedValue({ data: [], total: 0 } as never);
  vi.mocked(configApi.upsert).mockReset().mockResolvedValue({ key: 'feature.x' } as never);
  vi.mocked(configApi.remove).mockReset().mockResolvedValue({ key: 'feature.x' } as never);
  vi.mocked(configApi.rollback).mockReset().mockResolvedValue({ key: 'feature.x' } as never);
  vi.mocked(configApi.generateExecutorToken)
    .mockReset()
    .mockResolvedValue({ token: 'tk' } as never);
  vi.mocked(aiApi.getConfig)
    .mockReset()
    .mockResolvedValue({ provider: 'disabled', hasApiKey: false } as never);
  vi.mocked(aiApi.saveConfig).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(apiKeysApi.list).mockReset().mockResolvedValue([apiKeyFixture] as never);
  vi.mocked(apiKeysApi.revoke).mockReset().mockResolvedValue({ success: true } as never);
  vi.mocked(apiKeysApi.remove).mockReset().mockResolvedValue({ success: true } as never);
  vi.mocked(eventSubscriptionsApi.list).mockReset().mockResolvedValue([subFixture] as never);
  vi.mocked(eventSubscriptionsApi.update)
    .mockReset()
    .mockResolvedValue({ ...subFixture, enabled: false } as never);
  vi.mocked(eventSubscriptionsApi.remove).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(eventSubscriptionsApi.listDeadLetters)
    .mockReset()
    .mockResolvedValue({ data: [deadLetterFixture], total: 1 } as never);
  vi.mocked(eventSubscriptionsApi.replayDeadLetter)
    .mockReset()
    .mockResolvedValue({ ok: true } as never);
  vi.mocked(authApi.listSessions).mockReset().mockResolvedValue([sessionFixture] as never);
  vi.mocked(authApi.revokeSession).mockReset().mockResolvedValue({ ok: true } as never);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  document.body.querySelectorAll('.ant-message-notice').forEach((el) => el.remove());
  document.body.querySelectorAll('.ant-modal-root').forEach((el) => el.remove());
});

afterEach(() => {
  cleanup();
  document.body.querySelectorAll('.ant-message-notice').forEach((el) => el.remove());
  document.body.querySelectorAll('.ant-modal-root').forEach((el) => el.remove());
});

// ───────────────────────────────────────────────────────────────────────────
// 第一组：**读取方**实际注册的键 —— 钉死键的字面形状
// ───────────────────────────────────────────────────────────────────────────
describe('缓存键契约 ①：读取方注册的键就是约定的字面形状', () => {
  it('settings/index：执行器 Token Tab 注册 [executor-token]', async () => {
    const { qc } = makeClient();
    wrap(qc, <SettingsPage />);
    await waitFor(() => expect(configApi.getExecutorToken).toHaveBeenCalled());

    expect(registeredKeys(qc)).toContain(JSON.stringify(['executor-token']));
  });

  it('settings/index：系统配置 Tab 注册 [system-configs]', async () => {
    const { qc } = makeClient();
    wrap(qc, <SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '系统配置' }));
    await screen.findByText('feature.x');

    expect(registeredKeys(qc)).toContain(JSON.stringify(['system-configs']));
  });

  it('settings/index：变更历史注册 [config-history, <key>]（key 必须在键里，不能共用条目）', async () => {
    const { qc } = makeClient();
    wrap(qc, <SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '系统配置' }));
    const row = (await screen.findByText('feature.x')).closest('tr') as HTMLElement;
    fireEvent.click(
      row.querySelector('button .anticon-history')?.closest('button') as HTMLButtonElement,
    );
    await waitFor(() => expect(configApi.getHistory).toHaveBeenCalled());

    // 关键：配置项的 key 是缓存键的一段 → 不同配置项不共用历史条目
    expect(registeredKeys(qc)).toContain(JSON.stringify(['config-history', 'feature.x']));
  });

  it('settings/index：AI 配置 Tab 注册 [ai-config]', async () => {
    const { qc } = makeClient();
    wrap(qc, <SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /AI 配置/ }));
    await waitFor(() => expect(aiApi.getConfig).toHaveBeenCalled());

    expect(registeredKeys(qc)).toContain(JSON.stringify(['ai-config']));
  });

  it('ApiKeysSettings：注册 [api-keys]', async () => {
    const { qc } = makeClient();
    wrap(qc, <ApiKeysSettings />);
    await screen.findByText('ci-deploy');

    expect(registeredKeys(qc)).toContain(JSON.stringify(['api-keys']));
  });

  it('EventSubscriptionsSettings：注册 [event-subscriptions] 与 [event-dead-letters, <subId>]', async () => {
    const { qc } = makeClient();
    wrap(qc, <EventSubscriptionsSettings />);
    await screen.findByText(subFixture.url);
    await waitFor(() => expect(eventSubscriptionsApi.listDeadLetters).toHaveBeenCalled());

    const keys = registeredKeys(qc);
    expect(keys).toContain(JSON.stringify(['event-subscriptions']));
    // 死信的订阅 id 是键的一段 → 切换订阅不共用死信条目
    expect(keys).toContain(JSON.stringify(['event-dead-letters', subFixture.id]));
  });

  it('SecuritySettings：注册 [auth-sessions]', async () => {
    const { qc } = makeClient();
    wrap(qc, <SecuritySettings />);
    await waitFor(() => expect(authApi.listSessions).toHaveBeenCalled());

    expect(registeredKeys(qc)).toContain(JSON.stringify(['auth-sessions']));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 第二组：**写入方**失效的键必须前缀命中已注册的读取键
//         —— 这是本文件的**核心判据**（静默空操作的唯一运行时证据）
// ───────────────────────────────────────────────────────────────────────────
describe('缓存键契约 ②：写后失效的键必须真的能命中读取方的键', () => {
  /**
   * 断言本次会话里**每一个**被失效的键都能前缀命中至少一个已注册的读取键。
   *
   * 失败信息直接给出「哪个失效键打空了」+ 当时注册了哪些键，便于定位改名点。
   */
  function expectEveryInvalidationReachesAReader(h: Harness) {
    // 等一拍让 invalidate 之后的重取注册完成（重取不会改键，只是保险）
    const keys = invalidatedKeys(h.invalidateSpy);
    expect(keys.length, '本用例没有观察到任何 invalidateQueries 调用').toBeGreaterThan(0);

    const readKeys = h.qc.getQueryCache().getAll().map((q) => q.queryKey as unknown[]);
    expect(readKeys.length, '没有任何已注册的读取键').toBeGreaterThan(0);

    const orphans = keys.filter((inv) => !readKeys.some((rk) => prefixMatches(inv, rk)));
    expect(
      orphans.map((k) => JSON.stringify(k)),
      `这些失效键打空了（没有任何读取键以它为前缀）——改名的两侧不一致：registered=${JSON.stringify(
        readKeys.map((k) => JSON.stringify(k)),
      )}`,
    ).toEqual([]);
  }

  it('生成执行器 Token 后失效 [executor-token]（能命中 Token 读取键）', async () => {
    const h = makeClient();
    wrap(h.qc, <SettingsPage />);
    await screen.findByText('尚未生成执行器 Token，请先生成后再安装执行器');

    fireEvent.click(findBtn(document.body, '生成共享 Token')!);
    const confirmTitle = await screen.findByText('生成新的共享 Token', {
      selector: '.ant-modal-confirm-title',
    });
    const holder = (confirmTitle.closest('.ant-modal-confirm') ?? document.body) as HTMLElement;
    const btns = Array.from(holder.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[btns.length - 1]);
    });

    await waitFor(() => expect(configApi.generateExecutorToken).toHaveBeenCalled());
    await waitFor(() => {
      expect(invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k))).toContain(
        JSON.stringify(['executor-token']),
      );
    });
    expectEveryInvalidationReachesAReader(h);
  });

  it('新增配置项后失效 [system-configs]（能命中配置列表键）', async () => {
    const h = makeClient();
    wrap(h.qc, <SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '系统配置' }));
    await screen.findByText('feature.x');

    fireEvent.click(findBtn(document.body, '新增配置')!);
    await waitFor(() => expect(document.querySelector('.ant-modal')).toBeTruthy());
    fireEvent.change(document.querySelector('.ant-modal #key') as HTMLInputElement, {
      target: { value: 'feature.y' },
    });
    fireEvent.change(document.querySelector('.ant-modal #value') as HTMLTextAreaElement, {
      target: { value: 'v1' },
    });
    const modal = document.querySelector('.ant-modal') as HTMLElement;
    const footBtns = Array.from(
      modal.querySelectorAll('.ant-modal-footer button'),
    ) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(footBtns[footBtns.length - 1]);
    });

    await waitFor(() => expect(configApi.upsert).toHaveBeenCalled());
    await waitFor(() => {
      expect(invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k))).toContain(
        JSON.stringify(['system-configs']),
      );
    });
    expectEveryInvalidationReachesAReader(h);
  });

  it('变更历史回滚后同时失效 [system-configs] 与 [config-history, <key>]', async () => {
    vi.mocked(configApi.getHistory).mockResolvedValue({
      data: [
        {
          id: 11,
          configKey: 'feature.x',
          action: 'update',
          oldValue: 'old-1',
          newValue: 'cur',
          description: null,
          userId: '1',
          username: 'root',
          ipAddress: '127.0.0.1',
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      total: 1,
    } as never);

    const h = makeClient();
    wrap(h.qc, <SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '系统配置' }));
    const row = (await screen.findByText('feature.x')).closest('tr') as HTMLElement;
    fireEvent.click(
      row.querySelector('button .anticon-history')?.closest('button') as HTMLButtonElement,
    );
    await screen.findByText('变更历史：feature.x');
    await screen.findByText('old-1');

    const updateRow = screen.getByText('old-1').closest('tr') as HTMLElement;
    fireEvent.click(findBtn(updateRow, '回滚')!);
    const confirmText = await screen.findByText('确认回滚到此版本？');
    const layer = (confirmText.closest('.ant-popover') ?? document.body) as HTMLElement;
    const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(layerBtns[layerBtns.length - 1]);
    });

    await waitFor(() => expect(configApi.rollback).toHaveBeenCalled());
    await waitFor(() => {
      const keys = invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k));
      expect(keys).toContain(JSON.stringify(['system-configs']));
      // 历史键必须**带上 configKey**——否则回滚后刷新的是「全部配置的历史」
      expect(keys).toContain(JSON.stringify(['config-history', 'feature.x']));
    });
    expectEveryInvalidationReachesAReader(h);
  });

  it('保存 AI 配置后失效 [ai-config]', async () => {
    const h = makeClient();
    wrap(h.qc, <SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /AI 配置/ }));
    await screen.findByText('保存配置');

    fireEvent.click(findBtn(document.body, '保存配置')!);

    await waitFor(() => expect(aiConfigSaveCalled()).toBe(true));
    await waitFor(() => {
      expect(invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k))).toContain(
        JSON.stringify(['ai-config']),
      );
    });
    expectEveryInvalidationReachesAReader(h);
  });

  it('ApiKeys 吊销后失效 [api-keys]（命名空间必须与读取方一致）', async () => {
    const h = makeClient();
    wrap(h.qc, <ApiKeysSettings />);
    await screen.findByText('ci-deploy');

    fireEvent.click(
      document.querySelector('[data-testid="apikey-revoke-1"]') as HTMLElement,
    );
    const layer = await waitFor(() => {
      const el = document.querySelector('.ant-popover') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const btns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[btns.length - 1]);
    });

    await waitFor(() => expect(apiKeysApi.revoke).toHaveBeenCalled());
    await waitFor(() => {
      expect(invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k))).toContain(
        JSON.stringify(['api-keys']),
      );
    });
    expectEveryInvalidationReachesAReader(h);
  });

  it('事件订阅启停后失效 [event-subscriptions]（能命中订阅列表键）', async () => {
    const h = makeClient();
    wrap(h.qc, <EventSubscriptionsSettings />);
    await screen.findByText(subFixture.url);

    const sw = (await screen.findByTestId(`sub-enabled-${subFixture.id}`)) as HTMLElement;
    fireEvent.click(sw.querySelector('button') ?? sw);

    await waitFor(() => expect(eventSubscriptionsApi.update).toHaveBeenCalled());
    await waitFor(() => {
      expect(invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k))).toContain(
        JSON.stringify(['event-subscriptions']),
      );
    });
    expectEveryInvalidationReachesAReader(h);
  });

  it('死信 replay 后失效 [event-dead-letters]（前缀必须能命中 [event-dead-letters, <id>]）', async () => {
    const h = makeClient();
    wrap(h.qc, <EventSubscriptionsSettings />);
    await screen.findByText(subFixture.url);
    await screen.findByTestId(`dead-letter-replay-${deadLetterFixture.id}`);

    fireEvent.click(screen.getByTestId(`dead-letter-replay-${deadLetterFixture.id}`));
    const layer = await waitFor(() => {
      const el = document.querySelector('.ant-modal-confirm') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const btns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[btns.length - 1]);
    });

    await waitFor(() => expect(eventSubscriptionsApi.replayDeadLetter).toHaveBeenCalled());
    await waitFor(() => {
      const keys = invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k));
      // 死信失效键必须能前缀命中「带 subId 的死信键」——多带一段就再也命中不了
      expect(keys).toContain(JSON.stringify(['event-dead-letters']));
      expect(keys).toContain(JSON.stringify(['event-subscriptions']));
    });
    expectEveryInvalidationReachesAReader(h);
  });

  it('吊销会话后失效 [auth-sessions]', async () => {
    const h = makeClient();
    wrap(h.qc, <SecuritySettings />);
    await waitFor(() => expect(authApi.listSessions).toHaveBeenCalled());
    await screen.findByText(/10\.0\.0\.2/);

    const revokeBtn = document.querySelector(
      `button[aria-label="吊销会话 ${sessionFixture.id}"]`,
    ) as HTMLButtonElement;
    expect(revokeBtn, '未找到吊销会话按钮').toBeTruthy();
    fireEvent.click(revokeBtn);

    const layer = await waitFor(() => {
      const el = document.querySelector('.ant-popover') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const btns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[btns.length - 1]);
    });

    await waitFor(() => expect(authApi.revokeSession).toHaveBeenCalled());
    await waitFor(() => {
      expect(invalidatedKeys(h.invalidateSpy).map((k) => JSON.stringify(k))).toContain(
        JSON.stringify(['auth-sessions']),
      );
    });
    expectEveryInvalidationReachesAReader(h);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 第三组：前缀语义的判据本身（钉住判定函数，防止它被"放宽"成恒真）
// ───────────────────────────────────────────────────────────────────────────
describe('缓存键契约 ③：前缀判定函数的口径（判据自己不许被放宽）', () => {
  it('失效键是读取键的前缀 → 命中（含 exact 与更长读取键两种）', () => {
    expect(prefixMatches(['api-keys'], ['api-keys'])).toBe(true);
    expect(prefixMatches(['event-dead-letters'], ['event-dead-letters', 'e1'])).toBe(true);
    expect(prefixMatches(['config-history', 'k'], ['config-history', 'k'])).toBe(true);
  });

  it('末段不同 / 失效键更长 / 参数值不同 → 不命中（这些正是改名后的形态）', () => {
    // ExecutorDetailPage 那类：看着同一命名空间，实际首段就不同
    expect(prefixMatches(['api-keys'], ['apiKey-list'])).toBe(false);
    // 失效方多带一段且值不同（如给死信失效键塞了别的 subId）→ 打不中该条目
    expect(prefixMatches(['event-dead-letters', 'other'], ['event-dead-letters', 'e1'])).toBe(
      false,
    );
    // 历史键带上**别的** configKey → 打不中本配置项的历史
    expect(prefixMatches(['config-history', 'other.k'], ['config-history', 'feature.x'])).toBe(
      false,
    );
    // 失效键比读取键更长（本体是读取键的严格前缀的反面）→ 不命中
    expect(prefixMatches(['api-keys', 'x'], ['api-keys'])).toBe(false);
  });

  it('失效侧**少带**参数会命中整片（过度失效）——这是可接受方向，也必须如实钉住', () => {
    // TanStack v5 的失效是前缀匹配：`['config-history']` 会命中**所有**配置项的历史。
    // 这不是"打空"，是"打太宽"（切换配置项时全部历史一起重取，只费流量不丢正确性）。
    // 把它钉住是为了让后来者明白：**漏参数 ≠ 打空**，真正的打空是末段/参数值不一致。
    expect(prefixMatches(['config-history'], ['config-history', 'feature.x'])).toBe(true);
    expect(prefixMatches(['event-dead-letters'], ['event-dead-letters', 'e1'])).toBe(true);
  });

  it('判据对空键/对象段是稳定的（JSON 逐段比较，不做 toString 拼接）', () => {
    // 对象段按 JSON 深度比较：{a:1} 与 {a:2} 不等
    expect(prefixMatches(['x', { a: 1 }], ['x', { a: 1 }])).toBe(true);
    expect(prefixMatches(['x', { a: 1 }], ['x', { a: 2 }])).toBe(false);
    // 空前缀命中一切（v5 语义）——但设置区没有任何页面用空键失效，
    // 这里只钉判据本身的口径
    expect(prefixMatches([], ['anything'])).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 第四组：**静态清点** —— 把「设置区实际写下的字面量键根」钉成一张清单。
//
// 运行时断言（①②）只能覆盖「本次渲染真的跑到的」读写路径；本组补一张静态
// 清单，作用是：**任何一次键改名都会在这里以 diff 形式跳出来**，而不是等到
// 某个运行时不常走的失效路径静默打空。
//
// 同时挡住本文件头说的那类历史缺陷（ExecutorDetailPage 的
// `['projects','me','roles']`）：设置区的键根一旦撞进 queryKeys 工厂的命名空间，
// 就会与别的页面的失效互相污染/漏失——这是**结构性**错误，必须静态拦。
// ───────────────────────────────────────────────────────────────────────────
describe('缓存键契约 ④：设置区字面量键根清单（改名必须显式改这张表）', () => {
  /** 设置区（含 EventSubscriptions）全部 6 个文件。 */
  const SETTINGS_FILES = [
    'pages/settings/index.tsx',
    'pages/settings/ApiKeysSettings.tsx',
    'pages/settings/EventSubscriptionsSettings.tsx',
    'pages/settings/SecuritySettings.tsx',
    'pages/settings/AiProvidersSettings.tsx',
    'pages/settings/ai-provider-filter.ts',
  ] as const;

  /**
   * 设置区**约定**的字面量键根 → 该键是读还是写（或两者）。
   *
   * 这张表就是「契约」。改代码不改表 → 本用例红；改表不改代码 → 也红
   * （因为断言是双向集合相等）。
   */
  const EXPECTED_ROOTS: Record<string, { read: boolean; write: boolean }> = {
    'api-keys': { read: true, write: true },
    'auth-sessions': { read: true, write: true },
    'config-history': { read: true, write: true },
    'event-dead-letters': { read: true, write: true },
    'event-subscriptions': { read: true, write: true },
    'executor-token': { read: true, write: true },
    'ai-config': { read: true, write: true },
    'system-configs': { read: true, write: true },
  };

  /**
   * queryKeys 工厂占用的**命名空间根**（api/queries.ts）。
   *
   * 设置区任何字面量键都不得以这些词作为首段——否则会命中/被命中别的页面的
   * 失效前缀（ExecutorDetailPage 的 `['projects', …]` 正是撞在 projects 上）。
   */
  const FACTORY_ROOTS = [
    'metrics',
    'executions',
    'scheduler',
    'tasks',
    'executors',
    'task-templates',
    'projects',
  ] as const;

  /** 从 src 根定位文件（不用 import.meta.url：vitest jsdom 下不是 file: scheme）。 */
  function findSrcRoot(): string {
    const candidates = [
      join(process.cwd(), 'src'),
      join(process.cwd(), 'apps', 'admin-web', 'src'),
    ];
    for (const c of candidates) {
      if (existsSync(join(c, 'api', 'queries.ts'))) return c;
    }
    let dir = dirname(resolve(process.cwd()));
    for (let i = 0; i < 5; i += 1) {
      const c = join(dir, 'src');
      if (existsSync(join(c, 'api', 'queries.ts'))) return c;
      dir = dirname(dir);
    }
    throw new Error(`找不到 admin-web 的 src 目录（cwd=${process.cwd()}）`);
  }

  /** 剥注释（源文件注释里大量贴真实调用文本，不剥会被当成"代码"）。 */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const KEY_RE = /queryKey:\s*\[\s*'([^']+)'/g;
  const WRITE_FN =
    /(invalidateQueries|cancelQueries|refetchQueries|removeQueries|setQueryData|getQueryData|getQueryState|ensureQueryData|prefetchQuery|fetchQuery)\s*\(\s*\{?\s*$/;

  interface RootUsage {
    read: boolean;
    write: boolean;
  }

  function scanSettingsRoots(): Map<string, RootUsage> {
    const srcRoot = findSrcRoot();
    const out = new Map<string, RootUsage>();
    for (const rel of SETTINGS_FILES) {
      const abs = join(srcRoot, rel);
      expect(existsSync(abs), `缺少设置区文件：${rel}`).toBe(true);
      const text = stripComments(readFileSync(abs, 'utf8'));
      KEY_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = KEY_RE.exec(text)) !== null) {
        const root = m[1];
        const isWrite = WRITE_FN.test(text.slice(Math.max(0, m.index - 120), m.index));
        const prev = out.get(root) ?? { read: false, write: false };
        out.set(root, {
          read: prev.read || !isWrite,
          write: prev.write || isWrite,
        });
      }
    }
    return out;
  }

  const scanned = scanSettingsRoots();

  it('扫描器本身是活的（找到全部 8 个键根，不是空跑通过）', () => {
    // 防御：正则/路径坏掉时 Map 会空 → 后面的集合断言会"因为两边都空"而假绿
    expect(scanned.size).toBe(8);
    expect(scanned.has('ai-config')).toBe(true);
    expect(scanned.has('event-dead-letters')).toBe(true);
  });

  it('字面量键根集合与契约表**双向相等**（多一个/少一个都红）', () => {
    expect([...scanned.keys()].sort()).toEqual(Object.keys(EXPECTED_ROOTS).sort());
  });

  it('每个键根都既有读取方又有失效方（单向即静默空操作）', () => {
    const oneWay = [...scanned.entries()]
      .filter(([, u]) => !u.read || !u.write)
      .map(([root, u]) => `${root}: read=${u.read} write=${u.write}`);
    expect(oneWay).toEqual([]);
  });

  it('设置区的键根**不得**撞进 queryKeys 工厂命名空间（ExecutorDetailPage 同类缺陷）', () => {
    const collisions = [...scanned.keys()].filter((root) =>
      (FACTORY_ROOTS as readonly string[]).includes(root),
    );
    expect(
      collisions,
      `这些设置区键根与 api/queries.ts 的工厂命名空间同名，会与其它页面的失效互相污染：${collisions.join(
        ', ',
      )}`,
    ).toEqual([]);
  });
});

/** aiApi.saveConfig 是否已被调用（小工具，避免在断言里写长表达式）。 */
function aiConfigSaveCalled(): boolean {
  return vi.mocked(aiApi.saveConfig).mock.calls.length > 0;
}
