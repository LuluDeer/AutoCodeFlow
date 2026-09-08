import { Test } from "@nestjs/testing";
import { BadRequestException, Logger } from "@nestjs/common";
import { NotificationService } from "../notification.service";
import { AlertLevel, AlertChannel, MAX_ALERT_SILENCES } from "../notification.service";
import { WecomChannel } from "../channels/wecom.channel";
import { DingtalkChannel } from "../channels/dingtalk.channel";
import { EmailChannel } from "../channels/email.channel";
import { SlackChannel } from "../channels/slack.channel";
import { WebhookChannel } from "../channels/webhook.channel";
// QA-02 第二阶段：silenceStore 写穿持久化分支的注入桩
import { NotificationSilenceService } from "../notification-silence.service";
// FEAT-10: 渠道级模板渲染的读取源注入桩
import { ChannelConfigStore } from "../channel-config.store";
// 可观测性补齐轮：投递结果计数模块级快照（埋点断言入口）
import {
  getRuntimeCountersSnapshot,
  resetRuntimeMetrics,
} from "../../metrics/runtime-metrics-entry";

const mockChannel = () => ({ send: jest.fn() });

/** 读取运行时计数（模块级单调快照；本文件用例内 afterEach 重置） */
const runtimeCount = (
  name: string,
  labels: Record<string, string> = {},
): number =>
  getRuntimeCountersSnapshot()
    .get(name as never)
    ?.get(JSON.stringify(labels)) ?? 0;

