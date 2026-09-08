/**
 * QA-03 第一阶段：NotificationSettingsPage 主页面补测（静默规则 Tab 已有
 * notification-silences.test.tsx 专项，本文件补既有测试未覆盖的主页面面）。
 *
 * 覆盖核心交互：
 *  1) 渠道 Tab 渲染（启用/禁用 Tag、Tab 切换、禁用渠道的 Alert 提示）；
 *  2) 渠道启停开关（updateChannel 调用 + toast 文案）；
 *  3) 权限渲染（非管理员：不渲染「静默规则」Tab 且不发起 ADMIN-only 请求
 *     ——FEAT-01 既有语义回归；管理员：渲染）；
 *  4) 全局测试发送（必填校验失败拦截 / 成功 → 成功 Alert / 失败 → 错误
 *     Alert 文案拼接）。
 *
 * 隔离 api 层：client + silencesApi 全 mock（对齐 notification-silences 先例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import NotificationSettingsPage from '../pages/NotificationSettingsPage';
import { client } from '../api/client';
import { silencesApi } from '../api/notifications';
import { useAuthStore } from '../store/auth';

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

const channelsFixture = [
  { key: 'email', name: '邮件', enabled: true, config: {}, description: 'SMTP 邮件通知' },
  { key: 'slack', name: 'Slack', enabled: false, config: {}, description: 'Slack Webhook' },
];

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedClient.get.mockReset().mockImplementation((url: string) => {
    if (String(url) === '/notification/channels') return Promise.resolve(channelsFixture);
    return Promise.resolve([]);
  });
  mockedClient.patch.mockReset();
  mockedClient.post.mockReset();
  mockedSilences.list.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('渠道 Tab 渲染与启停（QA-03）', () => {
  it('渲染渠道 Tab 与启用状态 Tag，禁用渠道面板显示 Alert 提示', async () => {
    render(<NotificationSettingsPage />);
    // 邮件 Tab 默认激活（activeTab 初始 'email'）
    expect(await screen.findByText('启用此通知渠道：')).toBeTruthy();
    // Slack Tab 标签带「已禁用」Tag
    expect(screen.getByText('已禁用')).toBeTruthy();

    // 切到 Slack（禁用渠道）→ 面板为 Alert 提示而非表单
    fireEvent.click(screen.getByRole('tab', { name: /Slack/ }));
    expect(await screen.findByText('此通知渠道已禁用，启用后可配置推送参数')).toBeTruthy();
  });

  it('关闭邮件渠道开关 → PATCH /notification/channels/email {enabled:false} + 禁用 toast', async () => {
    mockedClient.patch.mockResolvedValue(channelsFixture[0]);
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');

    // 当前 enabled=true → 开关为开
    const switches = document.querySelectorAll('button.ant-switch');
    expect(switches.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(switches[0]);

    await waitFor(() => {
      expect(mockedClient.patch).toHaveBeenCalledWith('/notification/channels/email', { enabled: false });
    });
    expect(await screen.findByText('已禁用 邮件')).toBeTruthy();
  });
});

// ── UI-15：请求级失败（reject）反馈断言 ──
describe('渠道启停与测试发送请求失败（UI-15）', () => {
  it('渠道开关 PATCH reject → 错误 toast，不再静默', async () => {
    mockedClient.patch.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '渠道配置锁定' } } }),
    );
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');

    const switches = document.querySelectorAll('button.ant-switch');
    fireEvent.click(switches[0]);

    await waitFor(() => {
      expect(mockedClient.patch).toHaveBeenCalledWith('/notification/channels/email', { enabled: false });
    });
    expect(await screen.findByText('渠道配置锁定')).toBeTruthy();
  });

  it('全局测试发送 POST reject → 错误 Alert（UI-15 onError 补齐）', async () => {
    mockedClient.post.mockRejectedValue(new Error('gateway timeout'));
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');

    fireEvent.click(screen.getByLabelText('邮件'));
    fireEvent.change(screen.getByPlaceholderText('测试通知'), { target: { value: '演练标题' } });
    fireEvent.change(screen.getByPlaceholderText('这是一条测试通知...'), { target: { value: '演练内容' } });
    fireEvent.click(findBtn(document.body, '发送测试通知')!);

    await waitFor(() => {
      expect(mockedClient.post).toHaveBeenCalled();
    });
    expect(await screen.findByText('发送失败：gateway timeout')).toBeTruthy();
  });
});

describe('权限渲染（QA-03 / FEAT-01 回归）', () => {
  it('管理员：渲染「静默规则」Tab', async () => {
    mockedSilences.list.mockResolvedValue([]);
    render(<NotificationSettingsPage />);
    expect(await screen.findByRole('tab', { name: /静默规则/ })).toBeTruthy();
  });

  it('非管理员：不渲染「静默规则」Tab 且不发起 silences 请求', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');
    expect(screen.queryByRole('tab', { name: /静默规则/ })).toBeNull();
    expect(mockedSilences.list).not.toHaveBeenCalled();
  });
});

describe('全局测试发送（QA-03）', () => {
  it('必填缺失 → 校验拦截，不发起 POST /notification/test', async () => {
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');

    fireEvent.click(findBtn(document.body, '发送测试通知')!);
    // channels rule 自带 message；title/content 无 message → antd 默认「'标题' is required」中文 warning 提示
    await screen.findByText('请选择至少一个渠道');
    expect(mockedClient.post).not.toHaveBeenCalled();
  });

  it('发送成功 → POST /notification/test 载荷正确 + 成功 Alert', async () => {
    mockedClient.post.mockResolvedValue({ success: true, message: 'ok' });
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');

    // 勾选邮件渠道
    fireEvent.click(screen.getByLabelText('邮件'));
    fireEvent.change(screen.getByPlaceholderText('测试通知'), { target: { value: '演练标题' } });
    fireEvent.change(screen.getByPlaceholderText('这是一条测试通知...'), { target: { value: '演练内容' } });
    fireEvent.click(findBtn(document.body, '发送测试通知')!);

    await waitFor(() => {
      expect(mockedClient.post).toHaveBeenCalledWith('/notification/test', {
        channels: ['email'],
        title: '演练标题',
        content: '演练内容',
      });
    });
    expect(await screen.findByText('测试通知已发送到所选渠道')).toBeTruthy();
  });

  it('发送失败 → 错误 Alert 拼接响应 message', async () => {
    mockedClient.post.mockResolvedValue({ success: false, message: 'SMTP 未配置' });
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');

    fireEvent.click(screen.getByLabelText('邮件'));
    fireEvent.change(screen.getByPlaceholderText('测试通知'), { target: { value: '演练标题' } });
    fireEvent.change(screen.getByPlaceholderText('这是一条测试通知...'), { target: { value: '演练内容' } });
    fireEvent.click(findBtn(document.body, '发送测试通知')!);

    await waitFor(() => {
      expect(mockedClient.post).toHaveBeenCalled();
    });
    expect(await screen.findByText('发送失败：SMTP 未配置')).toBeTruthy();
  });
});

// ─── FEAT-10: 渠道级消息模板编辑（可折叠 TextArea + 变量说明）────────────────
describe('FEAT-10 渠道消息模板', () => {
  it('未配置模板时面板折叠态渲染，展开后出现标题/内容模板输入', async () => {
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');

    // 折叠态：inner Card 标题 + 提示
    expect(await screen.findByText('消息模板（可选）')).toBeTruthy();
    expect(screen.getByText('未配置模板 — 使用系统默认内容格式。')).toBeTruthy();

    // 展开
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(await screen.findByText('标题模板')).toBeTruthy();
    expect(screen.getByText('内容模板')).toBeTruthy();
  });

  it('填写模板并保存 → PATCH config 携带 titleTemplate/contentTemplate', async () => {
    mockedClient.patch.mockResolvedValue(channelsFixture[0]);
    render(<NotificationSettingsPage />);
    await screen.findByText('启用此通知渠道：');
    fireEvent.click(screen.getByRole('button', { name: '展开' }));

    fireEvent.change(await screen.findByPlaceholderText('例如：[{{level}}] 任务 {{taskName}} 执行失败'), {
      target: { value: '[{{level}}] {{taskName}}' },
    });
    fireEvent.click(findBtn(document.body, '保存模板')!);

    await waitFor(() => {
      expect(mockedClient.patch).toHaveBeenCalledWith('/notification/channels/email', {
        config: { titleTemplate: '[{{level}}] {{taskName}}', contentTemplate: '' },
      });
    });
    expect(await screen.findByText('模板已保存')).toBeTruthy();
  });

  it('已配置模板的渠道展开渲染（预填模板值）', async () => {
    mockedClient.get.mockImplementation((url: string) => {
      if (String(url) === '/notification/channels') {
        return Promise.resolve([
          {
            key: 'dingtalk',
            name: '钉钉',
            enabled: true,
            config: { titleTemplate: '[{{level}}] {{task}}', contentTemplate: '' },
            description: '钉钉群机器人',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<NotificationSettingsPage />);
    // fixture 只含钉钉渠道，而页面 activeTab 默认 'email' —— 必须先点击
    // 钉钉 Tab 让面板挂载，否则找不到任何模板输入
    fireEvent.click(await screen.findByRole('tab', { name: /钉钉/ }));

    // 已配置 → 默认展开（无「展开」按钮），TextArea 预填已保存模板
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull();
    const titleArea = (await screen.findByPlaceholderText(
      '例如：[{{level}}] 任务 {{taskName}} 执行失败',
    )) as HTMLTextAreaElement;
    expect(titleArea.value).toBe('[{{level}}] {{task}}');
  });
});
