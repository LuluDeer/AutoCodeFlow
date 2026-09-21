/**
 * P0（UX-AUDIT-2026-09-21 §P0-7）：界面语言必须能**在界面上**切换。
 *
 * ## 这条守的是什么
 *
 * i18n 基础设施早就完备：`setLanguage`、`availableLanguages`、en 包按需分包、
 * 启动检测 + localStorage 持久化、中英两套 2300+ 词条。但**全站没有任何调用方**
 * ——`detectLanguage()` 只读 localStorage，而没有任何 UI 能写入它。于是整套
 * 双语能力对用户不可达：除手动改 localStorage 外，英文用户永远看不到英文界面，
 * en 词条与分包全是死代码。
 *
 * ## 为什么不能只断言"按钮存在"
 *
 * 存在一个语言按钮 ≠ 能切换语言（本轮审计里的母题正是"能力建好了没接上"）。
 * 因此断言的是**闭环**：点击 → i18n.language 真的变了 → 文案真的换了 →
 * localStorage 真的持久化了。任何一环断开，测试转红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/auth', () => ({
  authApi: { me: vi.fn().mockResolvedValue({ id: 1, username: 'root', role: 'admin' }) },
}));
vi.mock('../api/logout', () => ({ logoutRemote: vi.fn() }));
vi.mock('../components/CommandPalette', () => ({ default: () => <div /> }));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import MainLayout from '../layouts/MainLayout';
import i18n, { STORAGE_KEY } from '../i18n';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderLayout() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <MainLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('zh');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('P0-7: 界面语言切换入口', () => {
  it('头部渲染语言切换按钮（存在入口）', async () => {
    const { getByTestId } = renderLayout();
    await waitFor(() => expect(getByTestId('lang-toggle')).toBeTruthy());
  });

  it('点击后 i18n.language 真的切到 en（闭环，不只是"有个按钮"）', async () => {
    const { getByTestId } = renderLayout();
    const btn = await waitFor(() => getByTestId('lang-toggle'));

    fireEvent.click(btn);

    // setLanguage 对 en 走动态 import，须异步等待
    await waitFor(() => expect(i18n.language).toBe('en'), { timeout: 5000 });
  });

  it('切换后界面文案随之变为英文（词条真的被消费）', async () => {
    const { getByTestId, getByLabelText } = renderLayout();
    const btn = await waitFor(() => getByTestId('lang-toggle'));

    fireEvent.click(btn);
    await waitFor(() => expect(i18n.language).toBe('en'), { timeout: 5000 });

    // 该按钮的 aria-label 走 i18n 且随语言变化（英文词条生效 = en 资源包已挂载
    // 并被 React 树消费）。刻意不依赖侧边栏菜单项——分组展开态受 localStorage
    // 与首屏渲染时序影响，拿它当断言会引入与本次修复无关的脆弱性。
    await waitFor(() =>
      expect(getByLabelText('Switch interface language (currently English)')).toBeTruthy(),
    );
  });

  it('语言选择持久化到 localStorage（刷新后仍是英文）', async () => {
    const { getByTestId } = renderLayout();
    const btn = await waitFor(() => getByTestId('lang-toggle'));

    fireEvent.click(btn);
    await waitFor(() => expect(i18n.language).toBe('en'), { timeout: 5000 });

    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
  });
});
