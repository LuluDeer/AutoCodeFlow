/**
 * UI-12 无障碍第一阶段：LoginPage 表单语义与错误播报。
 *
 * 覆盖面：
 *   · 表单具备可访问名（标题与 Form 通过 aria-labelledby 关联）
 *   · 控件与 label 真实关联（label[for] === input[id]，而非仅靠同名 aria-label）
 *   · 首屏焦点落在用户名输入框
 *   · 密码框 type=password、提交按钮 type=submit（原生表单语义可用）
 *   · 登录失败渲染页内 role=alert 错误块并接管焦点（此前只有瞬时 toast）
 *   · 进入 TOTP 阶段：标题/aria-labelledby 同步切换，焦点进入动态码输入框
 *
 * 断言纪律：全部为行为断言（getByRole / aria 属性 / focus 归属 / 键盘事件），
 * 无快照、无「元素存在即通过」。零新增依赖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from '../pages/LoginPage';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({
  authApi: {
    login: vi.fn(),
    verifyLogin: vi.fn(),
    me: vi.fn(),
    refresh: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    totpDisable: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
  },
}));

const mockNav = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNav };
});

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 login-totp.test.tsx 先例）
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

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function submitLoginForm() {
  fireEvent.submit(document.querySelector('form.ant-form')!);
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().logout();
  mockNav.mockReset();
  vi.mocked(authApi.login).mockReset();
  vi.mocked(authApi.verifyLogin).mockReset();
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().logout();
});

describe('UI-12 LoginPage — 表单语义', () => {
  it('表单具备可访问名：标题与 Form 通过 aria-labelledby 关联', () => {
    renderLogin();
    const form = document.querySelector('form.ant-form') as HTMLFormElement;
    const labelledby = form.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(document.getElementById(labelledby as string)?.textContent).toBe('登录账号');
    expect(screen.getByRole('form', { name: '登录账号' })).toBeTruthy();
  });

  it('控件与 label 真实关联（label[for] 指向控件 id），且密码框为 password 类型', () => {
    renderLogin();
    const username = screen.getByLabelText('用户名') as HTMLInputElement;
    const password = screen.getByLabelText('密码') as HTMLInputElement;
    expect(password.getAttribute('type')).toBe('password');

    const labels = Array.from(document.querySelectorAll('label'));
    const userLabel = labels.find((l) => (l.textContent ?? '').trim() === '用户名');
    const pwdLabel = labels.find((l) => (l.textContent ?? '').trim() === '密码');
    expect(userLabel?.getAttribute('for')).toBe(username.getAttribute('id'));
    expect(pwdLabel?.getAttribute('for')).toBe(password.getAttribute('id'));
  });

  it('首屏焦点落在用户名输入框，提交按钮为原生 submit', () => {
    renderLogin();
    expect(document.activeElement).toBe(screen.getByLabelText('用户名'));

    // antd 会在两个汉字间插入排版空格（「登 录」），故用宽松正则匹配可访问名
    const submit = screen.getByRole('button', { name: /登\s*录/ });
    expect(submit.getAttribute('type')).toBe('submit');
  });

  it('Tab 从用户名推进到密码框（无 tabindex 陷阱），Enter 即可提交表单', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.login).mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      user: { id: 1, username: 'alice' },
    } as never);
    renderLogin();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });

    // autoFocus 已在用户名框；Tab 一次推进到密码框（无 tabindex 陷阱）
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('密码'));

    // 键盘完成提交（原生表单语义：输入框内 Enter 触发 submit）
    await user.keyboard('pw123456{Enter}');
    await waitFor(() => expect(authApi.login).toHaveBeenCalledTimes(1));
    expect(mockNav).toHaveBeenCalledWith('/dashboard', { replace: true });
  });
});

describe('UI-12 LoginPage — 失败播报与 TOTP 阶段', () => {
  it('登录失败渲染页内 role=alert 错误块，并接管焦点（替代瞬时 toast）', async () => {
    // Axios 形态错误（err.response.data.message 优先），校验后端文案被原样呈现
    vi.mocked(authApi.login).mockRejectedValue(
      Object.assign(new Error('Request failed'), { response: { data: { message: '账号已被锁定' } } }),
    );
    renderLogin();

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw123456' } });
    submitLoginForm();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('账号已被锁定');
    // 焦点接管：键盘用户无需自行寻找错误位置（焦点落在包裹 alert 的容器上）
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement | null;
      expect(focused).toBeTruthy();
      expect(focused === alert || focused?.contains(alert)).toBe(true);
    });
    expect(mockNav).not.toHaveBeenCalled();
  });

  it('错误块可关闭，关闭后不再占据 alert 角色', async () => {
    vi.mocked(authApi.login).mockRejectedValue(new Error('用户名或密码错误'));
    renderLogin();
    // 必填校验通过后 onFinish 才会发起请求 → 需先填值
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw123456' } });
    submitLoginForm();
    const alert = await screen.findByRole('alert');

    const closeBtn = alert.querySelector('.ant-alert-close-icon') as HTMLElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('进入 TOTP 阶段：标题与 aria-labelledby 同步切换，焦点进入动态码输入框', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ totpRequired: true } as never);
    renderLogin();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw123456' } });
    submitLoginForm();

    const code = await screen.findByLabelText('动态验证码');
    const form = document.querySelector('form.ant-form') as HTMLFormElement;
    expect(form.getAttribute('aria-labelledby')).toBe('login-form-title-totp');
    expect(document.getElementById('login-form-title-totp')?.textContent).toBe('两步验证');
    // 动态码框自动聚焦（autoFocus），键盘用户可直接输入
    await waitFor(() => expect(document.activeElement).toBe(code));
  });

  it('动态码校验失败同样落到页内 role=alert 块', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ totpRequired: true } as never);
    vi.mocked(authApi.verifyLogin).mockRejectedValue(new Error('Invalid TOTP code'));
    renderLogin();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw123456' } });
    submitLoginForm();

    fireEvent.change(await screen.findByLabelText('动态验证码'), { target: { value: '000000' } });
    submitLoginForm();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Invalid TOTP code');
    expect(mockNav).not.toHaveBeenCalled();
  });
});
