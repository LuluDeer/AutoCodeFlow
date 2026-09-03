import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationConfigService } from "../notification-config.service";
import { NotificationService } from "../notification.service";
import { ChannelConfigStore } from "../channel-config.store";

describe("NotificationConfigService", () => {
  let service: NotificationConfigService;
  let store: ChannelConfigStore;
  let notificationService: jest.Mocked<Partial<NotificationService>>;

  beforeEach(async () => {
    notificationService = {
      sendAll: jest.fn(),
      sendToChannels: jest.fn().mockResolvedValue({}),
    };
    store = new ChannelConfigStore();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationConfigService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: NotificationService,
          useValue: notificationService,
        },
        { provide: ChannelConfigStore, useValue: store },
      ],
    }).compile();

    service = module.get<NotificationConfigService>(NotificationConfigService);
  });

  describe("getAllChannels", () => {
    it("should return all 5 default channels", () => {
      const channels = service.getAllChannels();
      expect(channels).toHaveLength(5);
      const keys = channels.map((c) => c.key);
      expect(keys).toContain("email");
      expect(keys).toContain("slack");
      expect(keys).toContain("dingtalk");
      expect(keys).toContain("wecom");
      // N32 (round-9): webhook joined the PATCH-able enum (V2 §7.1 gap).
      expect(keys).toContain("webhook");
    });

    it("should have all channels disabled by default", () => {
      const channels = service.getAllChannels();
      channels.forEach((c) => expect(c.enabled).toBe(false));
    });
  });

  describe("getChannel", () => {
    it("should return the channel for a known key", () => {
      const ch = service.getChannel("email");
      expect(ch).toBeDefined();
      expect(ch!.key).toBe("email");
    });

    it("should return undefined for unknown key", () => {
      expect(service.getChannel("unknown")).toBeUndefined();
    });
  });

  describe("updateChannel", () => {
    it("should enable a channel", () => {
      service.updateChannel("slack", { enabled: true });
      expect(service.getChannel("slack")!.enabled).toBe(true);
    });

    it("should merge config fields", () => {
      service.updateChannel("dingtalk", {
        config: { webhookUrl: "https://oapi.dingtalk.com/robot/xxx" },
      });
      expect(service.getChannel("dingtalk")!.config.webhookUrl).toBe(
        "https://oapi.dingtalk.com/robot/xxx",
      );
    });

    // V4 (round-7): unknown keys used to escape as a bare Error → HTTP 500.
    // The channel key set is a fixed enum → 400 with the valid keys listed.
    it("should throw BadRequestException (400, not 500) for unknown channel key", () => {
      expect(() =>
        service.updateChannel("telegram", { enabled: true }),
      ).toThrow(BadRequestException);
      expect(() =>
        service.updateChannel("telegram", { enabled: true }),
      ).toThrow(/Unknown notification channel: telegram/);
      // 消息列出合法 key；N32 起 webhook 也是可配置渠道
      try {
        service.updateChannel("telegram", { enabled: true });
      } catch (e: unknown) {
        const msg = (e as Error).message;
        for (const key of ["email", "slack", "dingtalk", "wecom", "webhook"]) {
          expect(msg).toContain(key);
        }
      }
    });

    // N32 (round-9): the V4 repro — PATCH /channels/webhook — is now a
    // supported 200 path (config shape { url }), not a 400.
    it("PATCH /channels/webhook is accepted and publishes { url } to the store", () => {
      const updated = service.updateChannel("webhook", {
        enabled: true,
        config: { url: "https://example.com/hook" },
      });
      expect(updated.key).toBe("webhook");
      expect(updated.enabled).toBe(true);
      expect(updated.config.url).toBe("https://example.com/hook");
      expect(store.get("webhook")).toEqual({
        url: "https://example.com/hook",
      });
    });

    // V1 (round-7): saved config is published to the ChannelConfigStore that
    // the send path reads — raw values, not the masked read-surface echo.
    it("publishes saved config to the store consumed by the send path", () => {
      service.updateChannel("slack", {
        config: { webhookUrl: "https://saved.example.com/hook" },
      });
      expect(store.get("slack")).toEqual({
        webhookUrl: "https://saved.example.com/hook",
      });
    });

    it("store keeps the raw secret, never the '***' masked echo", () => {
      service.updateChannel("email", {
        config: { host: "smtp.example.com", password: "real-secret" },
      });
      // read surface is masked
      expect(service.getChannel("email")!.config.password).toBe("***");
      // send path sees the raw value
      expect(store.get("email")).toEqual({
        host: "smtp.example.com",
        password: "real-secret",
      });
      // a '***' round-trip does not poison the store either
      service.updateChannel("email", { config: { password: "***" } });
      expect(store.get("email")!.password).toBe("real-secret");
    });
  });

  // R8 (N29): testChannel must test the REQUESTED channel only, honor the
  // optional unsaved config override, and report the real per-channel result
  // instead of an unconditional success:true.
  describe("testChannel (N29)", () => {
    it("should throw BadRequestException for unknown channel key", async () => {
      await expect(service.testChannel("telegram", {})).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.testChannel("telegram", {})).rejects.toThrow(
        /Unknown notification channel: telegram/,
      );
    });

    it("returns success only when the channel reports 'sent', with results", async () => {
      (notificationService.sendToChannels as jest.Mock).mockResolvedValue({
        slack: "sent",
      });
      const result = await service.testChannel("slack", {});
      expect(result.success).toBe(true);
      expect(result.results).toEqual({ slack: "sent" });
      // only the requested channel is exercised (no full sendAll fan-out)
      expect(notificationService.sendToChannels).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AutoFlow Test Notification" }),
        ["slack"],
      );
      expect(notificationService.sendAll).not.toHaveBeenCalled();
    });

    it("SSRF-blocked channel is reported as failure, not fake OK", async () => {
      (notificationService.sendToChannels as jest.Mock).mockResolvedValue({
        slack: "blocked",
      });
      const result = await service.testChannel("slack", {});
      expect(result.success).toBe(false);
      expect(result.message).toContain("blocked");
      expect(result.results).toEqual({ slack: "blocked" });
    });

    it("failed channel is reported as failure", async () => {
      (notificationService.sendToChannels as jest.Mock).mockResolvedValue({
        wecom: "failed",
      });
      const result = await service.testChannel("wecom", {});
      expect(result.success).toBe(false);
      expect(result.message).toContain("failed");
      expect(result.results).toEqual({ wecom: "failed" });
    });

    it("unconfigured channel (skipped) is reported as failure", async () => {
      (notificationService.sendToChannels as jest.Mock).mockResolvedValue({
        email: "skipped",
      });
      const result = await service.testChannel("email", {});
      expect(result.success).toBe(false);
      expect(result.message).toContain("not configured");
    });

    it("sendToChannels throwing still degrades to success:false", async () => {
      (notificationService.sendToChannels as jest.Mock).mockRejectedValue(
        new Error("SMTP connection failed"),
      );
      const result = await service.testChannel("email", {});
      expect(result.success).toBe(false);
      expect(result.message).toContain("SMTP connection failed");
    });

    it("optional config override is visible to the send path and restored afterwards", async () => {
      const sendToChannels = notificationService.sendToChannels as jest.Mock;
      let storeDuringSend: Record<string, string> | undefined;
      sendToChannels.mockImplementation(
        async (_p: unknown, channels: string[]) => {
          if (channels[0] === "slack") storeDuringSend = store.get("slack");
          return { slack: "sent" };
        },
      );
      const result = await service.testChannel("slack", {
        webhookUrl: "https://unsaved.example.com/hook",
      });
      expect(result.success).toBe(true);
      expect(storeDuringSend).toEqual({
        webhookUrl: "https://unsaved.example.com/hook",
      });
      // restored: the override did not persist (store holds the pre-test
      // snapshot — the empty default seeded by loadFromEnv)
      expect(store.get("slack")).toEqual({});
    });

    it("override restores the previously saved config, and '***' keeps the stored secret", async () => {
      service.updateChannel("email", {
        config: { host: "smtp.saved.com", password: "real-secret" },
      });
      const sendToChannels = notificationService.sendToChannels as jest.Mock;
      let storeDuringSend: Record<string, string> | undefined;
      sendToChannels.mockImplementation(
        async (_p: unknown, channels: string[]) => {
          if (channels[0] === "email") storeDuringSend = store.get("email");
          return { email: "sent" };
        },
      );
      await service.testChannel("email", {
        host: "smtp.unsaved.com",
        password: "***",
      });
      // masked echo must not clobber the real secret during the test send
      expect(storeDuringSend).toEqual({
        host: "smtp.unsaved.com",
        password: "real-secret",
      });
      // saved config fully restored afterwards
      expect(store.get("email")).toEqual({
        host: "smtp.saved.com",
        password: "real-secret",
      });
    });
  });

  describe("sendTest", () => {
    // R8 (N29): all requested channels disabled → zero delivery attempts.
    // An empty fan-out must NOT report success ("fake OK" class bug).
    it("should fail with an explicit message when all requested channels are disabled", async () => {
      // all channels disabled by default
      const result = await service.sendTest({
        channels: ["email", "slack"],
        title: "Test",
        content: "hello",
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain("No enabled channels");
      expect(result.results).toEqual({});
      // notificationService methods not called since channels disabled
    });

    it("should fail when the requested channel list is empty", async () => {
      const result = await service.sendTest({
        channels: [],
        title: "Test",
        content: "hello",
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain("No enabled channels");
    });

    it("should call the correct channel method when enabled", async () => {
      service.updateChannel("slack", { enabled: true });
      const mockSlackSend = jest.fn().mockResolvedValue(undefined);
      (notificationService as any)["slack"] = { send: mockSlackSend };

      const result = await service.sendTest({
        channels: ["slack"],
        title: "Alert",
        content: "Task failed",
      });
      expect(result.success).toBe(true);
      expect(mockSlackSend).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Alert", content: "Task failed" }),
      );
    });

    it("should return failure when channel send throws", async () => {
      service.updateChannel("wecom", { enabled: true });
      const mockWecomSend = jest
        .fn()
        .mockRejectedValue(new Error("webhook error"));
      (notificationService as any)["wecom"] = { send: mockWecomSend };

      const result = await service.sendTest({
        channels: ["wecom"],
        title: "Test",
        content: "content",
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain("webhook error");
    });

    // V2 (round-7): channels report 'blocked'/'failed' statuses instead of
    // throwing — sendTest must reflect that in success/message/results so the
    // admin "test" button can't show OK for a blocked delivery.
    it("reports blocked channels as failure with per-channel results", async () => {
      service.updateChannel("slack", { enabled: true });
      (notificationService as any)["slack"] = {
        send: jest.fn().mockResolvedValue("blocked"),
      };

      const result = await service.sendTest({
        channels: ["slack"],
        title: "Test",
        content: "content",
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain("slack=blocked");
      expect(result.results).toEqual({ slack: "blocked" });
    });

    it("reports successful sends with per-channel results", async () => {
      service.updateChannel("slack", { enabled: true });
      (notificationService as any)["slack"] = {
        send: jest.fn().mockResolvedValue("sent"),
      };

      const result = await service.sendTest({
        channels: ["slack"],
        title: "Test",
        content: "content",
      });
      expect(result.success).toBe(true);
      expect(result.results).toEqual({ slack: "sent" });
    });
  });

  // N11: the read surface must never leak SMTP credentials — password-type
  // config fields are masked to '***', and the sentinel must not overwrite
  // the stored secret when admin-web echoes it back through PATCH.
  describe("secret masking (N11)", () => {
    const buildService = async () => {
      const env: Record<string, unknown> = {
        "notification.email.enabled": true,
        "notification.email.host": "smtp.example.com",
        "notification.email.user": "bot@example.com",
        "notification.email.password": "s3cret-smtp",
        "notification.slack.enabled": true,
        "notification.slack.webhookUrl":
          "https://hooks.slack.com/services/T/B/X",
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          NotificationConfigService,
          {
            provide: ConfigService,
            useValue: { get: jest.fn((key: string) => env[key]) },
          },
          { provide: NotificationService, useValue: { sendAll: jest.fn() } },
          { provide: ChannelConfigStore, useValue: new ChannelConfigStore() },
        ],
      }).compile();
      return module.get(NotificationConfigService);
    };

    it("getAllChannels masks email password but keeps non-secret fields", async () => {
      const svc = await buildService();
      const email = svc.getAllChannels().find((c) => c.key === "email")!;
      expect(email.config.password).toBe("***");
      expect(email.config.host).toBe("smtp.example.com");
      // slack webhookUrl is not a password-class field — left intact
      const slack = svc.getAllChannels().find((c) => c.key === "slack")!;
      expect(slack.config.webhookUrl).toBe(
        "https://hooks.slack.com/services/T/B/X",
      );
    });

    it("getChannel and updateChannel responses are masked too", async () => {
      const svc = await buildService();
      expect(svc.getChannel("email")!.config.password).toBe("***");
      const updated = svc.updateChannel("email", {
        config: { password: "new-secret", host: "smtp2.example.com" },
      });
      expect(updated.config.password).toBe("***");
      expect(updated.config.host).toBe("smtp2.example.com");
    });

    it('a "***" round-trip from the client does not overwrite the stored secret', async () => {
      const svc = await buildService();
      svc.updateChannel("email", {
        config: { password: "***", host: "smtp.example.com" },
      });
      const stored = (svc as any).channelConfigs.get("email").config;
      expect(stored.password).toBe("s3cret-smtp");
    });

    it("a real new password is persisted", async () => {
      const svc = await buildService();
      svc.updateChannel("email", { config: { password: "rotated" } });
      const stored = (svc as any).channelConfigs.get("email").config;
      expect(stored.password).toBe("rotated");
    });
  });

  // N32 (round-9): webhook 渠道的 URL 常把凭据放在 query（?access_token=…）。
  // N11 的 SECRET_FIELD_RE 因此也套用到 URL query 参数名上——读面（GET/
  // PATCH 响应）掩码，store 与发送路径保持原值，掩码回显不得覆盖真实值。
  describe("URL query secret masking (N32)", () => {
    const TOKEN_URL =
      "https://hooks.example.com/notify?access_token=s3cr3t-value&format=json";

    it("masks secret-class query params in url values on the read surface", () => {
      service.updateChannel("webhook", {
        config: { url: TOKEN_URL },
      });
      const read = service.getChannel("webhook")!.config.url;
      expect(read).toBe(
        "https://hooks.example.com/notify?access_token=***&format=json",
      );
      expect(read).not.toContain("s3cr3t-value");
      // PATCH 响应同样脱敏
      expect(service.updateChannel("webhook", { config: {} }).config.url).toBe(
        read,
      );
    });

    it("keeps the raw url in the store consumed by the send path", () => {
      service.updateChannel("webhook", { config: { url: TOKEN_URL } });
      expect(store.get("webhook")).toEqual({ url: TOKEN_URL });
    });

    it('a masked "?…=***" round-trip does not overwrite the stored url', () => {
      service.updateChannel("webhook", { config: { url: TOKEN_URL } });
      service.updateChannel("webhook", {
        config: {
          url: "https://hooks.example.com/notify?access_token=***&format=json",
        },
      });
      expect(store.get("webhook")).toEqual({ url: TOKEN_URL });
    });

    it("a genuinely new url (no masked echo) replaces the stored one", () => {
      service.updateChannel("webhook", { config: { url: TOKEN_URL } });
      service.updateChannel("webhook", {
        config: { url: "https://hooks.example.com/other?token=new-value" },
      });
      expect(store.get("webhook")).toEqual({
        url: "https://hooks.example.com/other?token=new-value",
      });
      expect(service.getChannel("webhook")!.config.url).toBe(
        "https://hooks.example.com/other?token=***",
      );
    });

    it("non-secret query params (e.g. ?key=…) are left intact", () => {
      service.updateChannel("webhook", {
        config: { url: "https://example.com/hook?key=plain&x=1" },
      });
      expect(service.getChannel("webhook")!.config.url).toBe(
        "https://example.com/hook?key=plain&x=1",
      );
    });

    it("covers dingtalk webhookUrl values carrying access_token too", () => {
      service.updateChannel("dingtalk", {
        config: {
          webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc",
        },
      });
      expect(service.getChannel("dingtalk")!.config.webhookUrl).toBe(
        "https://oapi.dingtalk.com/robot/send?access_token=***",
      );
      // 字段名规则不变：password 类仍整体掩码
      expect(store.get("dingtalk")).toEqual({
        webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=abc",
      });
    });
  });
});
