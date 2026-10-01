/**
 * DEEP-AUDIT B·1.6: 失败通知聚合窗（digest）三态单测。
 *
 * 覆盖：
 * - 关闭（NOTIFICATION_FAILURE_DIGEST_MINUTES=0 / 非法值）→ bypass 直发；
 * - 聚合（窗内多条失败累计，flush 发一条汇总，含原因分布）；
 * - 升级（同窗 ≥ DIGEST_ESCALATION_THRESHOLD 条 → 紧急标题与措辞）；
 * - 边界：无 taskId bypass、Redis 记录失败 bypass（fail-open）、
 *   flush 后窗删除、flush 发送失败落 NOTIFICATION_FAILED 审计。
 *
 * Redis 用内存替身（DigestRedisClient 结构化注入，见服务内注释）。
 */
import { NotificationDigestService } from "../notification-digest.service";
import { NotificationService } from "../notification.service";
import { AuditService } from "../../audit/audit.service";
import { ConfigService } from "@nestjs/config";
import {
  DIGEST_ESCALATION_THRESHOLD,
  DIGEST_KEY_PREFIX,
  DigestFailureRecord,
  DigestRedisClient,
  DigestWindowState,
} from "../notification-digest.service";

/** DigestRedisClient 的内存实现（hash 语义 + 计数器）。 */
class FakeRedis implements DigestRedisClient {
  store = new Map<string, Map<string, string>>();
  hsetnxCalls = 0;

  private field(key: string): Map<string, string> {
    let f = this.store.get(key);
    if (!f) {
      f = new Map();
      this.store.set(key, f);
    }
    return f;
  }

