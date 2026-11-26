import { HOUR_MS, SLA_LIMITS } from "../sla-meter";
import { assessSlaDeadlines } from "../sla-assessment";
import {
  SLA_BREACH_AUDIT_ACTION,
  SlaAlertConsumer,
  type AlertSink,
  type SlaAlertAuditEntry,
  type SlaAlertMessage,
  type SlaAlertPolicy,
} from "../sla-alert.consumer";

const at = (iso: string): number => Date.parse(iso);
const MON_9 = at("2026-01-05T09:00:00Z");

interface FakeSink extends AlertSink {
  calls: SlaAlertMessage[];
  send: jest.Mock<Promise<string>, [SlaAlertMessage]>;
}

function fakeSink(): FakeSink {
  const calls: SlaAlertMessage[] = [];
  return {
    calls,
    send: jest.fn(async (message: SlaAlertMessage) => {
      calls.push(message);
      return "sent";
    }),
  };
}

interface FakeAudit {
  entries: SlaAlertAuditEntry[];
  log: jest.Mock<Promise<void>, [SlaAlertAuditEntry]>;
}

function fakeAudit(): FakeAudit {
  const entries: SlaAlertAuditEntry[] = [];
  return {
    entries,
    log: jest.fn(async (entry: SlaAlertAuditEntry) => {
      entries.push(entry);
    }),
  };
}

function fakeLogger() {
  const warns: string[] = [];
  return {
    warns,
    warn: jest.fn((message: string) => {
      warns.push(message);
    }),
  };
}

