/**
 * UI-03：MainLayout 侧边栏分组 IA + 折叠态测试。
 * 覆盖：六大分组渲染与页面项归属（≤2 跳 IA）、折叠切换持久化到 localStorage、
 * 分组展开态持久化、折叠态下主题按钮仍可用（UI-02 适配）、ADMIN-only 过滤。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<MainLayout />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 点击折叠按钮（data-testid 稳定定位，tooltip 文案随态变化） */
function clickCollapseToggle() {
  fireEvent.click(screen.getByTestId('sider-toggle'));
}

describe('UI-03 侧边栏分组 IA', () => {
  it('渲染六大分组：概览/任务/执行/执行器/应用/系统', () => {
    renderLayout();
    for (const group of ['概览', '任务', '执行', '执行器', '应用', '系统']) {
      expect(screen.getByText(group)).toBeTruthy();
    }
  });

  it('页面项归入分组后 ≤2 跳可达：展开分组即见全部页面项', async () => {
    renderLayout();
    // 展开默认收起的分组（受控 openKeys——点击分组标题）
    for (const group of ['概览', '执行器', '应用', '系统']) {
      fireEvent.click(screen.getByText(group));
    }
    // 一级页面项（分组内）——用菜单容器内标题节点断言，避开头部同名词干扰
    const menu = document.querySelector('.ant-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    // 展开的分组页面项（管理员视角）；执行器包为 ADMIN-only 需展开执行器组，此处校验在列
    const visible = ['控制台', '任务调度', '任务模板', '执行记录', '执行器列表', '应用管理', '包注册中心', '系统设置'];
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
    // 系统分组存在，但其 ADMIN-only 子项不可见（未展开时不在 DOM/隐藏）
    fireEvent.click(screen.getByText('系统'));
    // 展开系统分组后普通用户仍不应看到执行器包（ADMIN-only）
    fireEvent.click(screen.getByText('执行器'));
    expect(screen.queryByText('审计日志')).toBeNull();
    expect(screen.queryByText('用户管理')).toBeNull();
    expect(screen.queryByText('通知设置')).toBeNull();
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

  it('readMenuOpenKeys 过滤非法残留键并回退默认展开（任务/执行）', () => {
    expect(readMenuOpenKeys(['g-tasks', 'g-executions', 'g-system'])).toEqual(['g-tasks', 'g-executions']);
    localStorage.setItem('autoflow-menu-open-keys', JSON.stringify(['g-tasks', 'g-ghost', 42]));
    expect(readMenuOpenKeys(['g-tasks', 'g-executions', 'g-system'])).toEqual(['g-tasks']);
    localStorage.setItem('autoflow-menu-open-keys', 'not-json{');
    expect(readMenuOpenKeys(['g-tasks', 'g-executions'])).toEqual(['g-tasks', 'g-executions']);
  });

  it('分组展开/收起持久化到 localStorage', async () => {
    renderLayout();
    // 默认展开：任务/执行
    expect(readMenuOpenKeys(['g-overview', 'g-tasks', 'g-executions', 'g-executors', 'g-applications', 'g-system']))
      .toEqual(['g-tasks', 'g-executions']);
    // 点击「概览」展开 → 持久化含 g-overview
    fireEvent.click(screen.getByText('概览'));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('autoflow-menu-open-keys') || '[]');
      expect(saved).toContain('g-overview');
    });
    // 再次点击「概览」收起 → 持久化不再含 g-overview
    fireEvent.click(screen.getByText('概览'));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('autoflow-menu-open-keys') || '[]');
      expect(saved).not.toContain('g-overview');
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
});
