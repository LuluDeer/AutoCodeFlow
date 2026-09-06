/**
 * W1 回归：通知设置页四渠道 Form 曾共用同一 form 实例（页面级唯一 Form.useForm），
 * 且 antd Tabs 非激活面板在访问过后保持挂载（rc-tabs removeOnLeave 默认 false），
 * 同名字段（slack/dingtalk/wecom 均为 webhookUrl）在同一 form store 中互相覆盖：
 *  1) A 渠道输入串写 B 渠道输入框；
 *  2) 切 Tab 的 form.resetFields() 清空所有渠道已填值；
 *  3) A 渠道保存把 B 渠道挂载字段的并集合并写库。
 * 修复：渠道面板抽为 ChannelConfigForm 子组件，每渠道私有 form 实例。
 * 本文件断言：各渠道字段独立、A 保存仅携带 A 自身字段、切 Tab 不串清。
 *
 * 注1：antd 6 从未访问过的 Tab 面板不渲染（rc-motion renderedRef 语义），
 *      用例均先点击 Tab 使面板挂载后再断言。
 * 注2：本环境（jsdom）下 testing-library 对 antd Button 的 accessible-name
 *      计算极慢（单次数百 ms~数 s），故按钮定位用 panel 内 type="submit"
 *      的 querySelector（每渠道面板有且仅有一个「保存」提交按钮），语义等价。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import NotificationSettingsPage from '../pages/NotificationSettingsPage';
import { client } from '../api/client';

// 隔离 api 层：页面直接消费 client.get/patch/post
vi.mock('../api/client', () => ({
  client: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）
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

const DING_PLACEHOLDER = 'https://oapi.dingtalk.com/robot/send?access_token=...';
const WECOM_PLACEHOLDER = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...';
const DING_URL = 'https://oapi.dingtalk.com/robot/send?access_token=ding-hook';
const WECOM_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-hook';

// email 禁用（验证禁用面板不渲染表单），dingtalk/wecom 同时启用——同名字段 webhookUrl 的两个渠道
const channelsFixture = [
  { key: 'email', name: '邮件', enabled: false, config: {}, description: 'SMTP 邮件通知' },
  { key: 'dingtalk', name: '钉钉', enabled: true, config: { webhookUrl: '' }, description: '钉钉机器人通知' },
  { key: 'wecom', name: '企业微信', enabled: true, config: { webhookUrl: '' }, description: '企业微信机器人通知' },
];

beforeEach(() => {
  vi.mocked(client.get).mockReset().mockResolvedValue(channelsFixture as never);
  vi.mocked(client.patch).mockReset().mockResolvedValue(channelsFixture[1] as never);
  vi.mocked(client.post).mockReset();
});

afterEach(() => {
  cleanup();
});

const getDingInput = () =>
  screen.getByPlaceholderText(DING_PLACEHOLDER) as HTMLInputElement;
const getWecomInput = () =>
  screen.getByPlaceholderText(WECOM_PLACEHOLDER) as HTMLInputElement;
/** 面板内唯一提交按钮即「保存」（「发送测试」为 type="button"） */
const getSaveBtn = (pane: HTMLElement) => {
  const btn = pane.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  expect(btn?.textContent).toContain('保'); // antd 汉字按钮自动插空格："保 存"
  return btn as HTMLButtonElement;
};

describe('通知设置页多渠道表单隔离（W1）', () => {
  it('≥2 渠道启用时同名字段各自独立；A 渠道保存不携带 B 渠道字段（精确 payload）', async () => {
    render(<NotificationSettingsPage />);

    // 依次访问两个启用渠道使面板挂载，分别填写同名字段 webhookUrl
    fireEvent.click(await screen.findByRole('tab', { name: /钉钉/ }));
    fireEvent.change(await screen.findByPlaceholderText(DING_PLACEHOLDER), {
      target: { value: DING_URL },
    });
    fireEvent.click(screen.getByRole('tab', { name: /企业微信/ }));
    fireEvent.change(await screen.findByPlaceholderText(WECOM_PLACEHOLDER), {
      target: { value: WECOM_URL },
    });

    // 切回钉钉：两面板均已挂载，同名字段值互不串写（旧共享 form 下两输入框会同值）
    fireEvent.click(screen.getByRole('tab', { name: /钉钉/ }));
    expect(getDingInput().value).toBe(DING_URL);
    expect(getWecomInput().value).toBe(WECOM_URL);

    // 在钉钉面板内点击「保存」
    const dingPane = getDingInput().closest('[role="tabpanel"]') as HTMLElement;
    fireEvent.click(getSaveBtn(dingPane));

    await waitFor(() => expect(client.patch).toHaveBeenCalledTimes(1));
    // 精确匹配：payload 只含钉钉自身字段，不携带企业微信的 webhookUrl 或任何其它键
    expect(client.patch).toHaveBeenCalledWith('/notification/channels/dingtalk', {
      config: { webhookUrl: DING_URL },
    });
    const payload = vi.mocked(client.patch).mock.calls[0][1] as {
      config: Record<string, string>;
    };
    expect(payload.config.webhookUrl).not.toBe(WECOM_URL);
    expect(Object.keys(payload.config)).toEqual(['webhookUrl']);
  });

  it('切 Tab 不清空其它渠道已填值（旧实现 resetFields 会串清所有渠道）', async () => {
    render(<NotificationSettingsPage />);

    // 填钉钉 → 切企微 → 填企微 → 来回切换，双方值均保留
    fireEvent.click(await screen.findByRole('tab', { name: /钉钉/ }));
    fireEvent.change(await screen.findByPlaceholderText(DING_PLACEHOLDER), {
      target: { value: DING_URL },
    });
    fireEvent.click(screen.getByRole('tab', { name: /企业微信/ }));
    fireEvent.change(await screen.findByPlaceholderText(WECOM_PLACEHOLDER), {
      target: { value: WECOM_URL },
    });

    fireEvent.click(screen.getByRole('tab', { name: /钉钉/ }));
    expect(getDingInput().value).toBe(DING_URL);
    expect(getWecomInput().value).toBe(WECOM_URL);

    fireEvent.click(screen.getByRole('tab', { name: /企业微信/ }));
    expect(getWecomInput().value).toBe(WECOM_URL);
    expect(getDingInput().value).toBe(DING_URL);
  });

  it('禁用渠道不渲染配置表单（仅提示）', async () => {
    render(<NotificationSettingsPage />);

    // 访问禁用的 email 渠道：只显示禁用提示，无配置输入（SMTP Host）与保存按钮
    fireEvent.click(await screen.findByRole('tab', { name: /邮件/ }));
    const emailPane = (await screen.findAllByRole('tabpanel')).find((p) =>
      p.id.endsWith('panel-email'),
    ) as HTMLElement;
    expect(emailPane).toBeTruthy();
    expect(
      within(emailPane).getByText('此通知渠道已禁用，启用后可配置推送参数'),
    ).toBeTruthy();
    expect(within(emailPane).queryByPlaceholderText('smtp.example.com')).toBeNull();
    expect(emailPane.querySelector('button[type="submit"]')).toBeNull();
  });
});
