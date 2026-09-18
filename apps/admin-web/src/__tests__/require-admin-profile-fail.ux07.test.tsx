// @vitest-environment jsdom
/**
 * UX-07（本轮体验审查）：profile 拉取失败时 RequireAdmin 永久转圈。
 *
 * 缺陷链：
 *  ① MainLayout 的 profile 同步是 `authApi.me().catch(() => undefined)` —— 失败
 *     被完全吞掉，`user.role` 保持 undefined；
 *  ② RequireAdmin 对「role 未知」只有一种呈现：`<Spin />`。
 *
 * 于是管理员刷新 /users、/audit、/executor-packages 等 ADMIN-only 页面时，若
 * profile 请求失败（token 边缘态 / 网络抖动），页面**永久转圈**——既没有 403、
 * 也没有错误提示和重试按钮，用户只能手动改地址栏离开。
 *
 * 修法：把失败如实记录到 store（`profileError`），RequireAdmin 据此区分
 * 「加载中」与「加载失败」，失败时渲染可重试的错误态 + 回控制台兜底出口。
 *
 * 反证：让 RequireAdmin 忽略 `profileError`（改回只有 Spin 一个分支），
 * 「加载失败 → 可重试错误态」用例立即变红。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RequireAdmin from '../components/RequireAdmin';
import { useAuthStore } from '../store/auth';
import zh from '../locales/zh';

// authApi：失败态渲染这条路径不应自动调用它（重试是用户显式动作）。
// 但模块必须可解析——RequireAdmin 顶层 import 了它。
vi.mock('../api/auth', () => ({
  authApi: { me: vi.fn().mockResolvedValue({ id: 1, username: 'u', role: 'admin' }) },
}));

/** 取中文词条真值，避免断言写死文案（文案改动不该让行为测试变红）。 */
const zhDict = zh as Record<string, string>;

function renderGate() {
  return render(
    <MemoryRouter>
      <RequireAdmin>
        <div data-testid="admin-content">secret</div>
      </RequireAdmin>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({
    user: null,
    profileError: null,
    token: 't',
    refreshToken: 'r',
  });
});

afterEach(() => {
  cleanup();
});

describe('UX-07：ADMIN 门控的「加载中 / 加载失败 / 无权限」三态必须可区分', () => {
  it('加载中（无 user、无 error）→ 加载态，不渲染内容也不渲染错误', () => {
    renderGate();
    expect(screen.queryByTestId('admin-content')).toBeNull();
    // 不应出现错误标题——「加载中」与「加载失败」必须可区分
    expect(screen.queryByText(zhDict['requireAdmin.profileFailTitle'])).toBeNull();
    // 也不应误判成 403
    expect(screen.queryByText('403')).toBeNull();
  });

  it('加载失败（有 profileError）→ 渲染可重试的错误态，不是永久转圈', () => {
    useAuthStore.setState({ profileError: 'Network Error' });
    renderGate();

    // 核心反证：失败态必须给出标题与重试入口。
    expect(screen.getByText(zhDict['requireAdmin.profileFailTitle'])).toBeTruthy();
    // 注：antd 会给「两个汉字」的按钮标签自动插空格（重试 → 重 试），故按
    // 去空白文本 + button 角色定位，避免把 antd 的排版行为误判成缺陷。
    expect(
      screen
        .getAllByRole('button')
        .some((b) => b.textContent?.replace(/\s/g, '') === '重试'),
    ).toBe(true);
    // 且必须能看到真实失败原因（否则用户无从判断是网络还是权限问题）
    expect(screen.getByText('Network Error')).toBeTruthy();
    // 兜底出口：回控制台
    expect(screen.getByText(zhDict['requireAdmin.back'])).toBeTruthy();
    // 失败时不应放行内容
    expect(screen.queryByTestId('admin-content')).toBeNull();
    // 也不该谎报 403（用户其实可能是有权限的管理员）
    expect(screen.queryByText('403')).toBeNull();
  });

  it('非管理员（role=user）→ 403，且不显示 profile 错误', () => {
    useAuthStore.setState({ user: { id: 2, username: 'u', role: 'user' } });
    renderGate();
    expect(screen.getByText('403')).toBeTruthy();
    expect(screen.queryByText(zhDict['requireAdmin.profileFailTitle'])).toBeNull();
    expect(screen.queryByTestId('admin-content')).toBeNull();
  });

  it('管理员（role=admin）→ 放行内容', () => {
    useAuthStore.setState({ user: { id: 1, username: 'a', role: 'admin' } });
    renderGate();
    expect(screen.getByTestId('admin-content')).toBeTruthy();
  });

  it('store：setUser 成功后清除上一次的 profileError（重试成功不该还显示错误）', () => {
    useAuthStore.setState({ profileError: 'boom' });
    useAuthStore.getState().setUser({ id: 1, username: 'a', role: 'admin' });
    expect(useAuthStore.getState().profileError).toBeNull();
  });

  it('store：setAuth（新登录）清除 profileError', () => {
    useAuthStore.setState({ profileError: 'boom' });
    useAuthStore
      .getState()
      .setAuth('t2', 'r2', { id: 1, username: 'a', role: 'admin' });
    expect(useAuthStore.getState().profileError).toBeNull();
  });

  it('store：logout 一并清掉 profileError（避免换账号后残留旧错误）', () => {
    useAuthStore.setState({ profileError: 'boom' });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().profileError).toBeNull();
  });
});
