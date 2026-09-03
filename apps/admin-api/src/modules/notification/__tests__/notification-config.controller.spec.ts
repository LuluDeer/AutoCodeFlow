import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionContext, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { NotificationConfigController } from "../notification-config.controller";
import { NotificationConfigService } from "../notification-config.service";
import {
  NotificationService,
  AlertChannel,
  AlertLevel,
} from "../notification.service";
import { WecomChannel } from "../channels/wecom.channel";
import { DingtalkChannel } from "../channels/dingtalk.channel";
import { EmailChannel } from "../channels/email.channel";
import { SlackChannel } from "../channels/slack.channel";
import { WebhookChannel } from "../channels/webhook.channel";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

const mockConfigService = () => ({
  getAllChannels: jest.fn(),
  updateChannel: jest.fn(),
  testChannel: jest.fn(),
  sendTest: jest.fn(),
});

const mockNotificationService = () => ({
  sendAll: jest.fn().mockResolvedValue({}),
  sendToChannels: jest.fn().mockResolvedValue({}),
});

describe("NotificationConfigController", () => {
  let controller: NotificationConfigController;
  let svc: ReturnType<typeof mockConfigService>;
  let notif: ReturnType<typeof mockNotificationService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationConfigController],
      providers: [
        { provide: NotificationConfigService, useFactory: mockConfigService },
        { provide: NotificationService, useFactory: mockNotificationService },
      ],
    }).compile();

    controller = module.get(NotificationConfigController);
    svc = module.get(NotificationConfigService);
    notif = module.get(NotificationService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("getChannels", () => {
    it("returns all channels from service", () => {
      const channels = [{ key: "slack", enabled: true }];
      svc.getAllChannels.mockReturnValue(channels);
      expect(controller.getChannels()).toEqual(channels);
      expect(svc.getAllChannels).toHaveBeenCalled();
    });
  });

  describe("updateChannel", () => {
    it("delegates update to service with key and body", () => {
      const updated = {
        key: "slack",
        enabled: true,
        config: { webhookUrl: "https://x" },
      };
      svc.updateChannel.mockReturnValue(updated);
      const body = { enabled: true, config: { webhookUrl: "https://x" } };

      const result = controller.updateChannel("slack", body);

      expect(svc.updateChannel).toHaveBeenCalledWith("slack", body);
      expect(result).toEqual(updated);
    });

    it("throws when service throws for unknown channel", () => {
      svc.updateChannel.mockImplementation(() => {
        throw new Error("Unknown notification channel: bad");
      });
      expect(() => controller.updateChannel("bad", {})).toThrow(
        "Unknown notification channel: bad",
      );
    });
  });

  describe("testChannel", () => {
    it("delegates to configService.testChannel", async () => {
      const response = {
        success: true,
        message: "Test message sent successfully",
      };
      svc.testChannel.mockResolvedValue(response);
      const body = { webhookUrl: "https://hooks.example.com" };

      const result = await controller.testChannel(body);

      expect(svc.testChannel).toHaveBeenCalledWith(body);
      expect(result).toEqual(response);
    });

    it("returns failure response when service returns failure", async () => {
      svc.testChannel.mockResolvedValue({
        success: false,
        message: "SMTP error",
      });
      const result = await controller.testChannel({});
      expect(result.success).toBe(false);
    });
  });

  describe("sendTest", () => {
    it("delegates to configService.sendTest", async () => {
      const response = { success: true, message: "Test notification sent" };
      svc.sendTest.mockResolvedValue(response);
      const body = { channels: ["slack"], title: "Test", content: "Hello" };

      const result = await controller.sendTest(body);

      expect(svc.sendTest).toHaveBeenCalledWith(body);
      expect(result).toEqual(response);
    });

    it("passes multiple channels through", async () => {
      svc.sendTest.mockResolvedValue({ success: true, message: "done" });
      await controller.sendTest({
        channels: ["slack", "email", "wecom"],
        title: "T",
        content: "C",
      });
      expect(svc.sendTest).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ["slack", "email", "wecom"] }),
      );
    });
  });

  // N22: POST /api/notification/send — task-side reporting endpoint used by
  // the autocodeflow-notify SDK.
  describe("send (N22)", () => {
    it("builds payload from taskName/level and fans out via sendAll", async () => {
      notif.sendAll.mockResolvedValue({ email: "sent", webhook: "skipped" });
      const result = await controller.send({
        level: AlertLevel.WARNING,
        taskName: "daily-report",
        content: "disk almost full",
      });

      expect(notif.sendAll).toHaveBeenCalledWith({
        title: "[WARNING] daily-report",
        content: "disk almost full",
        level: "warning",
      });
      expect(notif.sendToChannels).not.toHaveBeenCalled();
      // V2 (round-7): per-channel delivery results surface in the body
      expect(result).toEqual({
        success: true,
        results: { email: "sent", webhook: "skipped" },
      });
    });

    it("honors explicit title (SDK shape) and routes channels + webhookUrl to sendToChannels", async () => {
      await controller.send({
        title: "[ERROR] my-task",
        content: "boom",
        level: AlertLevel.ERROR,
        channels: [AlertChannel.SLACK],
        webhookUrl: "https://hooks.example.com/x",
      });

      // webhookUrl implies the webhook channel even when not listed
      expect(notif.sendToChannels).toHaveBeenCalledWith(
        { title: "[ERROR] my-task", content: "boom", level: "error" },
        [AlertChannel.SLACK, AlertChannel.WEBHOOK],
        "https://hooks.example.com/x",
      );
      expect(notif.sendAll).not.toHaveBeenCalled();
    });

    // V2 (round-7): SSRF-blocked fan-out keeps 2xx but reports 'blocked'.
    it("returns 2xx body with results.webhook === 'blocked' when SSRF guard blocks", async () => {
      notif.sendToChannels.mockResolvedValue({
        slack: "sent",
        webhook: "blocked",
      });
      const result = await controller.send({
        content: "boom",
        channels: [AlertChannel.SLACK],
        webhookUrl: "http://127.0.0.1:9999/hook",
      });
      expect(result).toEqual({
        success: true,
        results: { slack: "sent", webhook: "blocked" },
      });
    });

    it("defaults to info level when omitted", async () => {
      await controller.send({ taskName: "t", content: "c" });
      expect(notif.sendAll).toHaveBeenCalledWith(
        expect.objectContaining({ level: "info", title: "[INFO] t" }),
      );
    });

    it("content is sanitized in logs (NOTIF-002 digest applies end-to-end)", async () => {
      // Real NotificationService with stub channels, so the controller's
      // payload actually flows through sendAll's redacting log path.
      const stubChannel = () => ({
        send: jest.fn().mockResolvedValue(undefined),
      });
      const mod: TestingModule = await Test.createTestingModule({
        controllers: [NotificationConfigController],
        providers: [
          { provide: NotificationConfigService, useFactory: mockConfigService },
          NotificationService,
          { provide: WecomChannel, useFactory: stubChannel },
          { provide: DingtalkChannel, useFactory: stubChannel },
          { provide: EmailChannel, useFactory: stubChannel },
          { provide: SlackChannel, useFactory: stubChannel },
          { provide: WebhookChannel, useFactory: stubChannel },
        ],
      }).compile();
      const realController = mod.get(NotificationConfigController);

      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => undefined);
      let logged = "";
      try {
        await realController.send({
          level: AlertLevel.ERROR,
          taskName: "secret-task",
          content:
            "failed with API_KEY=sk-very-secret-value and token abcdef0123456789abcdef0123456789",
        });
        // capture before mockRestore() clears the call records
        logged = logSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("[sendAll]"))
          .join("\n");
      } finally {
        logSpy.mockRestore();
      }

      expect(logged).toContain("[sendAll]");
      expect(logged).toContain("API_KEY=[REDACTED]");
      expect(logged).not.toContain("sk-very-secret-value");
      expect(logged).not.toContain("abcdef0123456789abcdef0123456789");
    });
  });

  // N11: channel configs carry SMTP credentials — the global RolesGuard must
  // reject plain users (403) on the channels read/write surface.
  describe("RBAC — channels endpoints are ADMIN-only (N11)", () => {
    const guard = new RolesGuard(new Reflector());
    const ctxWith = (
      handler: (...args: unknown[]) => unknown,
      role: UserRole,
    ): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => NotificationConfigController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as unknown as ExecutionContext;

    it("getChannels/updateChannel declare @Roles(ADMIN) metadata", () => {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          NotificationConfigController.prototype.getChannels,
        ),
      ).toEqual([UserRole.ADMIN]);
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          NotificationConfigController.prototype.updateChannel,
        ),
      ).toEqual([UserRole.ADMIN]);
    });

    it("plain user is denied (RolesGuard → 403)", () => {
      expect(
        guard.canActivate(
          ctxWith(
            NotificationConfigController.prototype.getChannels,
            UserRole.USER,
          ),
        ),
      ).toBe(false);
      expect(
        guard.canActivate(
          ctxWith(
            NotificationConfigController.prototype.updateChannel,
            UserRole.USER,
          ),
        ),
      ).toBe(false);
    });

    it("admin passes (200 path)", () => {
      expect(
        guard.canActivate(
          ctxWith(
            NotificationConfigController.prototype.getChannels,
            UserRole.ADMIN,
          ),
        ),
      ).toBe(true);
      expect(
        guard.canActivate(
          ctxWith(
            NotificationConfigController.prototype.updateChannel,
            UserRole.ADMIN,
          ),
        ),
      ).toBe(true);
    });
  });
});
