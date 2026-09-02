import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as nodemailer from 'nodemailer';

jest.mock('axios');
jest.mock('nodemailer');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedNodemailer = nodemailer as jest.Mocked<typeof nodemailer>;

import { DingtalkChannel } from '../dingtalk.channel';
import { WecomChannel } from '../wecom.channel';
import { WebhookChannel } from '../webhook.channel';
import { EmailChannel } from '../email.channel';
import { SlackChannel } from '../slack.channel';

function makeConfig(values: Record<string, any>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

// ────────────────────────────────────────────────────────────
// DingtalkChannel
// ────────────────────────────────────────────────────────────
describe('DingtalkChannel', () => {
  const payload = { title: 'Test Alert', content: 'Something happened' };

  it('skips silently when webhook URL is not configured', async () => {
    const channel = new DingtalkChannel(makeConfig({}));
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('posts markdown message to configured webhook', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
    const channel = new DingtalkChannel(
      makeConfig({ 'notification.dingtalkWebhook': 'https://oapi.dingtalk.com/robot/send?access_token=xxx' }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://oapi.dingtalk.com/robot/send?access_token=xxx',
      expect.objectContaining({
        msgtype: 'markdown',
        markdown: expect.objectContaining({ title: 'Test Alert' }),
      }),
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('logs error and swallows exception when post fails', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('network error'));
    const channel = new DingtalkChannel(
      makeConfig({ 'notification.dingtalkWebhook': 'https://example.com/hook' }),
    );
    // Should not throw even when axios fails on all retries
    await expect(channel.send(payload)).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// WecomChannel
// ────────────────────────────────────────────────────────────
describe('WecomChannel', () => {
  const payload = { title: 'Wecom Alert', content: 'Details here' };

  beforeEach(() => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
  });

  it('skips silently when webhook URL is not configured', async () => {
    const channel = new WecomChannel(makeConfig({}));
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('posts markdown message to configured webhook', async () => {
    const channel = new WecomChannel(
      makeConfig({ 'notification.wecomWebhook': 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
      expect.objectContaining({
        msgtype: 'markdown',
        markdown: expect.objectContaining({ content: expect.stringContaining('Wecom Alert') }),
      }),
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('logs error and swallows exception when post fails', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('connection refused'));
    const channel = new WecomChannel(
      makeConfig({ 'notification.wecomWebhook': 'https://example.com/hook' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// WebhookChannel
// ────────────────────────────────────────────────────────────
describe('WebhookChannel', () => {
  const payload = { title: 'Webhook Test', content: 'Body text', level: 'error' as any };

  beforeEach(() => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
  });

  it('skips silently when URL is not configured', async () => {
    const channel = new WebhookChannel(makeConfig({}));
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('uses config URL when no explicit URL passed', async () => {
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'https://example.com/notify' }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/notify',
      expect.objectContaining({ title: 'Webhook Test', level: 'error' }),
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
  });

  it('uses explicit URL argument over config URL', async () => {
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'https://config-url.com' }),
    );
    await channel.send(payload, 'https://example.com/override');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/override',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('NOTIF-001: refuses loopback URL and skips silently', async () => {
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'http://127.0.0.1:9000' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('NOTIF-001: refuses AWS metadata URL', async () => {
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'http://169.254.169.254/latest' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('NOTIF-001: refuses private RFC1918 URL', async () => {
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'http://10.0.0.5/admin' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('NOTIF-001: refuses non-http(s) schemes', async () => {
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'file:///etc/passwd' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('includes level=info as default when level not provided', async () => {
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'https://example.com/notify' }),
    );
    await channel.send({ title: 'No level', content: 'content' });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ level: 'info' }),
      expect.any(Object),
    );
  });

  it('logs error and swallows exception when post fails', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('timeout'));
    const channel = new WebhookChannel(
      makeConfig({ 'notification.webhookUrl': 'https://example.com/notify' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// F-3: dingtalk/wecom/slack channels share the SSRF chokepoint
// ────────────────────────────────────────────────────────────
describe('F-3: SSRF guard on env-configured notification channels', () => {
  const payload = { title: 'F3', content: 'body' } as any;

  beforeEach(() => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
  });

  it('DingtalkChannel: refuses metadata URL and skips silently', async () => {
    const channel = new DingtalkChannel(
      makeConfig({ 'notification.dingtalkWebhook': 'http://169.254.169.254/hook' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('DingtalkChannel: refuses loopback URL and skips silently', async () => {
    const channel = new DingtalkChannel(
      makeConfig({ 'notification.dingtalkWebhook': 'http://127.0.0.1:9000/hook' }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('WecomChannel: refuses private RFC1918 URL and skips silently', async () => {
    const channel = new WecomChannel(
      makeConfig({ 'notification.wecomWebhook': 'http://10.0.0.5/hook' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('SlackChannel: refuses metadata URL and skips silently', async () => {
    const channel = new SlackChannel(
      makeConfig({ 'notification.slackWebhook': 'http://169.254.169.254/latest' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('still delivers to a public webhook URL', async () => {
    const channel = new DingtalkChannel(
      makeConfig({ 'notification.dingtalkWebhook': 'https://oapi.dingtalk.com/robot/send?access_token=xxx' }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://oapi.dingtalk.com/robot/send?access_token=xxx',
      expect.anything(),
      expect.anything(),
    );
  });
});

// ────────────────────────────────────────────────────────────
// EmailChannel
// ────────────────────────────────────────────────────────────
describe('EmailChannel', () => {
  const payload = { title: 'Email Subject', content: 'Email body text' };
  let sendMailMock: jest.Mock;
  let createTransportSpy: jest.SpyInstance;

  beforeEach(() => {
    sendMailMock = jest.fn().mockResolvedValue({ messageId: '123' });
    createTransportSpy = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail: sendMailMock } as any);
  });

  afterEach(() => {
    createTransportSpy.mockRestore();
  });

  it('skips silently when email config is incomplete', async () => {
    const channel = new EmailChannel(makeConfig({}));
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(createTransportSpy).not.toHaveBeenCalled();
  });

  it('skips when host is missing', async () => {
    const channel = new EmailChannel(
      makeConfig({ 'notification.email.user': 'u', 'notification.email.to': 'to@x.com' }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
    expect(createTransportSpy).not.toHaveBeenCalled();
  });

  it('sends email when fully configured', async () => {
    const channel = new EmailChannel(
      makeConfig({
        'notification.email.host': 'smtp.example.com',
        'notification.email.user': 'user@example.com',
        'notification.email.to': 'dest@example.com',
        'notification.email.pass': 'secret',
        'notification.email.port': 465,
        'notification.email.secure': true,
        'notification.email.from': 'from@example.com',
      }),
    );
    await channel.send(payload);
    expect(createTransportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true }),
    );
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'dest@example.com',
        subject: 'Email Subject',
        text: 'Email body text',
      }),
    );
  });

  it('uses user as from when from is not configured', async () => {
    const channel = new EmailChannel(
      makeConfig({
        'notification.email.host': 'smtp.example.com',
        'notification.email.user': 'user@example.com',
        'notification.email.to': 'dest@example.com',
      }),
    );
    await channel.send(payload);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'user@example.com' }),
    );
  });

  it('logs error and swallows exception when sendMail fails', async () => {
    sendMailMock.mockRejectedValue(new Error('SMTP error'));
    const channel = new EmailChannel(
      makeConfig({
        'notification.email.host': 'smtp.example.com',
        'notification.email.user': 'user@example.com',
        'notification.email.to': 'dest@example.com',
      }),
    );
    await expect(channel.send(payload)).resolves.toBeUndefined();
  });
});
