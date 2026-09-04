import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as nodemailer from "nodemailer";

jest.mock("axios");
jest.mock("nodemailer");
// V3 (round-7): assertSafeHttpUrl resolves hostnames via real DNS — dev
// machines behind a TUN/proxy stack hand out 198.18.0.0/15 answers (now on
// the deny list), which would make these tests environment-dependent.
// Mock the resolver so hostnames always "resolve" to a public address;
// IP-literal SSRF cases are unaffected.
jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

import { DingtalkChannel } from "../dingtalk.channel";
import { WecomChannel } from "../wecom.channel";
import { WebhookChannel } from "../webhook.channel";
import { EmailChannel } from "../email.channel";
import { SlackChannel } from "../slack.channel";
import { ChannelConfigStore } from "../../channel-config.store";

function makeConfig(values: Record<string, any>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

// V1: a store pre-seeded with saved channel configs (what PATCH
// /notification/channels/:key persists at runtime).
function makeStore(values: Record<string, Record<string, string>> = {}) {
  const store = new ChannelConfigStore();
  for (const [key, config] of Object.entries(values)) store.set(key, config);
  return store;
}

// ────────────────────────────────────────────────────────────
// DingtalkChannel
// ────────────────────────────────────────────────────────────
describe("DingtalkChannel", () => {
  const payload = { title: "Test Alert", content: "Something happened" };

  it("skips (status 'skipped') when webhook URL is not configured", async () => {
    const channel = new DingtalkChannel(makeConfig({}), makeStore());
    await expect(channel.send(payload)).resolves.toBe("skipped");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("posts markdown message to configured webhook", async () => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
    const channel = new DingtalkChannel(
      makeConfig({
        "notification.dingtalkWebhook":
          "https://oapi.dingtalk.com/robot/send?access_token=xxx",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("sent");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://oapi.dingtalk.com/robot/send?access_token=xxx",
      expect.objectContaining({
        msgtype: "markdown",
        markdown: expect.objectContaining({ title: "Test Alert" }),
      }),
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("logs error and returns 'failed' when post fails", async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error("network error"));
    const channel = new DingtalkChannel(
      makeConfig({
        "notification.dingtalkWebhook": "https://example.com/hook",
      }),
      makeStore(),
    );
    // Should not throw even when axios fails on all retries
    await expect(channel.send(payload)).resolves.toBe("failed");
  });

  // V1: saved channel config wins over the env default
  it("prefers saved channel config over env webhook", async () => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
    const channel = new DingtalkChannel(
      makeConfig({ "notification.dingtalkWebhook": "https://env.example.com" }),
      makeStore({ dingtalk: { webhookUrl: "https://saved.example.com" } }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://saved.example.com",
      expect.anything(),
      expect.anything(),
    );
  });

  // V1: empty saved value falls back to env (维持现 env 行为)
  it("falls back to env when saved config has no webhookUrl", async () => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
    const channel = new DingtalkChannel(
      makeConfig({ "notification.dingtalkWebhook": "https://env.example.com" }),
      makeStore({ dingtalk: { webhookUrl: "" } }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://env.example.com",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ────────────────────────────────────────────────────────────
// WecomChannel
// ────────────────────────────────────────────────────────────
describe("WecomChannel", () => {
  const payload = { title: "Wecom Alert", content: "Details here" };

  beforeEach(() => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
  });

  it("skips (status 'skipped') when webhook URL is not configured", async () => {
    const channel = new WecomChannel(makeConfig({}), makeStore());
    await expect(channel.send(payload)).resolves.toBe("skipped");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("posts markdown message to configured webhook", async () => {
    const channel = new WecomChannel(
      makeConfig({
        "notification.wecomWebhook":
          "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("sent");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
      expect.objectContaining({
        msgtype: "markdown",
        markdown: expect.objectContaining({
          content: expect.stringContaining("Wecom Alert"),
        }),
      }),
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("logs error and returns 'failed' when post fails", async () => {
    mockedAxios.post = jest
      .fn()
      .mockRejectedValue(new Error("connection refused"));
    const channel = new WecomChannel(
      makeConfig({ "notification.wecomWebhook": "https://example.com/hook" }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("failed");
  });

  // V1: saved channel config wins over the env default
  it("prefers saved channel config over env webhook", async () => {
    const channel = new WecomChannel(
      makeConfig({ "notification.wecomWebhook": "https://env.example.com" }),
      makeStore({ wecom: { webhookUrl: "https://saved.example.com" } }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://saved.example.com",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ────────────────────────────────────────────────────────────
// WebhookChannel
// ────────────────────────────────────────────────────────────
describe("WebhookChannel", () => {
  const payload = {
    title: "Webhook Test",
    content: "Body text",
    level: "error" as any,
  };

  beforeEach(() => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
  });

  it("skips (status 'skipped') when URL is not configured", async () => {
    const channel = new WebhookChannel(makeStore());
    await expect(channel.send(payload)).resolves.toBe("skipped");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  // V1/V5: the target comes from the per-request url argument or the saved
  // channel config — the never-defined `notification.webhookUrl` env key is
  // gone (dead reference removed in round 7).
  // N32 (round-9) made "webhook" PATCH-able with config shape `{ url }`;
  // N37 (round-10) fixes the resolution chain: explicit request argument >
  // saved AND enabled channel config > env fallback (none for webhook).
  it("uses saved channel config when no explicit URL passed", async () => {
    const channel = new WebhookChannel(
      makeStore({ webhook: { url: "https://example.com/notify" } }),
    );
    await expect(channel.send(payload)).resolves.toBe("sent");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://example.com/notify",
      expect.objectContaining({ title: "Webhook Test", level: "error" }),
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  // N37 (round-10): updates the round-9 "prefers saved channel config url
  // over the explicit URL argument (N32 config-first)" case — an explicit
  // per-request url must never be silently rerouted to the saved config.
  it("prefers the explicit URL argument over the saved channel config (N37)", async () => {
    const channel = new WebhookChannel(
      makeStore({ webhook: { url: "https://config-url.com" } }),
    );
    await channel.send(payload, "https://example.com/override");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://example.com/override",
      expect.any(Object),
      expect.any(Object),
    );
  });

  // N37: a DISABLED channel's saved url must not take effect either — the
  // send falls back to the explicit argument (here) / nothing (below).
  it("ignores the saved config url when the channel is disabled (N37)", async () => {
    const store = new ChannelConfigStore();
    store.set("webhook", { url: "https://config-url.com" }, false);
    const channel = new WebhookChannel(store);
    await expect(channel.send(payload)).resolves.toBe("skipped");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("falls back to the explicit URL argument when the channel is disabled (N37)", async () => {
    const store = new ChannelConfigStore();
    store.set("webhook", { url: "https://config-url.com" }, false);
    const channel = new WebhookChannel(store);
    await channel.send(payload, "https://example.com/override");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://example.com/override",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("falls back to the explicit URL argument when no config url is saved", async () => {
    const channel = new WebhookChannel(makeStore({ webhook: { url: "" } }));
    await channel.send(payload, "https://example.com/override");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://example.com/override",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("NOTIF-001: refuses loopback URL and reports 'blocked'", async () => {
    const channel = new WebhookChannel(makeStore());
    await expect(channel.send(payload, "http://127.0.0.1:9000")).resolves.toBe(
      "blocked",
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("NOTIF-001: refuses AWS metadata URL and reports 'blocked'", async () => {
    const channel = new WebhookChannel(makeStore());
    await expect(
      channel.send(payload, "http://169.254.169.254/latest"),
    ).resolves.toBe("blocked");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("NOTIF-001: refuses private RFC1918 URL and reports 'blocked'", async () => {
    const channel = new WebhookChannel(makeStore());
    await expect(channel.send(payload, "http://10.0.0.5/admin")).resolves.toBe(
      "blocked",
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  // V3 (round-7): the TUN-occupied benchmark range used to bypass the guard
  it("V3: refuses RFC 2544 benchmark URL (198.18.0.0/15)", async () => {
    const channel = new WebhookChannel(makeStore());
    await expect(
      channel.send(payload, "http://198.18.0.1:9999/webhook"),
    ).resolves.toBe("blocked");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  // V3 (round-7): CGNAT (Tailscale) range
  it("V3: refuses CGNAT URL (100.64.0.0/10)", async () => {
    const channel = new WebhookChannel(makeStore());
    await expect(
      channel.send(payload, "http://100.64.0.1:9999/webhook"),
    ).resolves.toBe("blocked");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("NOTIF-001: refuses non-http(s) schemes", async () => {
    const channel = new WebhookChannel(makeStore());
    await expect(channel.send(payload, "file:///etc/passwd")).resolves.toBe(
      "blocked",
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("includes level=info as default when level not provided", async () => {
    const channel = new WebhookChannel(
      makeStore({ webhook: { url: "https://example.com/notify" } }),
    );
    await channel.send({ title: "No level", content: "content" });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ level: "info" }),
      expect.any(Object),
    );
  });

  it("logs error and returns 'failed' when post fails", async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error("timeout"));
    const channel = new WebhookChannel(
      makeStore({ webhook: { url: "https://example.com/notify" } }),
    );
    await expect(channel.send(payload)).resolves.toBe("failed");
  });
});

// ────────────────────────────────────────────────────────────
// F-3: dingtalk/wecom/slack channels share the SSRF chokepoint
// ────────────────────────────────────────────────────────────
describe("F-3: SSRF guard on env-configured notification channels", () => {
  const payload = { title: "F3", content: "body" } as any;

  beforeEach(() => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
  });

  it("DingtalkChannel: refuses metadata URL and reports 'blocked'", async () => {
    const channel = new DingtalkChannel(
      makeConfig({
        "notification.dingtalkWebhook": "http://169.254.169.254/hook",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("blocked");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("DingtalkChannel: refuses loopback URL and reports 'blocked'", async () => {
    const channel = new DingtalkChannel(
      makeConfig({
        "notification.dingtalkWebhook": "http://127.0.0.1:9000/hook",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("blocked");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("WecomChannel: refuses private RFC1918 URL and reports 'blocked'", async () => {
    const channel = new WecomChannel(
      makeConfig({ "notification.wecomWebhook": "http://10.0.0.5/hook" }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("blocked");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("SlackChannel: refuses metadata URL and reports 'blocked'", async () => {
    const channel = new SlackChannel(
      makeConfig({
        "notification.slackWebhook": "http://169.254.169.254/latest",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("blocked");
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("still delivers to a public webhook URL", async () => {
    const channel = new DingtalkChannel(
      makeConfig({
        "notification.dingtalkWebhook":
          "https://oapi.dingtalk.com/robot/send?access_token=xxx",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("sent");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://oapi.dingtalk.com/robot/send?access_token=xxx",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ────────────────────────────────────────────────────────────
// SlackChannel — V1 config precedence
// ────────────────────────────────────────────────────────────
describe("SlackChannel config precedence (V1)", () => {
  const payload = { title: "Slack V1", content: "body" } as any;

  beforeEach(() => {
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });
  });

  it("prefers saved channel config over env webhook", async () => {
    const channel = new SlackChannel(
      makeConfig({ "notification.slackWebhook": "https://env.example.com" }),
      makeStore({ slack: { webhookUrl: "https://saved.example.com" } }),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://saved.example.com",
      expect.anything(),
      expect.anything(),
    );
  });

  it("falls back to env when nothing was saved", async () => {
    const channel = new SlackChannel(
      makeConfig({ "notification.slackWebhook": "https://env.example.com" }),
      makeStore(),
    );
    await channel.send(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://env.example.com",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ────────────────────────────────────────────────────────────
// EmailChannel
// ────────────────────────────────────────────────────────────
describe("EmailChannel", () => {
  const payload = { title: "Email Subject", content: "Email body text" };
  let sendMailMock: jest.Mock;
  let createTransportSpy: jest.SpyInstance;

  beforeEach(() => {
    sendMailMock = jest.fn().mockResolvedValue({ messageId: "123" });
    createTransportSpy = jest
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail: sendMailMock } as any);
  });

  afterEach(() => {
    createTransportSpy.mockRestore();
  });

  it("skips (status 'skipped') when email config is incomplete", async () => {
    const channel = new EmailChannel(makeConfig({}), makeStore());
    await expect(channel.send(payload)).resolves.toBe("skipped");
    expect(createTransportSpy).not.toHaveBeenCalled();
  });

  it("skips when host is missing", async () => {
    const channel = new EmailChannel(
      makeConfig({
        "notification.email.user": "u",
        "notification.email.to": "to@x.com",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("skipped");
    expect(createTransportSpy).not.toHaveBeenCalled();
  });

  it("sends email when fully configured", async () => {
    const channel = new EmailChannel(
      makeConfig({
        "notification.email.host": "smtp.example.com",
        "notification.email.user": "user@example.com",
        "notification.email.to": "dest@example.com",
        "notification.email.pass": "secret",
        "notification.email.port": 465,
        "notification.email.secure": true,
        "notification.email.from": "from@example.com",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("sent");
    expect(createTransportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 465,
        secure: true,
      }),
    );
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dest@example.com",
        subject: "Email Subject",
        text: "Email body text",
      }),
    );
  });

  it("uses user as from when from is not configured", async () => {
    const channel = new EmailChannel(
      makeConfig({
        "notification.email.host": "smtp.example.com",
        "notification.email.user": "user@example.com",
        "notification.email.to": "dest@example.com",
      }),
      makeStore(),
    );
    await channel.send(payload);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "user@example.com" }),
    );
  });

  it("logs error and returns 'failed' when sendMail fails", async () => {
    sendMailMock.mockRejectedValue(new Error("SMTP error"));
    const channel = new EmailChannel(
      makeConfig({
        "notification.email.host": "smtp.example.com",
        "notification.email.user": "user@example.com",
        "notification.email.to": "dest@example.com",
      }),
      makeStore(),
    );
    await expect(channel.send(payload)).resolves.toBe("failed");
  });

  // V1: SMTP settings saved via PATCH /channels/email drive the actual send,
  // env is fallback only. The RAW stored password (not the '***' masked echo)
  // must reach the transporter.
  it("prefers saved SMTP config over env, including the raw password", async () => {
    const channel = new EmailChannel(
      makeConfig({
        "notification.email.host": "env.example.com",
        "notification.email.user": "env@example.com",
        "notification.email.to": "env-dest@example.com",
        "notification.email.pass": "env-pass",
        "notification.email.port": 465,
        "notification.email.secure": true,
      }),
      makeStore({
        email: {
          host: "saved.example.com",
          port: "587",
          secure: "false",
          user: "saved@example.com",
          password: "real-smtp-secret",
          from: "saved-from@example.com",
          to: "saved-dest@example.com",
        },
      }),
    );
    await channel.send(payload);
    expect(createTransportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "saved.example.com",
        port: 587,
        secure: false,
        auth: { user: "saved@example.com", pass: "real-smtp-secret" },
      }),
    );
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "saved-from@example.com",
        to: "saved-dest@example.com",
      }),
    );
  });
});