describe("N22 SLA 告警消费层（内存替身级）", () => {
  it("① breached 项触发告警，只发给中台 managed + 追加的 project receiver", async () => {
    // 单独构造：一条违约 + 一条未超（不同 startedAt），验证 pending 不进告警。
    const collection = assessSlaDeadlines(
      [
        { id: "overdue", kind: "quota_alert", startedAt: MON_9 },
        {
          id: "still-pending",
          kind: "quota_alert",
          startedAt: MON_9 + 2 * HOUR_MS,
        },
      ],
      MON_9 + 3 * HOUR_MS,
    );
    expect(collection.summary.breachedIds).toEqual(["overdue"]);

    const sink = fakeSink();
    const audit = fakeAudit();
    const policy: SlaAlertPolicy = {
      managedChannels: ["managed-wecom-ops"],
      projectReceivers: ["alice@example.com"],
    };
    const result = await new SlaAlertConsumer(audit).consume(
      collection,
      sink,
      policy,
    );

    expect(result.status).toBe("sent");
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(sink.calls[0].breachedIds).toEqual(["overdue"]);
    expect(sink.calls[0].channels).toEqual(["managed-wecom-ops"]);
    expect(sink.calls[0].receivers).toEqual(["alice@example.com"]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe("capability.sla_breach");
    expect(audit.entries[0].result).toBe("success");
  });

  it("② 项目 enabled:false / 尝试删 managed channel 都关不掉中台告警", async () => {
    const collection = assessSlaDeadlines(
      [{ id: "overdue", kind: "quota_alert", startedAt: MON_9 }],
      MON_9 + 3 * HOUR_MS,
    );
    const sink = fakeSink();
    const hostile = {
      managedChannels: ["managed-wecom-ops"],
      projectReceivers: ["carol@example.com"],
      // 项目侧试图关掉 / 删除中台目标；consumer 根本不读这两个字段。
      projectEnabled: false,
      removedManagedChannels: ["managed-wecom-ops"],
    } as SlaAlertPolicy & {
      projectEnabled: boolean;
      removedManagedChannels: string[];
    };

    const result = await new SlaAlertConsumer(fakeAudit()).consume(
      collection,
      sink,
      hostile,
    );

    expect(result.status).toBe("sent");
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(sink.calls[0].channels).toEqual(["managed-wecom-ops"]);
    expect(sink.calls[0].receivers).toEqual(["carol@example.com"]);
  });

  it("③ 无 managed channel → fail-closed：不发包，写失败审计 + 日志", async () => {
    const collection = assessSlaDeadlines(
      [{ id: "overdue", kind: "quota_alert", startedAt: MON_9 }],
      MON_9 + 3 * HOUR_MS,
    );
    const sink = fakeSink();
    const audit = fakeAudit();
    const logger = fakeLogger();

    const result = await new SlaAlertConsumer(audit, logger).consume(
      collection,
      sink,
      { managedChannels: [], projectReceivers: ["bob@example.com"] },
    );

    expect(result.status).toBe("fail_closed");
    expect(result.reason).toBe("no_managed_channel");
    expect(sink.send).toHaveBeenCalledTimes(0);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: SLA_BREACH_AUDIT_ACTION,
      result: "failure",
    });
    expect(audit.entries[0].detail).toMatchObject({
      reason: "no_managed_channel",
      breachedIds: ["overdue"],
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warns.join("\n")).toContain("fail-closed");
  });

  it("④ 跨周末业务钟 breached 判定复用 assessSlaDeadlines，consumer 不重算时钟", async () => {
    const collection = assessSlaDeadlines(
      [
        {
          id: "cross-weekend-met",
          kind: "capability_review",
          startedAt: at("2026-01-02T17:00:00Z"), // 周五 17:00
          // completedAt 锁定观察点：业务钟只走 2h（周五 1h + 周一 1h），
          // 墙钟口径则是 65h ⇒ 若 consumer 重算墙钟，本用例立刻转红。
          completedAt: at("2026-01-05T10:00:00Z"),
        },
        {
          id: "cross-weekend-over-10h",
          kind: "capability_review",
          startedAt: at("2026-01-02T17:00:00Z"),
        },
        {
          id: "cross-weekend-over-15h",
          kind: "capability_review",
          startedAt: at("2026-01-02T12:00:00Z"), // 周五 12:00
        },
      ],
      at("2026-01-05T18:00:00Z"), // 周一 18:00
    );

    expect(collection[0].elapsedMs).toBe(2 * HOUR_MS);
    expect(collection[0].status).toBe("met");
    // 业务钟：周五 17→18 1h + 周一 09→18 9h → 10h > 1 工作日(9h) = breached
    expect(collection[1].elapsedMs).toBe(10 * HOUR_MS);
    expect(collection[1].status).toBe("breached");
    // 周五 12→18 6h + 周一 09→18 9h = 15h
    expect(collection[2].elapsedMs).toBe(15 * HOUR_MS);
    expect(collection[2].status).toBe("breached");
    expect(SLA_LIMITS.capability_review).toBe(9 * HOUR_MS);

    const sink = fakeSink();
    const result = await new SlaAlertConsumer(fakeAudit()).consume(
      collection,
      sink,
      { managedChannels: ["managed-wecom-ops"] },
    );

    expect(result.status).toBe("sent");
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(sink.calls[0].breachedIds).toEqual(collection.summary.breachedIds);
    expect(sink.calls[0].breachedIds).toEqual([
      "cross-weekend-over-10h",
      "cross-weekend-over-15h",
    ]);
    expect(sink.calls[0].breachedIds).not.toContain("cross-weekend-met");
  });

  it("⑤ payload / 审计不含 webhook URL 与密钥明文", async () => {
    const collection = assessSlaDeadlines(
      [{ id: "overdue", kind: "quota_alert", startedAt: MON_9 }],
      MON_9 + 3 * HOUR_MS,
    );
    const sink = fakeSink();
    const audit = fakeAudit();
    const secretToken = "https://hooks.example.com/x?token=TOP_SECRET_ABC";
    const secretKey = "https://hooks.example.com/y?key=KEY_SECRET_XYZ";

    await new SlaAlertConsumer(audit).consume(collection, sink, {
      managedChannels: [secretToken, secretKey],
      projectReceivers: ["alice@example.com"],
    });

    const wire = JSON.stringify(sink.calls[0]);
    const audited = JSON.stringify(audit.entries);
    for (const blob of [wire, audited]) {
      expect(blob).not.toContain("TOP_SECRET_ABC");
      expect(blob).not.toContain("KEY_SECRET_XYZ");
      expect(blob).not.toContain("webhookUrl");
    }
    expect(sink.calls[0].channels[0]).toContain("token=***");
    expect(sink.calls[0].channels[1]).toContain("key=***");
  });

  it("⑥ 两向反证：项目 enabled:false 真关掉告警时本用例转红", async () => {
    const collection = assessSlaDeadlines(
      [{ id: "overdue", kind: "quota_alert", startedAt: MON_9 }],
      MON_9 + 3 * HOUR_MS,
    );
    const sink = fakeSink();
    const hostile = {
      managedChannels: ["managed-wecom-ops"],
      projectReceivers: [],
      projectEnabled: false,
    } as SlaAlertPolicy & { projectEnabled: boolean };

    const result = await new SlaAlertConsumer(fakeAudit()).consume(
      collection,
      sink,
      hostile,
    );

    // 正常实现忽略项目侧开关 ⇒ 绿；若 consumer 真读 projectEnabled 关掉告警 ⇒ 红。
    expect(result.status).toBe("sent");
    expect(sink.send).toHaveBeenCalledTimes(1);
  });

  it("⑦ sink 抛错也留失败审计，不伪造发送成功", async () => {
    const collection = assessSlaDeadlines(
      [{ id: "overdue", kind: "quota_alert", startedAt: MON_9 }],
      MON_9 + 3 * HOUR_MS,
    );
    const sink: AlertSink = {
      send: jest.fn(async () => {
        throw new Error("TRANSPORT_DOWN");
      }),
    };
    const audit = fakeAudit();
    const logger = fakeLogger();

    const result = await new SlaAlertConsumer(audit, logger).consume(
      collection,
      sink,
      { managedChannels: ["managed-wecom-ops"] },
    );

    expect(result.status).toBe("delivery_failed");
    expect(result.reason).toBe("delivery_failed");
    expect(audit.entries[0].result).toBe("failure");
    expect(audit.entries[0].detail).toMatchObject({
      reason: "delivery_failed",
    });
    expect(logger.warns.join("\n")).toContain("delivery_failed");
  });
});
