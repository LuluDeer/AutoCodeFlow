/**
 * ARCH-21: ExecutionEventsListener 等价 spec。
 *
 * 断言从迁移前的 task.service.spec「failure-terminal notification (改动1)」
 * 等价挪移：notifyCallbackFailure 的对外行为（notifyFailureWithConfig 参数
 * 形状 / 摘要构造 / fail-open + NOTIFICATION_FAILED 审计兜底）逐条复刻，
 * 输入从 (execution, failureReason, cb) 换为事件 payload（字段一一对应）。
 */
import { Logger } from "@nestjs/common";
import { ExecutionEventsListener } from "../execution-events.listener";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../../common/events/domain-events";

describe("ExecutionEventsListener (ARCH-21)", () => {
  let bus: { on: jest.Mock; off: jest.Mock };
  let notificationService: { notifyFailureWithConfig: jest.Mock };
  let auditService: { log: jest.Mock };
  let taskRepo: { findOne: jest.Mock };
  let listener: ExecutionEventsListener;

  const event = (
    overrides: Partial<ExecutionTerminalEventPayload> = {},
  ): ExecutionTerminalEventPayload => ({
    executionId: "e1",
    taskId: "t1",
    taskName: "nightly-etl",
    status: "failed",
    failureReason: "script_error",
    errorMessage: "Traceback: divide by zero",
    finishedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  });

  beforeEach(() => {
    bus = { on: jest.fn(), off: jest.fn() };
    notificationService = {
      notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    taskRepo = { findOne: jest.fn().mockResolvedValue(null) };
    listener = new ExecutionEventsListener(
      bus as unknown as DomainEventBus,
      notificationService as never,
      auditService as never,
      taskRepo as never,
    );
    // 本文件多数用例直调监听器；error 日志静音留给 fail-open 用例断言。
  });

  describe("failure notification equivalence (原「改动1」语义)", () => {
    it("notifies via notifyFailureWithConfig with task alarm config + taskId (args verbatim like pre-migration)", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "t1",
        alarmEmail: "ops@example.com",
        alarmChannels: ["email", "slack"],
        runbook: "docs/runbook.md#etl",
      });

      await listener.onExecutionFailed(event({ aiAnalysis: null }));

      expect(
        notificationService.notifyFailureWithConfig,
      ).toHaveBeenCalledTimes(1);
      const [name, id, error, ai, email, channels, wh, taskId, runbook] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(name).toBe("nightly-etl");
      expect(id).toBe("e1");
      // 内容含 failureReason + errorMessage 摘要（与旧路径逐字段同构）
      expect(error).toMatch(/script_error/i);
      expect(error).toMatch(/divide by zero/);
      expect(ai).toBe("");
      expect(email).toBe("ops@example.com");
      expect(channels).toEqual(["email", "slack"]);
      expect(wh).toBeUndefined();
      expect(taskId).toBe("t1");
      // FEAT-11: runbook 透传同旧路径。
      expect(runbook).toBe("docs/runbook.md#etl");
      // 配置回查走 taskRepo（迁移前同款只读查询）。
      expect(taskRepo.findOne).toHaveBeenCalledWith({ where: { id: "t1" } });
    });

    it("passes aiAnalysis through to the notification", async () => {
      await listener.onExecutionFailed(event({ aiAnalysis: "AI: OOM" }));
      const [, , , ai] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(ai).toBe("AI: OOM");
    });

    it("falls back to the first log line when errorMessage is absent", async () => {
      await listener.onExecutionFailed(
        event({ errorMessage: undefined, logs: "boom line\nmore" }),
      );
      const [, , error] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(error).toContain("boom line");
      expect(error).not.toContain("more");
    });

    it("uses 'no detail' when neither errorMessage nor logs are present", async () => {
      await listener.onExecutionFailed(
        event({ errorMessage: undefined, logs: undefined }),
      );
      const [, , error] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(error).toBe("script_error: no detail");
    });

    it("truncates the summary to 500 chars", async () => {
      await listener.onExecutionFailed(
        event({ errorMessage: "x".repeat(1000) }),
      );
      const [, , error] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(error.length).toBe(500);
    });

    it("skips the task lookup when taskId is null and still notifies", async () => {
      await listener.onExecutionFailed(event({ taskId: null }));
      expect(taskRepo.findOne).not.toHaveBeenCalled();
      expect(
        notificationService.notifyFailureWithConfig,
      ).toHaveBeenCalledTimes(1);
      const [name, , , , , , , taskId] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(name).toBe("nightly-etl");
      expect(taskId).toBeUndefined();
    });

    it("handles a timeout-status event identically (folded into execution.failed)", async () => {
      await listener.onExecutionFailed(
        event({ status: "timeout", failureReason: "timeout" }),
      );
      const [, , error] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(error).toMatch(/^timeout:/);
    });
  });

  describe("fail-open (NOTIFICATION_FAILED 审计兜底，语义自 task.service 原样迁移)", () => {
    it("a rejecting notification logs NOTIFICATION_FAILED audit and does not rethrow", async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      notificationService.notifyFailureWithConfig.mockRejectedValue(
        new Error("smtp down"),
      );

      await expect(
        listener.onExecutionFailed(event()),
      ).resolves.toBeUndefined();

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "NOTIFICATION_FAILED",
          resource: "task_execution",
          resourceId: "e1",
        }),
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("a throwing task lookup skips the notification but still audits", async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      taskRepo.findOne.mockRejectedValue(new Error("db down"));

      await expect(
        listener.onExecutionFailed(event()),
      ).resolves.toBeUndefined();

      expect(
        notificationService.notifyFailureWithConfig,
      ).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "NOTIFICATION_FAILED" }),
      );
      errorSpy.mockRestore();
    });

    it("a throwing audit write is swallowed too (best-effort)", async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      notificationService.notifyFailureWithConfig.mockRejectedValue(
        new Error("smtp down"),
      );
      auditService.log.mockRejectedValue(new Error("audit db down"));

      await expect(
        listener.onExecutionFailed(event()),
      ).resolves.toBeUndefined();
      errorSpy.mockRestore();
    });
  });

  describe("bus lifecycle wiring", () => {
    it("onModuleInit subscribes to execution.failed; onModuleDestroy unsubscribes", () => {
      const realBus = new DomainEventBus();
      const wired = new ExecutionEventsListener(
        realBus,
        notificationService as never,
        auditService as never,
        taskRepo as never,
      );
      expect(realBus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(0);
      wired.onModuleInit();
      expect(realBus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(1);
      wired.onModuleDestroy();
      expect(realBus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(0);
    });

    it("end-to-end via a real bus: emitted execution.failed reaches notify", async () => {
      const realBus = new DomainEventBus();
      const wired = new ExecutionEventsListener(
        realBus,
        notificationService as never,
        auditService as never,
        taskRepo as never,
      );
      wired.onModuleInit();
      realBus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, event());
      // 监听器为 async——等一轮 microtask 队列再断言。
      await new Promise((r) => setTimeout(r, 0));
      expect(
        notificationService.notifyFailureWithConfig,
      ).toHaveBeenCalledTimes(1);
    });
  });
});
