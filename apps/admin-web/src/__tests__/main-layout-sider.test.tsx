/**
 * UI-03：MainLayout 侧边栏分组 IA + 折叠态测试。
 * 覆盖：六大分组渲染与页面项归属（≤2 跳 IA）、折叠切换持久化到 localStorage、
 * 分组展开态持久化、折叠态下主题按钮仍可用（UI-02 适配）、ADMIN-only 过滤。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MainLayout, {
  readCollapsedPreference,
  readMenuOpenKeys,
} from '../layouts/MainLayout';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({ authApi: { me: vi.fn() } }));

// 与既有 MainLayout 测试同款浏览器 API shim
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

const user = { id: 1, username: 'alice', role: 'admin' };

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().setAuth('ui03-access', 'ui03-refresh', user);
  vi.mocked(authApi.me).mockReset().mockRejectedValue(new Error('skip profile'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

function renderLayout(path = '/dashboard') {
  // BELL-01：MainLayout 内 NotificationBell 消费 react-query → 需要 provider
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

/** 点击折叠按钮（data-testid 稳定定位，tooltip 文案随态变化） */
function clickCollapseToggle() {
  fireEvent.click(screen.getByTestId('sider-toggle'));
}

/** 点击分组标题（antd 可点击节点为 .ant-menu-submenu-title，避开同名词叶子项） */
function clickGroup(label: string) {
  const menu = document.querySelector('.ant-menu') as HTMLElement;
  const title = Array.from(menu.querySelectorAll<HTMLElement>('.ant-menu-submenu-title'))
    .find((el) => el.textContent === label);
  expect(title).toBeTruthy();
  fireEvent.click(title!);
}

describe('UI-03 侧边栏分组 IA（P1-6 新 IA）', () => {
  it('渲染五个场景分组：自动化/辅助/节点/治理/系统', () => {
    renderLayout();
    for (const group of ['自动化', '辅助', '节点', '治理', '系统']) {
      expect(screen.getByText(group)).toBeTruthy();
    }
  });

  it('高频直达入口（控制台/执行记录）不包折叠组，展开分组即见全部页面项', async () => {
    renderLayout();
    // 展开默认收起的分组（受控 openKeys——点击分组标题）；自动化组默认展开
    for (const group of ['节点', '治理', '系统', '辅助']) {
      clickGroup(group);
    }
    // 一级页面项（分组内）——用菜单容器内标题节点断言，避开头部同名词干扰
    const menu = document.querySelector('.ant-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    // 直达一级入口 + 各分组页面项（管理员视角）；执行器包为 ADMIN-only，此处校验在列
    const visible = ['控制台', '任务', '模板', '执行记录', '执行器', '执行器包', '应用', '注册中心', '用户', '项目', '审计', '通知', '设置', 'SOP', 'Agent 会话'];
    for (const page of visible) {
      await waitFor(() => {
        const found = Array.from(menu.querySelectorAll<HTMLElement>('.ant-menu-title-content'))
          .some((el) => el.textContent === page);
        expect(found).toBe(true);
      });
    }
  });

  it('ADMIN-only 页面项对普通用户隐藏（分组内过滤）', () => {
    useAuthStore.getState().setAuth('ui03-access', 'ui03-refresh', {
      id: 2, username: 'bob', role: 'user',
    });
    renderLayout();
    // USER 外壳是四个平级直达项，没有 ADMIN 分组；admin-only 子项仍不应出现。
    expect(screen.queryByText('审计')).toBeNull();
    expect(screen.queryByText('用户')).toBeNull();
    expect(screen.queryByText('通知')).toBeNull();
    expect(screen.queryByText('执行器包')).toBeNull();
  });
});

describe('UI-03 折叠态与持久化', () => {
  it('折叠按钮切换折叠态并写入 localStorage', async () => {
    renderLayout();
    clickCollapseToggle();
    await waitFor(() => expect(readCollapsedPreference()).toBe(true));
    // 再点展开
    clickCollapseToggle();
    await waitFor(() => expect(readCollapsedPreference()).toBe(false));
  });

  it('初始折叠态从 localStorage 恢复', () => {
    localStorage.setItem('autoflow-sider-collapsed', 'true');
    renderLayout();
    // 折叠态下 logo 文本隐藏
    expect(screen.queryByText('AutoCodeFlow')).toBeNull();
    expect(readCollapsedPreference()).toBe(true);
  });

  it('readMenuOpenKeys 过滤非法残留键并回退默认展开（自动化组）', () => {
    expect(readMenuOpenKeys(['g-adm-work', 'g-adm-nodes', 'g-adm-system'])).toEqual(['g-adm-work']);
    localStorage.setItem('autoflow-menu-open-keys', JSON.stringify(['g-adm-work', 'g-ghost', 42]));
    expect(readMenuOpenKeys(['g-adm-work', 'g-adm-delivery', 'g-adm-nodes', 'g-adm-gov', 'g-adm-system'])).toEqual(['g-adm-work']);
    localStorage.setItem('autoflow-menu-open-keys', 'not-json{');
    expect(readMenuOpenKeys(['g-adm-work', 'g-adm-nodes'])).toEqual(['g-adm-work']);
  });

  it('分组展开/收起持久化到 localStorage', async () => {
    renderLayout();
    // 默认展开：自动化组。NAV-EXPAND-01：深链所属分组会在会话内被自动展开，
    // 但**不写入持久化**——持久化层只反映用户动作；深链自动展开每次路由都会
    // 重新应用，无需落盘。
    expect(readMenuOpenKeys(['g-adm-work', 'g-adm-nodes', 'g-adm-delivery', 'g-adm-gov', 'g-adm-system']))
      .toEqual(['g-adm-work']);
    // 点击「自动化」收起 → 持久化不再含默认展开键
    clickGroup('自动化');
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('autoflow-menu-open-keys') || '[]');
      expect(saved).not.toContain('g-adm-work');
    });
    // 再次点击「自动化」展开 → 持久化重新包含默认展开键
    clickGroup('自动化');
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('autoflow-menu-open-keys') || '[]');
      expect(saved).toContain('g-adm-work');
    });
  });

  it('折叠态下主题切换按钮仍可用（UI-02 排布适配）', async () => {
    renderLayout();
    clickCollapseToggle();
    await waitFor(() => expect(readCollapsedPreference()).toBe(true));
    const themeBtn = screen.getByTestId('theme-toggle');
    expect(themeBtn).toBeTruthy();
    // 折叠态下按钮 aria-label 仍随主题态可读
    expect(themeBtn.getAttribute('aria-label')).toContain('切换主题');
  });

  // WEB-2：命令面板改成「打开才挂载」的 lazy chunk——⌘K 必须仍能在
  // 面板挂载之前唤起它（热键监听常驻 MainLayout，面板内 hotkeys={false}）。
  it("WEB-2: Ctrl+K 在命令面板未挂载时也能唤起（lazy chunk）", async () => {
    renderLayout();
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true });
    expect(await screen.findByRole('dialog', {}, { timeout: 3000 })).toBeTruthy();
  });
});
