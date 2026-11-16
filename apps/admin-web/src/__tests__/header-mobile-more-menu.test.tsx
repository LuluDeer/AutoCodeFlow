/**
 * 375 头部收敛回归：≤768px 时主题 / 语言 / 搜索三个次要控件下沉「更多」下拉，
 * 顶栏只保留高频入口（项目切换 / 待办 / 通知 / 用户），不把可达入口 display:none。
 *
 * jsdom 无布局引擎：这里断言**结构分支**（窄屏渲染更多菜单而非裸长标签按钮），
 * 像素级无横溢由真实 Chromium 375px 走查承担（test-results/measure-720-header375.mjs）。
 * 桌面端分支保持原样：三个控件仍是顶栏直达按钮。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MainLayout from '../layouts/MainLayout';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({ authApi: { me: vi.fn() } }));
vi.mock('../components/CommandPalette', () => ({ default: () => <div /> }));

// 与既有 MainLayout 测试同款浏览器 API shim；matchMedia.matches 由用例切换
// （useIsMobile 的断点与 index.css ≤768px 媒体查询同值）。
const g = globalThis as Record<string, unknown>;
let mediaMatches = false;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
window.matchMedia = ((q: string) => ({
  matches: mediaMatches,
  media: q,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const user = { id: 1, username: 'alice', role: 'admin' };

beforeEach(() => {
  localStorage.clear();
  mediaMatches = false;
  useAuthStore.getState().setAuth('mobile-header-access', 'mobile-header-refresh', user);
  vi.mocked(authApi.me).mockReset().mockRejectedValue(new Error('skip profile'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

function renderLayout(path = '/dashboard') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<MainLayout />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('375 头部收敛：次要控件下沉「更多」下拉', () => {
  it('桌面端（>768px）主题/语言/搜索仍是顶栏直达按钮，无更多菜单', () => {
    mediaMatches = false;
    renderLayout();
    expect(screen.getByTestId('theme-toggle')).toBeTruthy();
    expect(screen.getByTestId('lang-toggle')).toBeTruthy();
    expect(screen.queryByTestId('header-more')).toBeNull();
  });

  it('窄屏（≤768px）渲染更多菜单，主题/语言/搜索不再以裸按钮占位', () => {
    mediaMatches = true;
    renderLayout();
    // 高频入口仍在顶栏：项目切换器、用户触发器可达
    expect(screen.getByTestId('project-switcher')).toBeTruthy();
    expect(screen.getByTestId('user-dropdown-trigger')).toBeTruthy();
    // 次要控件不下沉为 display:none 死按钮——独立按钮位移除，收进更多下拉
    expect(screen.getByTestId('header-more')).toBeTruthy();
    expect(screen.queryByTestId('theme-toggle')).toBeNull();
    expect(screen.queryByTestId('lang-toggle')).toBeNull();
  });

  it('打开更多菜单后，主题/语言/搜索条目均可读、可达', async () => {
    mediaMatches = true;
    renderLayout();
    fireEvent.click(screen.getByTestId('header-more'));
    await waitFor(() => expect(document.querySelector('.ant-dropdown-menu')).toBeTruthy());
    const items = Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).map((el) =>
      el.textContent?.trim(),
    );
    expect(items.length).toBe(3);
    // 搜索条目文案 = nav.search.aria；主题/语言条目至少带非空标签
    expect(items.some((t) => t === '全局搜索')).toBe(true);
    expect(items.every(Boolean)).toBe(true);
  });
});