  async hsetnx(key: string, field: string, value: string): Promise<number> {
    this.hsetnxCalls += 1;
    const f = this.field(key);
    if (f.has(field)) return 0;
    f.set(field, value);
    return 1;
  }
  async hincrby(key: string, field: string, inc: number): Promise<number> {
    const f = this.field(key);
    const next = (parseInt(f.get(field) ?? "0", 10) || 0) + inc;
    f.set(field, String(next));
    return next;
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.field(key).set(field, value);
    return 1;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    const f = this.store.get(key);
    if (!f) return {};
    return Object.fromEntries(f);
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const rec = (
  overrides: Partial<DigestFailureRecord> = {},
): DigestFailureRecord => ({
  taskId: "t1",
  taskName: "nightly-etl",
  failureReason: "script_error",
  errorSummary: "script_error: boom",
  executionId: "e1",
  alarmEmail: "ops@example.com",
  alarmChannels: ["email"],
  runbook: null,
  applicationId: "app-1",
  ...overrides,
});

describe("NotificationDigestService (DEEP-AUDIT B·1.6)", () => {
  let redis: FakeRedis;
  let notificationService: { notifyFailureWithConfig: jest.Mock };
  let auditService: { log: jest.Mock };
  let digestMinutes: number | undefined;
  let service: NotificationDigestService;

  const makeService = () =>
    new NotificationDigestService(
      notificationService as unknown as NotificationService,
      {
        get: (key: string) =>
          key === "notification.failureDigestMinutes"
            ? digestMinutes
            : undefined,
      } as unknown as ConfigService,
      auditService as unknown as AuditService,
    );

  beforeEach(() => {
    redis = new FakeRedis();
    notificationService = {
      notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    digestMinutes = 10;
    service = makeService();
    service.setRedisClientForTesting(redis);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe("关闭态（bypass 直发回退）", () => {
    it("window=0 → recordFailure returns bypass and touches no redis state", async () => {
      digestMinutes = 0;
      await expect(service.recordFailure(rec())).resolves.toBe("bypass");
      expect(redis.store.size).toBe(0);
      // 关闭态下通知仍由调用方（listener）逐条直发——digest 自身不发。
      expect(
        notificationService.notifyFailureWithConfig,
      ).not.toHaveBeenCalled();
    });

    it("non-numeric window config → treated as disabled", async () => {
      digestMinutes = undefined;
      await expect(service.recordFailure(rec())).resolves.toBe("bypass");
      expect(service.getDigestWindowMs()).toBe(0);
    });

    it("missing taskId → bypass (aggregation meaningless without a task key)", async () => {
      await expect(
        service.recordFailure(rec({ taskId: undefined })),
      ).resolves.toBe("bypass");
      expect(redis.store.size).toBe(0);
    });

    it("redis record failure → bypass (fail-open, caller falls back to direct send)", async () => {
      const failing = {
        hsetnx: jest.fn().mockRejectedValue(new Error("redis down")),
      } as unknown as DigestRedisClient;
      service.setRedisClientForTesting(failing);
      await expect(service.recordFailure(rec())).resolves.toBe("bypass");
    });
  });

  describe("聚合态", () => {
    it("records accumulate in one window keyed by taskId with per-reason counters", async () => {
      await expect(service.recordFailure(rec())).resolves.toBe("aggregated");
      await expect(
        service.recordFailure(
          rec({ failureReason: "timeout", executionId: "e2" }),
        ),
      ).resolves.toBe("aggregated");
      await expect(
        service.recordFailure(
          rec({ failureReason: "script_error", executionId: "e3" }),
        ),
      ).resolves.toBe("aggregated");

      const raw = await redis.hgetall(`${DIGEST_KEY_PREFIX}t1`);
      expect(raw["count"]).toBe("3");
      expect(raw["r:script_error"]).toBe("2");
      expect(raw["r:timeout"]).toBe("1");
      // lastError/lastExecutionId 覆盖式更新为最新一条。
      expect(raw["lastExecutionId"]).toBe("e3");
    });

    it("flush sends exactly one summary via notifyFailureWithConfig with digest titleOverride", async () => {
      await service.recordFailure(rec());
      await service.recordFailure(
        rec({ failureReason: "timeout", executionId: "e2" }),
      );

      const state: DigestWindowState | null = await service.flush("t1");
      expect(state).not.toBeNull();
      expect(state!.count).toBe(2);
      expect(state!.taskName).toBe("nightly-etl");
      expect(state!.reasons).toEqual({ script_error: 1, timeout: 1 });
      expect(state!.ctx.alarmEmail).toBe("ops@example.com");
      expect(state!.ctx.alarmChannels).toEqual(["email"]);
      expect(state!.ctx.applicationId).toBe("app-1");

      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        1,
      );
      const [
        name,
        execId,
        summary,
        ai,
        email,
        channels,
        _wh,
        taskId,
        _runbook,
        appId,
        title,
      ] = notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(name).toBe("nightly-etl");
      expect(execId).toBe("e2"); // 最近一次失败的执行
      expect(summary).toContain("窗口内共失败 2 次");
      expect(summary).toContain("script_error×1");
      expect(summary).toContain("timeout×1");
      expect(ai).toBe("");
      expect(email).toBe("ops@example.com");
      expect(channels).toEqual(["email"]);
      expect(taskId).toBe("t1");
      expect(appId).toBe("app-1");
      expect(title).toBe("任务失败汇总: nightly-etl");
    });

    it("window is deleted after flush (second flush is a no-op, no duplicate summary)", async () => {
      await service.recordFailure(rec());
      await service.flush("t1");
      await expect(service.flush("t1")).resolves.toBeNull();
      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  describe("升级态（≥阈值紧急措辞）", () => {
    it(`escalates title and body once count >= ${DIGEST_ESCALATION_THRESHOLD}`, async () => {
      for (let i = 0; i < DIGEST_ESCALATION_THRESHOLD; i += 1) {
        await service.recordFailure(rec({ executionId: `e${i}` }));
      }
      await service.flush("t1");

      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        1,
      );
      const [, , summary, , , , , , , , title] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(title).toBe("【紧急】任务连续失败: nightly-etl");
      expect(summary).toContain("【紧急】");
      expect(summary).toContain(`失败已达 ${DIGEST_ESCALATION_THRESHOLD} 次`);
    });

    it("stays at normal wording below the threshold", async () => {
      for (let i = 0; i < DIGEST_ESCALATION_THRESHOLD - 1; i += 1) {
        await service.recordFailure(rec({ executionId: `e${i}` }));
      }
      await service.flush("t1");
      const [, , summary, , , , , , , , title] =
        notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(title).toBe("任务失败汇总: nightly-etl");
      expect(summary).not.toContain("【紧急】");
    });
  });

  describe("flush 兜底与状态还原", () => {
    it("flush send failure → NOTIFICATION_FAILED audit (best-effort), no rethrow", async () => {
      notificationService.notifyFailureWithConfig.mockRejectedValue(
        new Error("smtp down"),
      );
      await service.recordFailure(rec());
      // flush 本身不抛：发送失败被 sendDigest 内部吞掉并落审计，窗状态照常返回。
      await expect(service.flush("t1")).resolves.toEqual(
        expect.objectContaining({ taskId: "t1", count: 1 }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "NOTIFICATION_FAILED",
          resource: "notification_digest",
          resourceId: "t1",
        }),
      );
    });

    it("parseWindowState: corrupted ctx falls back to taskId as taskName; r: fields become reason distribution", () => {
      const state = service.parseWindowState("t9", {
        count: "4",
        "r:timeout": "3",
        "r:boom": "x", // 非法计数被忽略
        ctx: "{not-json",
        lastError: "timeout: late",
        lastExecutionId: "e9",
      });
      expect(state.taskName).toBe("t9");
      expect(state.count).toBe(4);
      expect(state.reasons).toEqual({ timeout: 3 });
      expect(state.lastError).toBe("timeout: late");
      expect(state.lastExecutionId).toBe("e9");
    });
  });
});
