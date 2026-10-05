import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PasswordCard } from '../pages/settings/SecuritySettings';
import { usersApi } from '../api/users';
import { useAuthStore } from '../store/auth';

/**
 * A-13（R3-A 审计）: 自助改密卡——
 *  ① 表单校验（当前密码必填、新密码强度规则、两次输入一致）；
 *  ② 提交调用既有自改端点 PATCH /users/:id（载荷 password + currentPassword）；
 *  ③ 成功 → toast + 清空本地凭据（强制重新登录）+ 跳 /login；
 *  ④ 失败 → 错误 toast，不登出。
 */

vi.mock('../api/users', () => ({
  usersApi: { update: vi.fn() },
}));

const mocked = vi.mocked(usersApi);

// jsdom 缺口 polyfill（security-settings.test 先例）：antd 组件需要
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

// jsdom 不实现导航——用可写桩承接 window.location.href 赋值。
// 每个测试用独立实例：模块级共享桩会被前一用例遗留的异步流（antd message
// 关闭定时器、storage 事件等在 CI 覆盖率慢跑下的晚到回调）跨用例污染，
// CI 上以 1/千次量级偶发「失败路径 href 变成 /login」的假失败。
function makeLocationStub() {
  return { href: 'http://localhost/security' };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PasswordCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillAndSubmit(v: {
  current: string;
  next: string;
  confirm: string;
}) {
  // antd Form.Item 自动关联 label htmlFor ↔ input id，用 label 定位最稳
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: v.current } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: v.next } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: v.confirm } });
  fireEvent.click(screen.getByTestId('password-submit'));
}

let locationStub: { href: string };

beforeEach(() => {
  vi.clearAllMocks();
  locationStub = makeLocationStub();
  Object.defineProperty(window, 'location', { writable: true, value: locationStub });
  locationStub.href = 'http://localhost/security';
  useAuthStore.getState().logout();
  useAuthStore.getState().setAuth('tok', 'rfsh', { id: 7, username: 'alice' });
});

afterEach(async () => {
  useAuthStore.getState().logout();
  // 换丢弃桩再排水：晚到续体（成功路径 SecuritySettings 的 /login 跳转挂在
  // promise 链上，覆盖率慢跑下可跨用例才执行）动态解引用 window.location——
  // beforeEach 的新桩防不住这类跨用例晚到写，CI 上 1/千次量级偶发
  // 「失败路径 href 变成 /login」假失败（run 37337887781 实证）。此处先让
  // 全部挂起的续体落进丢弃桩再进入下一用例。
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { href: 'about:discarded-after-unmount' },
  });
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('A-13 自助改密卡（PasswordCard）', () => {
  it('表单合法提交 → PATCH /users/:id（载荷 password + currentPassword）', async () => {
    mocked.update.mockResolvedValue({ id: 7 } as never);
    renderCard();

    fillAndSubmit({ current: 'OldPass1!', next: 'NewPass2@x', confirm: 'NewPass2@x' });

    await waitFor(() => expect(mocked.update).toHaveBeenCalledTimes(1));
    expect(mocked.update).toHaveBeenCalledWith(7, {
      password: 'NewPass2@x',
      currentPassword: 'OldPass1!',
    });
  });

  it('两次输入不一致 → 前端拦截，不发出请求', async () => {
    renderCard();
    fillAndSubmit({ current: 'OldPass1!', next: 'NewPass2@x', confirm: 'Other9$zz' });

    // antd 校验失败不提交
    await waitFor(() =>
      expect(screen.getByText('两次输入的新密码不一致')).toBeTruthy(),
    );
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it('新密码强度不足（缺大写/数字/特殊字符）→ 前端拦截', async () => {
    renderCard();
    fillAndSubmit({ current: 'OldPass1!', next: 'weakpassword', confirm: 'weakpassword' });

    await waitFor(() =>
      expect(screen.getByText('须包含至少一个大写字母')).toBeTruthy(),
    );
    expect(mocked.update).not.toHaveBeenCalled();
  });

  it('成功 → 清空本地凭据（强制重新登录）并跳 /login', async () => {
    vi.useFakeTimers();
    try {
      mocked.update.mockResolvedValue({ id: 7 } as never);
      renderCard();
      fillAndSubmit({ current: 'OldPass1!', next: 'NewPass2@x', confirm: 'NewPass2@x' });
      await vi.runAllTimersAsync();

      expect(mocked.update).toHaveBeenCalledWith(7, {
        password: 'NewPass2@x',
        currentPassword: 'OldPass1!',
      });
      // 本地凭据已清空（后端改密 bump 会话版本，旧 token 全部失效）
      expect(useAuthStore.getState()).toMatchObject({
        token: null,
        refreshToken: null,
        user: null,
      });
      // 成功 toast 展示后跳登录页（与 401 过期链路同落点）
      expect(locationStub.href).toBe('/login');
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败（当前密码错误 400）→ 不登出、不清凭据', async () => {
    mocked.update.mockRejectedValue(
      Object.assign(new Error('bad'), {
        response: { data: { message: 'currentPassword is incorrect' } },
      }),
    );
    renderCard();
    fillAndSubmit({ current: 'Wrong1!a', next: 'NewPass2@x', confirm: 'NewPass2@x' });

    await waitFor(() => expect(mocked.update).toHaveBeenCalledTimes(1));
    // 给 onError/toast 一个微任务窗口
    await waitFor(() =>
      expect(screen.getByText('currentPassword is incorrect')).toBeTruthy(),
    );
    expect(useAuthStore.getState()).toMatchObject({
      token: 'tok',
      refreshToken: 'rfsh',
    });
    expect(locationStub.href).toBe('http://localhost/security');
  });
});
