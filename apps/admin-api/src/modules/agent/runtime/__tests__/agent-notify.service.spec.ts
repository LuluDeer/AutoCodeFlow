import { ConfigService } from "@nestjs/config";

import { AgentNotifyService } from "../agent-notify.service";
import { AlertLevel } from "../../../notification/notification.service";
import type { AgentSession } from "../../entities/agent-session.entity";

function harness(configValue: unknown = undefined, notifyError?: Error) {
  const notifications = {
    notify: jest.fn(async () => {
      if (notifyError) throw notifyError;
    }),
  };
  const config = { get: jest.fn(() => configValue) };
  const svc = new AgentNotifyService(
    notifications as never,
    config as unknown as ConfigService,
  );
  return { svc, notifications, config };
}

function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "s-1",
    kind: "incident",
    title: null,
    status: "succeeded",
    summary: null,
    errorMessage: null,
    triggerSource: "event:execution.failed",
    totalSteps: 3,
    totalTokensIn: 10,
    totalTokensOut: 20,
    ...patch,
  } as unknown as AgentSession;
}

describe("AgentNotifyService · sessionFinished（静默成功是刻意设计）", () => {
  it("succeeded 有 summary → INFO 通知，摘要含用量", async () => {
    const h = harness();
    await h.svc.sessionFinished(session({ summary: "已修复" }));
    expect(h.notifications.notify).toHaveBeenCalledWith(
      "Agent:incident",
      expect.stringContaining("已修复"),
      AlertLevel.INFO,
    );
  });

  it("succeeded 无 summary → 静默（不通知）", async () => {
    const h = harness();
    await h.svc.sessionFinished(session({ summary: null }));
    expect(h.notifications.notify).not.toHaveBeenCalled();
    await h.svc.sessionFinished(session({ summary: "" }));
    expect(h.notifications.notify).not.toHaveBeenCalled();
  });

  it("title 优先于 kind 作 tag", async () => {
    const h = harness();
    await h.svc.sessionFinished(session({ title: "夜间巡检", summary: "ok" }));
    expect(h.notifications.notify).toHaveBeenCalledWith(
      "Agent:夜间巡检",
      expect.anything(),
      AlertLevel.INFO,
    );
  });

  it("aborted 不回推；failed/budget_exceeded → ERROR（errorMessage 优先）", async () => {
    const h = harness();
    await h.svc.sessionFinished(session({ status: "aborted" }));
    expect(h.notifications.notify).not.toHaveBeenCalled();

    await h.svc.sessionFinished(
      session({ status: "failed", errorMessage: "boom", summary: "s" }),
    );
    expect(h.notifications.notify).toHaveBeenLastCalledWith(
      "Agent:incident",
      expect.stringContaining("boom"),
      AlertLevel.ERROR,
    );

    await h.svc.sessionFinished(
      session({
        status: "budget_exceeded",
        errorMessage: null,
        summary: "超限",
      }),
    );
    expect(h.notifications.notify).toHaveBeenLastCalledWith(
      "Agent:incident",
      expect.stringContaining("超限"),
      AlertLevel.ERROR,
    );
  });
});

describe("AgentNotifyService · approvalRequested 与 fail-open", () => {
  it("待审批推送 WARNING", async () => {
    const h = harness();
    await h.svc.approvalRequested(session(), "sop_publish", "ap-1", "发布权");
    expect(h.notifications.notify).toHaveBeenCalledWith(
      "Agent审批:incident",
      expect.stringContaining("ap-1"),
      AlertLevel.WARNING,
    );
  });

  it("通知服务整体不可用时吞异常（fail-open，不回灌主链）", async () => {
    const h = harness(undefined, new Error("channel down"));
    await expect(
      h.svc.sessionFinished(session({ status: "failed", errorMessage: "x" })),
    ).resolves.toBeUndefined();
    await expect(
      h.svc.approvalRequested(session(), "t", "a", "r"),
    ).resolves.toBeUndefined();
  });

  it("开关解析：缺省开 / false·'0'·'false' 关 / 其余字符串开", async () => {
    const off1 = harness(false);
    await off1.svc.sessionFinished(session({ summary: "x" }));
    expect(off1.notifications.notify).not.toHaveBeenCalled();

    const off2 = harness("0");
    await off2.svc.sessionFinished(session({ summary: "x" }));
    expect(off2.notifications.notify).not.toHaveBeenCalled();

    const on1 = harness("false");
    await on1.svc.sessionFinished(session({ summary: "x" }));
    expect(on1.notifications.notify).not.toHaveBeenCalled();

    const on2 = harness("yes");
    await on2.svc.sessionFinished(session({ summary: "x" }));
    expect(on2.notifications.notify).toHaveBeenCalled();
  });
});
