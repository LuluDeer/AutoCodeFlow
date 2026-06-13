import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { NotificationService } from "../notification.service";
import { WecomChannel } from "../channels/wecom.channel";
import { DingtalkChannel } from "../channels/dingtalk.channel";
import { EmailChannel } from "../channels/email.channel";
import { SlackChannel } from "../channels/slack.channel";

const mockChannel = () => ({ send: jest.fn() });

describe("NotificationService", () => {
  let service: NotificationService;
  let email: { send: jest.Mock };
  let slack: { send: jest.Mock };
  let wecom: { send: jest.Mock };
  let dingtalk: { send: jest.Mock };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: WecomChannel, useFactory: mockChannel },
        { provide: DingtalkChannel, useFactory: mockChannel },
        { provide: EmailChannel, useFactory: mockChannel },
        { provide: SlackChannel, useFactory: mockChannel },
      ],
    }).compile();

    service = module.get(NotificationService);
    email = module.get(EmailChannel);
    slack = module.get(SlackChannel);
    wecom = module.get(WecomChannel);
    dingtalk = module.get(DingtalkChannel);
  });

  describe("notifyFailureWithConfig", () => {
    it("should only call configured channels", async () => {
      email.send.mockResolvedValue(undefined);
      slack.send.mockResolvedValue(undefined);

      await service.notifyFailureWithConfig(
        "task",
        "exec-1",
        "err",
        "",
        undefined,
        ["email", "slack"],
      );
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(slack.send).toHaveBeenCalledTimes(1);
      expect(wecom.send).not.toHaveBeenCalled();
      expect(dingtalk.send).not.toHaveBeenCalled();
    });

    // sendToChannels uses Promise.allSettled — channel failures are logged as warnings
    // and do NOT propagate as exceptions, so the main execution flow is never interrupted.
    it("should not throw when a channel fails — logs a warning instead", async () => {
      email.send.mockRejectedValue(new Error("smtp error"));
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      await expect(
        service.notifyFailureWithConfig(
          "task",
          "exec-1",
          "err",
          "",
          undefined,
          ["email"],
        ),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("email"));
      warnSpy.mockRestore();
    });

    it("should fall back to sendAll (log-only) when no channels configured", async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});

      await expect(
        service.notifyFailureWithConfig(
          "task",
          "exec-1",
          "err",
          "",
          undefined,
          [],
        ),
      ).resolves.toBeUndefined();

      // sendAll fans out to all 4 channels — wecom.send is called
      expect(wecom.send).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[sendAll]"));
      logSpy.mockRestore();
    });
  });
});
