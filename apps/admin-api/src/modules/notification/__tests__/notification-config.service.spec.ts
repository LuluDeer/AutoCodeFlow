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
    it("should return all 4 default channels", () => {
      const channels = service.getAllChannels();
      expect(channels).toHaveLength(4);
      const keys = channels.map((c) => c.key);
      expect(keys).toContain("email");
      expect(keys).toContain("slack");
      expect(keys).toContain("dingtalk");
      expect(keys).toContain("wecom");
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
      // 消息列出合法 key；webhook 是逐请求渠道，不在可配置枚举内
      try {
        service.updateChannel("telegram", { enabled: true });
      } catch (e: unknown) {
        const msg = (e as Error).message;
        for (const key of ["email", "slack", "dingtalk", "wecom"]) {
          expect(msg).toContain(key);
        }
        expect(msg).not.toContain("webhook");
      }
    });

    it("PATCH /channels/webhook (the V4 repro) is a 400, not a 500", () => {
      expect(() =>
        service.updateChannel("webhook", {
          config: { webhookUrl: "https://example.com/hook" },
        }),
      ).toThrow(BadRequestException);
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

  describe("testChannel", () => {
    it("should return success when sendAll resolves", async () => {
      (notificationService.sendAll as jest.Mock).mockResolvedValue(undefined);
      const result = await service.testChannel({});
      expect(result.success).toBe(true);
      expect(result.message).toBe("Test message sent successfully");
    });

    it("should return failure when sendAll rejects", async () => {
      (notificationService.sendAll as jest.Mock).mockRejectedValue(
        new Error("SMTP connection failed"),
      );
      const result = await service.testChannel({});
      expect(result.success).toBe(false);
      expect(result.message).toContain("SMTP connection failed");
    });
  });

  describe("sendTest", () => {
    it("should skip disabled channels and succeed", async () => {
      // all channels disabled by default
      const result = await service.sendTest({
        channels: ["email", "slack"],
        title: "Test",
        content: "hello",
      });
      expect(result.success).toBe(true);
      // notificationService methods not called since channels disabled
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
});
