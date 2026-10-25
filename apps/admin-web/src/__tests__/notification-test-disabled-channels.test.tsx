/**
 * P3-④（审计）回归：全局测试发送对「所选渠道全部禁用」的前端预判。
 *
 * 后端 notification-config.service sendTest 对零投递场景回 200 + success:false
 * + **英文 message**（"No enabled channels to test…"，不带 errorCode）——
 * getErrMsg 的 errorCode 本地化路径走不到，用户会看到裸英文。修复：发送前
 * 用已加载的渠道列表预判，全禁用/未知时直接给本地化提示，不发注定空转的请求。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import NotificationSettingsPage from '../pages/NotificationSettingsPage';
import { client } from '../api/client';
import { silencesApi } from '../api/notifications';
import { useAuthStore } from '../store/auth';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('../api/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/notifications')>();
  return {
    ...actual,
    silencesApi: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
  };
});
const mockedClient = vi.mocked(client, true);
const mockedSilences = vi.mocked(silencesApi, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
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

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

const renderPage = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/notifications']}>
        <NotificationSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const fillAndSubmit = () => {
  fireEvent.click(screen.getByLabelText('邮件'));
  fireEvent.change(screen.getByPlaceholderText('测试通知'), { target: { value: '演练标题' } });
  fireEvent.change(screen.getByPlaceholderText('这是一条测试通知...'), { target: { value: '演练内容' } });
  fireEvent.click(findBtn(document.body, '发送测试通知')!);
};

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedClient.get.mockReset().mockImplementation((url: string) => {
    if (String(url) === '/notification/channels') return Promise.resolve([]);
    return Promise.resolve([]);
  });
  mockedClient.patch.mockReset();
  mockedClient.post.mockReset().mockResolvedValue({ success: true, message: 'ok' });
  mockedSilences.list.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe('P3-④ 全局测试发送全渠道禁用预判', () => {
  it('所选渠道全部禁用 → 本地化提示，不发起 POST /notification/test', async () => {
    mockedClient.get.mockImplementation((url: string) => {
      if (String(url) === '/notification/channels') {
        return Promise.resolve([
          { key: 'email', name: '邮件', enabled: false, config: {}, description: '' },
          { key: 'slack', name: 'Slack', enabled: false, config: {}, description: '' },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPage();
    await screen.findByText('启用此通知渠道：');

    fillAndSubmit();

    // 预判拦截：错误 Alert 显示本地化文案（不再透出后端英文 message）
    expect(await screen.findByText(/所选渠道全部处于禁用状态/)).toBeTruthy();
    expect(mockedClient.post).not.toHaveBeenCalled();
  });

  it('所选渠道含未配置的未知渠道且无启用渠道 → 同样预判拦截', async () => {
    // 渠道列表里 email 禁用；用户勾选 email（禁用）→ 未知/禁用都不放行
    mockedClient.get.mockImplementation((url: string) => {
      if (String(url) === '/notification/channels') {
        return Promise.resolve([
          { key: 'email', name: '邮件', enabled: false, config: {}, description: '' },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPage();
    await screen.findByText('启用此通知渠道：');

    fillAndSubmit();
    expect(await screen.findByText(/所选渠道全部处于禁用状态/)).toBeTruthy();
    expect(mockedClient.post).not.toHaveBeenCalled();
  });

  it('所选渠道有启用项 → 正常发送（既有行为不回归）', async () => {
    mockedClient.get.mockImplementation((url: string) => {
      if (String(url) === '/notification/channels') {
        return Promise.resolve([
          { key: 'email', name: '邮件', enabled: true, config: {}, description: '' },
          { key: 'slack', name: 'Slack', enabled: false, config: {}, description: '' },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPage();
    await screen.findByText('启用此通知渠道：');

    fillAndSubmit();
    await waitFor(() =>
      expect(mockedClient.post).toHaveBeenCalledWith('/notification/test', {
        channels: ['email'],
        title: '演练标题',
        content: '演练内容',
      }),
    );
    expect(await screen.findByText('测试通知已发送到所选渠道')).toBeTruthy();
  });
});
