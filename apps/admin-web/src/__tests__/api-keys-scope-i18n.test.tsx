/**
 * 第 4 轮 INDEX §3-3（产品决策欠账 → 真欠账）：ApiKeysSettings 创建成功回显弹窗里
 * 的「Scope：」是**硬编码**，同一排的「名称：/前缀：」都已走 `t()`——中文界面下
 * 只有这一格夹着英文，英文界面下也读不出「Scope」(en 词条本可写成 Scope)。
 *
 * 本文件钉两件事：
 *  1. 运行时：zh 渲染中文「权限范围：」、en 渲染「Scope:」（= 词条真的经 i18n 出口，
 *     不是源码里又写死了一份）；
 *  2. 词条本身：zh/en 两侧同时存在且 zh 含中文（防「只加一侧 → en 回退中文」的
 *     半成品，i18n-key-check 之外的第二道牙齿）。
 *
 * 反证（见汇报）：把 `<Text>{t('apiKeys.result.scope')}</Text>` 改回
 * `<Text>Scope：</Text>`，zh 用例立即红（找不到「权限范围：」）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ApiKeysSettings from '../pages/settings/ApiKeysSettings';
import { apiKeysApi, ApiKeyView } from '../api/api-keys';
import { setLanguage } from '../i18n';
import zh from '../locales/zh';
import en from '../locales/en';

vi.mock('../api/api-keys', () => ({
  apiKeysApi: {
    list: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
    remove: vi.fn(),
  },
}));

const mocked = vi.mocked(apiKeysApi);

// jsdom 缺口 polyfill（api-keys-settings 先例）
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

const RESULT_TITLE = {
  zh: 'API Key 已创建',
  en: 'API Key created',
} as const;

/** 走完整创建链路：打开创建弹窗 → 填名称 → 提交 → 等一次性明文回显弹窗 */
async function createKeyAndOpenResult(lang: 'zh' | 'en'): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('apikey-create'));
  // 创建表单的「名称」标签本身也走 i18n（apiKeys.field.name），按界面语言取
  const name = await screen.findByLabelText(lang === 'zh' ? '名称' : 'Name');
  fireEvent.change(name, { target: { value: 'ci-scope-check' } });
  fireEvent.click(
    document.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLElement,
  );
  const title = await screen.findByText(RESULT_TITLE[lang]);
  return title.closest('.ant-modal') as HTMLElement;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await setLanguage('zh');
  mocked.list.mockResolvedValue([keyRow()]);
  mocked.create.mockResolvedValue({
    ...keyRow({ id: 9, name: 'ci-scope-check' }),
    plaintext: 'acf_' + 'cd'.repeat(32),
  });
});

afterEach(async () => {
  cleanup();
  // 语言状态不许泄漏给下一个用例（test-setup 的基线是 zh）
  await setLanguage('zh');
});

describe('apiKeys.result.scope 走 i18n（第 4 轮 INDEX §3-3）', () => {
  it('zh：创建回显弹窗渲染「权限范围：」，不再出现硬编码「Scope：」', async () => {
    renderPage();
    const modal = await createKeyAndOpenResult('zh');
    const scope = within(modal);

    expect(scope.getByText('权限范围：')).toBeTruthy();
    // 硬编码的原文不得残留（这条会在「改回 <Text>Scope：</Text>」时先红）
    expect(scope.queryByText('Scope：')).toBeNull();
    // 同排其它字段仍是各自词条：确认没有「整排被一起改坏」
    expect(scope.getByText('名称：')).toBeTruthy();
    expect(scope.getByText('前缀：')).toBeTruthy();
  });

  it('en：同一弹窗渲染「Scope:」（en 词条生效，而非回退中文）', async () => {
    await setLanguage('en');
    renderPage();
    const modal = await createKeyAndOpenResult('en');
    const scope = within(modal);

    expect(scope.getByText('Scope:')).toBeTruthy();
    // fallbackLng 是 zh：若 en 侧漏加词条，这里会看到中文 → 红
    expect(scope.queryByText('权限范围：')).toBeNull();
    expect(scope.getByText('Name:')).toBeTruthy();
  });

  it('词条两侧同步：zh 含中文、en 是 Scope（漏一侧即红）', () => {
    const zhValue = (zh as Record<string, string>)['apiKeys.result.scope'];
    const enValue = (en as Record<string, string>)['apiKeys.result.scope'];

    expect(zhValue).toBe('权限范围：');
    expect(enValue).toBe('Scope: ');
    // zh 侧确实中文化（防「两边都写 Scope」这种假同步）
    expect(/[\u4e00-\u9fff]/.test(zhValue)).toBe(true);
  });
});