describe("NotificationService", () => {
  let service: NotificationService;
  let email: { send: jest.Mock };
  let slack: { send: jest.Mock };
  let wecom: { send: jest.Mock };
  let dingtalk: { send: jest.Mock };
  let webhook: { send: jest.Mock };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: WecomChannel, useFactory: mockChannel },
        { provide: DingtalkChannel, useFactory: mockChannel },
        { provide: EmailChannel, useFactory: mockChannel },
        { provide: SlackChannel, useFactory: mockChannel },
        { provide: WebhookChannel, useFactory: mockChannel },
      ],
    }).compile();

    service = module.get(NotificationService);
    email = module.get(EmailChannel);
    slack = module.get(SlackChannel);
    wecom = module.get(WecomChannel);
    dingtalk = module.get(DingtalkChannel);
    webhook = module.get(WebhookChannel);
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
    // V2 (round-7): the failure is still reported — via the returned per-channel results.
    it("should not throw when a channel fails — logs a warning and reports 'failed'", async () => {
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
      ).resolves.toEqual({ email: "failed" });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("email"));
      warnSpy.mockRestore();
    });

    it("should fall back to sendAll (log-only) when no channels configured", async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});

      // sendAll now resolves to the per-channel results map (V2), not undefined
      await expect(
        service.notifyFailureWithConfig(
          "task",
          "exec-1",
          "err",
          "",
          undefined,
          [],
        ),
      ).resolves.toBeDefined();

      // sendAll fans out to all channels — wecom.send is called
      expect(wecom.send).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[sendAll]"));
      logSpy.mockRestore();
    });

    // 改动2: notifyFailureWithConfig 补透传 taskId 给 isSilenced，使任务级静默
    // 窗口对本路径生效（此前恒传 undefined，与 notifyFailure 行为不一致）。
    it("passes taskId through to isSilenced when provided", async () => {
      email.send.mockResolvedValue(undefined);
      const spy = jest.spyOn(service, "isSilenced").mockReturnValue(false);

      await service.notifyFailureWithConfig(
        "task",
        "exec-1",
        "err",
        "",
        undefined,
        ["email"],
        undefined,
        "task-1",
      );

      expect(spy).toHaveBeenCalledWith("task-1", AlertLevel.ERROR);
      spy.mockRestore();
    });

    it("is silenced by a TASK-LEVEL silence when taskId is provided", async () => {
      service.addSilence({
        taskId: "task-1",
        level: AlertLevel.ERROR,
        durationMinutes: 10,
      });
      const fanout = jest.spyOn(service, "sendToChannels");

      await service.notifyFailureWithConfig(
        "task",
        "exec-1",
        "err",
        "",
        undefined,
        ["email"],
        undefined,
        "task-1",
      );

      // 修复前 isSilenced(undefined,...) 不命中该任务级规则、会照常发送；
      // 现在 taskId 命中静默 → 不发送。
      expect(fanout).not.toHaveBeenCalled();
      fanout.mockRestore();
    });

    it("does NOT pass a taskId to isSilenced when omitted (legacy behavior)", async () => {
      email.send.mockResolvedValue(undefined);
      const spy = jest.spyOn(service, "isSilenced").mockReturnValue(false);

      await service.notifyFailureWithConfig(
        "task",
        "exec-1",
        "err",
        "",
        undefined,
        ["email"],
      );

      expect(spy).toHaveBeenCalledWith(undefined, AlertLevel.ERROR);
      spy.mockRestore();
    });
  });

  describe("sendWebhook", () => {
    it("should delegate to WebhookChannel.send with the given url", async () => {
      webhook.send.mockResolvedValue(undefined);
      const payload = {
        title: "Test",
        content: "body",
        level: "info" as const,
      };
      await service.sendWebhook(payload, "https://example.com/hook");
      expect(webhook.send).toHaveBeenCalledWith(
        payload,
        "https://example.com/hook",
      );
    });

    // V2 (round-7): the one-off direct-call path must make an SSRF block
    // visible to its caller (400), unlike the fail-open fan-out paths.
    it("should throw BadRequestException when the URL is SSRF-blocked", async () => {
      webhook.send.mockResolvedValue("blocked");
      const payload = {
        title: "Test",
        content: "body",
        level: "info" as const,
      };
      await expect(
        service.sendWebhook(payload, "http://127.0.0.1:9999/hook"),
      ).rejects.toThrow(BadRequestException);
    });

    it("should pass through a successful status without throwing", async () => {
      webhook.send.mockResolvedValue("sent");
      await expect(
        service.sendWebhook(
          { title: "t", content: "c", level: "info" },
          "https://example.com/hook",
        ),
      ).resolves.toBe("sent");
    });
  });

  describe("sendToChannels — webhook channel", () => {
    it("should call webhook.send when WEBHOOK channel is included", async () => {
      webhook.send.mockResolvedValue(undefined);
      const payload = {
        title: "Alert",
        content: "msg",
        level: "error" as const,
      };
      await service.sendToChannels(
        payload,
        ["webhook" as any],
        "https://hook.example.com",
      );
      expect(webhook.send).toHaveBeenCalledWith(
        payload,
        "https://hook.example.com",
      );
      expect(email.send).not.toHaveBeenCalled();
    });
  });

  // V2 (round-7): fan-out keeps 2xx semantics but reports per-channel truth.
  describe("sendToChannels — per-channel delivery results (V2)", () => {
    const payload = { title: "t", content: "c", level: "info" as const };

    it("maps each channel's returned status into the results record", async () => {
      email.send.mockResolvedValue("sent");
      slack.send.mockResolvedValue("blocked");
      wecom.send.mockResolvedValue("skipped");

      const results = await service.sendToChannels(payload, [
        "email" as any,
        "slack" as any,
        "wecom" as any,
      ]);
      expect(results).toEqual({
        email: "sent",
        slack: "blocked",
        wecom: "skipped",
      });
    });

    it("SSRF-blocked webhook surfaces as results.webhook === 'blocked' and does not throw", async () => {
      webhook.send.mockResolvedValue("blocked");
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      await expect(
        service.sendToChannels(payload, ["webhook" as any], "http://10.0.0.1"),
      ).resolves.toEqual({ webhook: "blocked" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("blocked by SSRF guard"),
      );
      warnSpy.mockRestore();
    });

    it("sendAll returns the results map for all five channels", async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});
      email.send.mockResolvedValue("sent");
      slack.send.mockResolvedValue("skipped");
      dingtalk.send.mockResolvedValue("skipped");
      wecom.send.mockResolvedValue("skipped");
      webhook.send.mockResolvedValue("skipped");

      const results = await service.sendAll(payload);
      expect(results).toEqual({
        email: "sent",
        slack: "skipped",
        dingtalk: "skipped",
        wecom: "skipped",
        webhook: "skipped",
      });
      logSpy.mockRestore();
    });
  });

  // 可观测性补齐轮：fan-out 的 per-channel 投递结果计数
  // （autoflow_notification_delivery_total{channel,result}）。fail-open
  // 语义不变——埋点只记计数，不改变返回与控制流。
  describe("sendToChannels — delivery outcome counters", () => {
    // 模块级计数跨用例/文件共享，进入本组用例前显式重置保证隔离。
    beforeEach(() => {
      resetRuntimeMetrics();
    });
    afterEach(() => {
      resetRuntimeMetrics();
    });
    const payload = { title: "t", content: "c", level: "info" as const };
    const deliveryCount = (channel: string, result: "success" | "failure") =>
      runtimeCount("autoflow_notification_delivery_total", {
        channel,
        result,
      });

    it("counts per-channel success/failure and accumulates across fan-outs", async () => {
      const errSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      email.send.mockResolvedValue("sent");
      slack.send.mockRejectedValue(new Error("smtp down"));

      await service.sendToChannels(payload, ["email" as any, "slack" as any]);
      expect(deliveryCount("email", "success")).toBe(1);
      expect(deliveryCount("slack", "failure")).toBe(1);
      expect(deliveryCount("email", "failure")).toBe(0);

      // 跨次 fan-out 单调累计
      await service.sendToChannels(payload, ["email" as any]);
      expect(deliveryCount("email", "success")).toBe(2);
      errSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("counts blocked/skipped/legacy-void outcomes as success (not delivery failures)", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      slack.send.mockResolvedValue("blocked");
      wecom.send.mockResolvedValue(undefined); // legacy mock 渠道

      await service.sendToChannels(payload, ["slack" as any, "wecom" as any]);
      expect(deliveryCount("slack", "success")).toBe(1);
      expect(deliveryCount("slack", "failure")).toBe(0);
      expect(deliveryCount("wecom", "success")).toBe(1);
      warnSpy.mockRestore();
    });

    it("sendWebhook direct path is not fan-out counted", async () => {
      webhook.send.mockResolvedValue("sent");
      await expect(
        service.sendWebhook(payload, "https://hooks.example.com/x"),
      ).resolves.toBe("sent");
      expect(deliveryCount("webhook", "success")).toBe(0);
      expect(deliveryCount("webhook", "failure")).toBe(0);
    });
  });

  describe("sendAll — NOTIF-002 log redaction", () => {
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
      webhook.send.mockResolvedValue(undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it("should NOT log raw content — only length plus redacted 80-char digest", async () => {
      const secret = "API_SECRET_KEY=super-secret-value-123456";
      const token =
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-part";
      const hexToken =
        "deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdef";
      const padding =
        "additional operation context message to push the content well past the 80 char digest window";
      await service.sendAll({
        title: "Task failed: t",
        content: `Error: ${secret}\n${token}\nkey=${hexToken}\n${padding}`,
        level: "error",
      });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[sendAll]"));
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      // 原文敏感片段不得进入日志
      expect(logged).not.toContain("super-secret-value-123456");
      expect(logged).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
      expect(logged).not.toContain(hexToken);
      // 记录了内容长度
      expect(logged).toContain("chars]");
      // 摘要截断到 80 字符以内并带省略号
      expect(logged).toMatch(/.{0,80}\.\.\./);
    });

    it("should log channel fan-out types in the digest line", async () => {
      await service.sendAll({
        title: "t",
        content: "hello world",
        level: "info",
      });
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      // fan-out 目标渠道类型可见（sendAll 固定发这 5 个渠道）
      for (const channel of [
        "email",
        "slack",
        "dingtalk",
        "wecom",
        "webhook",
      ]) {
        expect(logged).toContain(channel);
      }
    });

    it("should redact env-style secrets inside the digest prefix", async () => {
      const password = "DB_PASSWORD=hunter2verysecret";
      await service.sendAll({
        title: "t",
        // secret 放在前 80 字符内，确保脱敏逻辑作用在摘要里
        content: `${password} and some padding text to reach length`,
        level: "warning",
      });
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("hunter2verysecret");
      expect(logged).toContain("DB_PASSWORD=[REDACTED]");
    });
  });

  describe("AlertSilence — NOTIF-003", () => {
    beforeEach(() => {
      // compile() 不会触发生命周期钩子，手动启动与生产一致的清理定时器
      service.onModuleInit();
    });

    afterEach(() => {
      service.onModuleDestroy();
    });

    it("should reject new silences when the map reaches its size limit", () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      for (let i = 0; i < MAX_ALERT_SILENCES; i++) {
        service.addSilence({ durationMinutes: 10 });
      }
      expect(service.getSilences()).toHaveLength(MAX_ALERT_SILENCES);

      expect(() => service.addSilence({ durationMinutes: 10 })).toThrow(
        BadRequestException,
      );
      // 超限后 Map 不再增长
      expect(service.getSilences()).toHaveLength(MAX_ALERT_SILENCES);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("reached limit"),
      );
      warnSpy.mockRestore();
    });

    it("should allow adding again after entries are removed (cap is not permanent)", () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      for (let i = 0; i < MAX_ALERT_SILENCES; i++) {
        service.addSilence({ durationMinutes: 10 });
      }
      expect(() => service.addSilence({ durationMinutes: 10 })).toThrow(
        BadRequestException,
      );
      service.getSilences().forEach((s) => service.removeSilence(s.id!));
      const id = service.addSilence({ durationMinutes: 10 });
      expect(id).toBeDefined();
      jest.restoreAllMocks();
    });

    it("cleanExpiredSilences should remove only expired entries", () => {
      service.addSilence({ durationMinutes: 10 }); // 活跃
      // endTime 直接落在过去（durationMinutes<=0 不会生成 endTime）
      const expiredId = service.addSilence({
        durationMinutes: 0,
        endTime: new Date(Date.now() - 1000),
      } as any);
      const removed = service.cleanExpiredSilences();
      expect(removed).toBe(1);
      expect(service.getSilences().map((s) => s.id)).not.toContain(expiredId);
      expect(service.getSilences()).toHaveLength(1);
    });

    it("onModuleDestroy should clear the cleanup interval", () => {
      const clearSpy = jest.spyOn(global, "clearInterval");
      const timer = (service as any).silenceCleanupTimer;
      expect(timer).toBeDefined();
      service.onModuleDestroy();
      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect((service as any).silenceCleanupTimer).toBeUndefined();
      clearSpy.mockRestore();
    });

    it("cleanup interval created in onModuleInit should be unref'ed so it never keeps the process alive", () => {
      const timer = (service as any).silenceCleanupTimer as NodeJS.Timeout;
      expect(typeof timer.unref).toBe("function");
      // unref 后 hasRef() 为 false：定时器不会阻止进程退出
      expect(timer.hasRef()).toBe(false);
    });
  });

  // ============================================================================
  // QA-02 第二阶段（branches 冲 75）：notification.service 剩余分支定向补测。
  // 范围：notify() 渠道分流、notify* 家族静默短路、testChannel default 分支、
  // sendToChannels 错误堆栈日志、FEAT-01 写穿持久化（silenceStore 注入）双路径。
  // 全部断言具体行为，无凑数弱断言。
  // ============================================================================

  describe("notify() — channel routing and silencing (QA-02 phase 2)", () => {
    it("fans out to only the requested channels when channels are provided", async () => {
      email.send.mockResolvedValue("sent");
      slack.send.mockResolvedValue("sent");
      await service.notify("job", "hello", AlertLevel.INFO, "task-1", [
        "email" as any,
        "slack" as any,
      ]);
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(slack.send).toHaveBeenCalledTimes(1);
      expect(wecom.send).not.toHaveBeenCalled();
      expect(webhook.send).not.toHaveBeenCalled();
    });

    it("falls back to sendAll (all five channels) when channels are omitted", async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});
      await service.notify("job", "hello", AlertLevel.INFO);
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(wecom.send).toHaveBeenCalledTimes(1);
      expect(webhook.send).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
    });

    it("falls back to sendAll for an empty channels array (not a no-op)", async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, "log")
        .mockImplementation(() => {});
      await service.notify("job", "hello", AlertLevel.INFO, undefined, []);
      expect(email.send).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
    });

    it("short-circuits when the (taskId, level) pair is silenced", async () => {
      service.addSilence({
        taskId: "task-9",
        level: AlertLevel.WARNING,
        durationMinutes: 10,
      });
      const sendAll = jest.spyOn(service, "sendAll");
      await service.notify("job", "hello", AlertLevel.WARNING, "task-9");
      expect(sendAll).not.toHaveBeenCalled();
      sendAll.mockRestore();
    });
  });

  describe("notify* family — per-level silencing (QA-02 phase 2)", () => {
    it("notifySuccess skips the fan-out when INFO is silenced for the task", async () => {
      service.addSilence({ taskId: "t1", level: AlertLevel.INFO, durationMinutes: 10 });
      const sendAll = jest.spyOn(service, "sendAll");
      await service.notifySuccess("job", "exec-1", 1234, "t1");
      expect(sendAll).not.toHaveBeenCalled();
      sendAll.mockRestore();
    });

    it("notifySuccess fans out with the duration payload otherwise", async () => {
      const sendAll = jest
        .spyOn(service, "sendAll")
        .mockResolvedValue(undefined);
      await service.notifySuccess("job", "exec-1", 1234, "t1");
      expect(sendAll).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Task succeeded: job",
          content: expect.stringContaining("1234ms"),
          level: "info",
        }),
      );
      sendAll.mockRestore();
    });

    it("notifyTimeout skips the fan-out when WARNING is silenced", async () => {
      service.addSilence({ taskId: "t1", level: AlertLevel.WARNING, durationMinutes: 10 });
      const sendAll = jest.spyOn(service, "sendAll");
      await service.notifyTimeout("job", "exec-1", 300, "t1");
      expect(sendAll).not.toHaveBeenCalled();
      sendAll.mockRestore();
    });

    it("notifyTimeout fans out with the timeout payload otherwise", async () => {
      const sendAll = jest
        .spyOn(service, "sendAll")
        .mockResolvedValue(undefined);
      await service.notifyTimeout("job", "exec-1", 300);
      expect(sendAll).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Task timed out: job",
          content: expect.stringContaining("Timeout: 300s"),
          level: "warning",
        }),
      );
      sendAll.mockRestore();
    });

    it("notifyFailure skips the fan-out when ERROR is silenced", async () => {
      service.addSilence({ taskId: "t1", level: AlertLevel.ERROR, durationMinutes: 10 });
      const sendAll = jest.spyOn(service, "sendAll");
      await service.notifyFailure("job", "exec-1", "boom", undefined, "t1");
      expect(sendAll).not.toHaveBeenCalled();
      sendAll.mockRestore();
    });

    it("notifyFailure includes the runbook section only when a runbook is provided", async () => {
      const sendAll = jest
        .spyOn(service, "sendAll")
        .mockResolvedValue(undefined);
      await service.notifyFailure("job", "exec-1", "boom", "AI says", "t1", "redeploy.md");
      expect(sendAll).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Runbook:\nredeploy.md"),
        }),
      );
      sendAll.mockRestore();
    });

    it("notifyExecutorOffline/Online honor global (undefined-task) silences", async () => {
      service.addSilence({ level: AlertLevel.WARNING, durationMinutes: 10 });
      const sendAll = jest.spyOn(service, "sendAll");
      await service.notifyExecutorOffline("node-1", "10.0.0.9:3002");
      expect(sendAll).not.toHaveBeenCalled();

      // WARNING 静默不影响 INFO 渠道
      await service.notifyExecutorOnline("node-1", "10.0.0.9:3002");
      expect(sendAll).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Executor online: node-1" }),
      );
      sendAll.mockRestore();
    });

    it("notifyFailureWithConfig masks the recipient into the content only when alarmEmail exists", async () => {
      const sendToChannels = jest
        .spyOn(service, "sendToChannels")
        .mockResolvedValue({});
      await service.notifyFailureWithConfig(
        "job",
        "exec-1",
        "boom",
        "AI says",
        "ops@example.com",
        ["email"],
      );
      expect(sendToChannels).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Recipient: ops@example.com"),
        }),
        ["email"],
        undefined,
      );
      sendToChannels.mockRestore();
    });
  });

  describe("FEAT-10 — per-channel template rendering in sendToChannels", () => {
    it("renders title/content from the channel's saved templates when payload carries vars", async () => {
      const store = new ChannelConfigStore();
      store.set(
        "dingtalk",
        {
          webhookUrl: "https://oapi.example.com/x",
          titleTemplate: "[{{level}}] {{task}}",
          contentTemplate: "exec {{executionId}} failed: {{failedReason}}",
        },
        true,
      );
      const module2 = await Test.createTestingModule({
        providers: [
          NotificationService,
          { provide: WecomChannel, useFactory: mockChannel },
          { provide: DingtalkChannel, useFactory: mockChannel },
          { provide: EmailChannel, useFactory: mockChannel },
          { provide: SlackChannel, useFactory: mockChannel },
          { provide: WebhookChannel, useFactory: mockChannel },
          { provide: ChannelConfigStore, useValue: store },
        ],
      }).compile();
      const svc = module2.get(NotificationService);
      const ding = module2.get(DingtalkChannel) as { send: jest.Mock };
      const emailCh = module2.get(EmailChannel) as { send: jest.Mock };
      ding.send.mockResolvedValue("sent");
      emailCh.send.mockResolvedValue("skipped");

      await svc.sendToChannels(
        {
          title: "Task failed: nightly",
          content: "Execution ID: e1\nError: boom",
          level: "error",
          vars: {
            task: "nightly",
            executionId: "e1",
            failedReason: "boom",
            level: "error",
          },
        },
        [AlertChannel.DINGTALK, AlertChannel.EMAIL],
      );

      // dingtalk 收到模板渲染后的专属副本
      expect(ding.send).toHaveBeenCalledTimes(1);
      const rendered = ding.send.mock.calls[0][0];
      expect(rendered.title).toBe("[error] nightly");
      expect(rendered.content).toBe("exec e1 failed: boom");
      // 渲染副本不携带 vars（防下游二次渲染）
      expect(rendered.vars).toBeUndefined();
      // email 无模板 → 原样载荷
      expect(emailCh.send).toHaveBeenCalledTimes(1);
      expect(emailCh.send.mock.calls[0][0].title).toBe("Task failed: nightly");
    });

    it("channels without templates receive the payload verbatim (zero breakage, no store)", async () => {
      email.send.mockResolvedValue("sent");
      const payload = {
        title: "t",
        content: "c",
        level: "info" as const,
        vars: { task: "x" },
      };
      await service.sendToChannels(payload, [AlertChannel.EMAIL]);
      expect(email.send).toHaveBeenCalledWith(payload);
    });

    it("a broken template fails open — original payload used, warn logged, delivery continues", async () => {
      const store = new ChannelConfigStore();
      store.set("wecom", { webhookUrl: "https://qy.example.com/y" }, true);
      // 模拟渲染失败：直接往 store 塞一个无法命中渲染器的值不行（渲染器不抛），
      // 因此改为 monkey-patch renderTemplate 入口不可行——这里以 getter 抛错模拟。
      const bomb = {
        get titleTemplate(): string {
          throw new Error("boom");
        },
      } as unknown as Record<string, string>;
      (store as any).configs = new Map([["wecom", bomb]]);

      const module2 = await Test.createTestingModule({
        providers: [
          NotificationService,
          { provide: WecomChannel, useFactory: mockChannel },
          { provide: DingtalkChannel, useFactory: mockChannel },
          { provide: EmailChannel, useFactory: mockChannel },
          { provide: SlackChannel, useFactory: mockChannel },
          { provide: WebhookChannel, useFactory: mockChannel },
          { provide: ChannelConfigStore, useValue: store },
        ],
      }).compile();
      const svc = module2.get(NotificationService);
      const wecomCh = module2.get(WecomChannel) as { send: jest.Mock };
      wecomCh.send.mockResolvedValue("sent");
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      const payload = {
        title: "orig",
        content: "orig-content",
        level: "error" as const,
        vars: { task: "t" },
      };
      await svc.sendToChannels(payload, [AlertChannel.WECOM]);

      expect(wecomCh.send).toHaveBeenCalledWith(payload);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to the default content"),
      );
      warnSpy.mockRestore();
    });

    it("notifyFailure populates the documented variable set (task/executionId/failedReason/runbook...)", async () => {
      const sendAll = jest
        .spyOn(service, "sendAll")
        .mockResolvedValue(undefined);
      await service.notifyFailure(
        "nightly-etl",
        "exec-9",
        "TIMEOUT: 60s",
        "AI says retry",
        "task-1",
        "docs/rb.md",
      );
      const arg = sendAll.mock.calls[0][0];
      expect(arg.vars).toMatchObject({
        task: "nightly-etl",
        taskName: "nightly-etl",
        taskId: "task-1",
        executionId: "exec-9",
        failedReason: "TIMEOUT: 60s",
        aiAnalysis: "AI says retry",
        runbook: "docs/rb.md",
        level: "error",
      });
      // 固定拼串行为不变（零破坏）
      expect(arg.title).toBe("Task failed: nightly-etl");
      expect(arg.content).toContain("Runbook:\ndocs/rb.md");
      sendAll.mockRestore();
    });
  });

  describe("testChannel — switch dispatch (QA-02 phase 2)", () => {
    const payload = { title: "t", content: "c", level: "info" as const };

    it("dispatches to each concrete channel exactly once with the override", async () => {
      email.send.mockResolvedValue("sent");
      slack.send.mockResolvedValue("sent");
      dingtalk.send.mockResolvedValue("sent");
      wecom.send.mockResolvedValue("sent");
      webhook.send.mockResolvedValue("sent");

      await expect(
        service.testChannel(payload, "email" as any, { user: "u" }),
      ).resolves.toBe("sent");
      expect(email.send).toHaveBeenCalledWith(payload, { user: "u" });

      await expect(
        service.testChannel(payload, "slack" as any),
      ).resolves.toBe("sent");
      expect(slack.send).toHaveBeenCalledWith(payload, undefined);

      await expect(
        service.testChannel(payload, "dingtalk" as any),
      ).resolves.toBe("sent");
      await expect(
        service.testChannel(payload, "wecom" as any),
      ).resolves.toBe("sent");
      await expect(
        service.testChannel(payload, "webhook" as any),
      ).resolves.toBe("sent");
      expect(webhook.send).toHaveBeenCalledWith(payload, undefined, undefined);
    });

    it("returns 'skipped' for an unknown channel key (default branch)", async () => {
      await expect(
        service.testChannel(payload, "carrier-pigeon" as any),
      ).resolves.toBe("skipped");
      // 未触达任何渠道
      expect(email.send).not.toHaveBeenCalled();
      expect(webhook.send).not.toHaveBeenCalled();
    });
  });

  describe("sendToChannels — error logging branches (QA-02 phase 2)", () => {
    it("logs the rejected reason's message for Error and string failures alike", async () => {
      const errSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      email.send.mockRejectedValue(new Error("smtp exploded"));
      slack.send.mockRejectedValue("plain-string-reason");
      webhook.send.mockRejectedValue(new Error("hook down"));

      const results = await service.sendToChannels(
        { title: "t", content: "c", level: "error" as const },
        ["email" as any, "slack" as any, "webhook" as any],
      );

      expect(results).toEqual({
        email: "failed",
        slack: "failed",
        webhook: "failed",
      });
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("smtp exploded");
      expect(logged).toContain("plain-string-reason");
      errSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe("silenceStore write-through (FEAT-01 @Optional, QA-02 phase 2)", () => {
    const makeServiceWithStore = async (store: unknown) => {
      const module = await Test.createTestingModule({
        providers: [
          NotificationService,
          { provide: WecomChannel, useFactory: mockChannel },
          { provide: DingtalkChannel, useFactory: mockChannel },
          { provide: EmailChannel, useFactory: mockChannel },
          { provide: SlackChannel, useFactory: mockChannel },
          { provide: WebhookChannel, useFactory: mockChannel },
          { provide: NotificationSilenceService, useValue: store },
        ],
      }).compile();
      return module.get(NotificationService);
    };

    it("persists a new silence through the store and adopts the DB row id", async () => {
      let resolveCreate: (row: unknown) => void = () => {};
      const create = jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const svc = await makeServiceWithStore({ create, remove: jest.fn(), cleanExpired: jest.fn() });

      const localId = svc.addSilence({ taskId: "t1", level: AlertLevel.ERROR, durationMinutes: 5 });
      expect(localId).toBeDefined();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "task",
          taskId: "t1",
          level: AlertLevel.ERROR,
          durationMinutes: 5,
        }),
      );

      // DB 行落库（生成正式 id）→ 内存条目 id 被替换，无失败告警
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      resolveCreate({ id: "db-row-1" });
      await new Promise((r) => setImmediate(r));
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("persist failed"),
      );
      warnSpy.mockRestore();
      expect(svc.getSilences().map((s) => s.id)).toContain("db-row-1");
    });

    it("keeps memory semantics when the store create fails (warn, not throw)", async () => {
      const create = jest.fn().mockRejectedValue(new Error("pg down"));
      const svc = await makeServiceWithStore({ create, remove: jest.fn(), cleanExpired: jest.fn() });
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      const id = svc.addSilence({ taskId: "t1", durationMinutes: 5 });
      expect(id).toBeDefined();
      await new Promise((r) => setImmediate(r));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("persist failed"),
      );
      expect(svc.getSilences()).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it("removeSilence deletes from both memory and store; a store failure does not block", async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      const create = jest.fn().mockResolvedValue({ id: "db-1" });
      const svc = await makeServiceWithStore({ create, remove, cleanExpired: jest.fn() });
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      const id = svc.addSilence({ taskId: "t1", durationMinutes: 5 });
      await new Promise((r) => setImmediate(r));
      expect(svc.removeSilence(id)).toBe(true);
      expect(remove).toHaveBeenCalledWith(id);
      expect(svc.getSilences()).toHaveLength(0);

      // store 删除失败 → 仅 warn，内存态不受影响（catch 异步落地，等一拍）
      remove.mockRejectedValue(new Error("pg down"));
      const id2 = svc.addSilence({ taskId: "t2", durationMinutes: 5 });
      await new Promise((r) => setImmediate(r));
      expect(svc.removeSilence(id2)).toBe(true);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DB remove failed"),
      );
      warnSpy.mockRestore();
    });

    it("cleanExpiredSilences also sweeps the store (fire-and-forget)", async () => {
      const cleanExpired = jest.fn().mockResolvedValue(undefined);
      const create = jest.fn().mockResolvedValue({ id: "db-1" });
      const svc = await makeServiceWithStore({ create, remove: jest.fn(), cleanExpired });
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      svc.addSilence({ taskId: "t1", durationMinutes: 0, endTime: new Date(Date.now() - 1000) } as any);
      const removed = svc.cleanExpiredSilences();
      expect(removed).toBe(1);
      expect(cleanExpired).toHaveBeenCalledWith(expect.any(Date));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(warnSpy).not.toHaveBeenCalled();

      // store 清扫失败 → 仅 warn
      cleanExpired.mockRejectedValue(new Error("pg down"));
      svc.addSilence({ taskId: "t2", durationMinutes: 0, endTime: new Date(Date.now() - 1000) } as any);
      svc.cleanExpiredSilences();
      await new Promise((r) => setImmediate(r));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DB cleanup failed"),
      );
      warnSpy.mockRestore();
    });

    it("restoreSilencesFromStore rehydrates active rows after a restart", async () => {
      const listActive = jest.fn().mockResolvedValue([
        {
          id: "db-row-1",
          scope: "task",
          channelType: null,
          applicationId: null,
          taskId: "t1",
          level: "error",
          reason: "maintenance",
          startTime: null,
          endTime: new Date(Date.now() + 60_000),
          durationMinutes: 10,
          createdAt: new Date(),
        },
      ]);
      const svc = await makeServiceWithStore({
        create: jest.fn(),
        remove: jest.fn(),
        cleanExpired: jest.fn(),
        listActive,
      });

      await (svc as any).restoreSilencesFromStore();
      expect(svc.getSilences()).toHaveLength(1);
      const restored = svc.getSilences()[0];
      expect(restored.id).toBe("db-row-1");
      expect(restored.taskId).toBe("t1");
      expect(restored.level).toBe(AlertLevel.ERROR);
    });

    it("restoreSilencesFromStore warns and keeps an empty map on store failure", async () => {
      const listActive = jest.fn().mockRejectedValue(new Error("pg down"));
      const svc = await makeServiceWithStore({ listActive, remove: jest.fn(), cleanExpired: jest.fn(), create: jest.fn() });
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      await (svc as any).restoreSilencesFromStore();
      expect(svc.getSilences()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DB restore failed"),
      );
      warnSpy.mockRestore();
    });

    it("addSilence persists an application-scoped silence with the application scope", async () => {
      const create = jest.fn().mockResolvedValue({ id: "db-app-1" });
      const svc = await makeServiceWithStore({ create, remove: jest.fn(), cleanExpired: jest.fn() });

      svc.addSilence({
        scope: "application",
        applicationId: "app-1",
        durationMinutes: 30,
      } as any);
      await new Promise((r) => setImmediate(r));
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "application", applicationId: "app-1" }),
      );
    });
  });
});
