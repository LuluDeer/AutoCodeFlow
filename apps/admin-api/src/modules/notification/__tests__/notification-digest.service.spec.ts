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
import RedisMock from "ioredis";
import { NotificationDigestService } from "../notification-digest.service";
import { NotificationService } from "../notification.service";
import { AuditService } from "../../audit/audit.service";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import {
  DIGEST_ESCALATION_THRESHOLD,
  DIGEST_KEY_PREFIX,
  DigestFailureRecord,
  DigestRedisClient,
  DigestWindowState,
} from "../notification-digest.service";

/**
 * R31-A3: 惰性建连面（ensureClient）的真实路径需要「ioredis 构造器」可观测。
 * 只替换模块出口，不改服务代码——测试可直接断言构造参数、connect() 调用、
 * error 监听与 quit/disconnect 收尾。
 */
interface MockRedisInstance {
  opts: Record<string, unknown>;
  on: jest.Mock;
  connect: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  hgetall: jest.Mock;
  del: jest.Mock;
}
const mockRedisInstances: MockRedisInstance[] = [];

jest.mock("ioredis", () => {
  const RedisMock = jest.fn((opts: Record<string, unknown>) => {
    const inst: MockRedisInstance = {
      opts,
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue("OK"),
      disconnect: jest.fn(),
      hgetall: jest.fn().mockResolvedValue({}),
      del: jest.fn().mockResolvedValue(0),
    };
    mockRedisInstances.push(inst);
    return inst;
  });
  return { __esModule: true, default: RedisMock };
});

const redisCtor = RedisMock as unknown as jest.Mock;

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
  async hget(key: string, field: string): Promise<string | null> {
    return this.field(key).get(field) ?? null;
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

/** A-7: 带 EVAL 的替身——模拟 ioredis 的 Lua 原子 HGETALL+DEL（真实路径）。 */
class FakeRedisWithEval extends FakeRedis {
  evalCalls = 0;
  /** 与服务的 TAKE_WINDOW_LUA 同语义：读全值 + 删键在同一原子单元内 */
  async eval(_script: string, numKeys: number, key: string): Promise<string[]> {
    this.evalCalls += 1;
    expect(numKeys).toBe(1);
    const f = this.store.get(key);
    const flat: string[] = [];
    if (f) {
      for (const [k, v] of f) flat.push(k, v);
      this.store.delete(key);
    }
    return flat;
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

  // ============================================================================
  // A-7: 聚合窗丢失路径修复。
  // ① flush 走 Lua 原子取窗（HGETALL+DEL 单脚本，ioredis EVAL 路径）；
  // ② record 对「无 start 字段的存活孤儿窗」接管 flush 定时器——修复
  //    「B 的 hsetnx 落在 A 的删窗前、写入落在删窗后 → 键重建无 start 且
  //    无人挂 flush → 该批失败永不汇总」的丢失路径。
  // ============================================================================
  describe("A-7 原子取窗与孤儿窗接管", () => {
    let evalRedis: FakeRedisWithEval;
    let evalService: NotificationDigestService;

    beforeEach(() => {
      evalRedis = new FakeRedisWithEval();
      evalService = makeService();
      evalService.setRedisClientForTesting(evalRedis);
    });

    afterEach(async () => {
      await evalService.onModuleDestroy();
    });

    it("flush 走 EVAL 原子路径（不再两步 HGETALL+DEL），汇总照发、窗照删", async () => {
      await evalService.recordFailure(rec());
      const state = await evalService.flush("t1");
      expect(evalRedis.evalCalls).toBe(1);
      expect(state).not.toBeNull();
      expect(state!.count).toBe(1);
      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        1,
      );
      // 窗已删：二次 flush 拿到空集 → null
      await expect(evalService.flush("t1")).resolves.toBeNull();
    });

    it("并发交错（mock 顺序注入）：B 的 hsetnx 落在 flush 删窗前、写入落在删窗后 → 孤儿窗被 record 接管，该批失败仍被汇总（无丢失）", async () => {
      // 第一批正常入窗 + flush 发出
      await evalService.recordFailure(rec({ executionId: "e1" }));
      await evalService.flush("t1");
      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        1,
      );

      // 模拟竞态：第二条记录的 hsetnx 恰好排在 flush 的原子 DEL 之前
      // （键还存在 → 返回 0，B 不挂 flush），而 DEL 紧随其后把键删掉，
      // B 的后续写入重建出**无 start 字段**的孤儿窗。
      jest.spyOn(evalRedis, "hsetnx").mockImplementationOnce(async () => 0);

      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      await expect(
        evalService.recordFailure(rec({ executionId: "e2" })),
      ).resolves.toBe("aggregated");
      warnSpy.mockRestore();

      // 孤儿窗（无 start）存活：record 探测到缺失的 start 后接管 flush 责任
      expect(
        (evalService as unknown as { timers: Map<string, unknown> }).timers.has(
          "t1",
        ),
      ).toBe(true);
      // 窗到期 flush → 第二批失败被汇总（计数不丢）
      const state = await evalService.flush("t1");
      expect(state).not.toBeNull();
      expect(state!.count).toBe(1);
      expect(state!.lastExecutionId).toBe("e2");
      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        2,
      );
    });

    it("预置的孤儿存活窗（有 count/ctx、无 start）在下一次 record 时被接管", async () => {
      // 直接种一个「flush 删窗后写入重建」形态的孤儿窗
      await redis.hset(`${DIGEST_KEY_PREFIX}t1`, "count", "2");
      await redis.hset(
        `${DIGEST_KEY_PREFIX}t1`,
        "ctx",
        JSON.stringify({ taskName: "nightly-etl" }),
      );
      expect(await redis.hget(`${DIGEST_KEY_PREFIX}t1`, "start")).toBeNull();

      await expect(service.recordFailure(rec())).resolves.toBe("aggregated");
      // 接管：flush 定时器已挂
      expect(
        (service as unknown as { timers: Map<string, unknown> }).timers.has(
          "t1",
        ),
      ).toBe(true);

      // 到期 flush → 孤儿窗内容不丢
      const state = await service.flush("t1");
      expect(state).not.toBeNull();
      expect(state!.count).toBe(3);
    });

    it("正常存活窗（带 start）不重复挂 flush 定时器", async () => {
      await service.recordFailure(rec());
      await service.recordFailure(
        rec({ failureReason: "timeout", executionId: "e2" }),
      );
      const timers = (service as unknown as { timers: Map<string, unknown> })
        .timers;
      expect(timers.size).toBe(1);
      expect(timers.has("t1")).toBe(true);
      expect(await redis.hget(`${DIGEST_KEY_PREFIX}t1`, "start")).toBeDefined();
    });
  });
});

// ============================================================================
// R31-A3: 生命周期与 fail-open 的**另一半**（此前完全未测的面）：
//  · ensureClient 惰性建连（ioredis 构造参数 / connect() / error 监听）；
//  · 建连失败 → 客户端缺席，record 回退 bypass、flush 返回 null（fail-open 第一层）；
//  · onModuleDestroy 的 quit / 清定时器表 / 丢弃替身（句柄不泄漏）；
//  · flush 的**取窗**失败（不是发送失败）→ null + NOTIFICATION_FAILED 审计；
//  · 窗到期由**定时器自己**触发 flush——这是聚合的唯一正常出口，此前只测了
//    手工调用 flush(taskId)，没钉「没人调用也会汇总」与「只汇总一次」。
// ============================================================================
describe("NotificationDigestService 生命周期与 fail-open（R31-A3）", () => {
  /** 窗口 = 10 分钟（默认值），定时器到期即汇总。 */
  const WINDOW_MINUTES = 10;

  let notificationService: { notifyFailureWithConfig: jest.Mock };
  let auditService: { log: jest.Mock };
  let redisConfig: Record<string, unknown>;

  const config = () =>
    ({
      get: (key: string) =>
        key === "notification.failureDigestMinutes"
          ? WINDOW_MINUTES
          : redisConfig[key],
    }) as unknown as ConfigService;

  const build = (audit?: { log: jest.Mock }) =>
    new NotificationDigestService(
      notificationService as unknown as NotificationService,
      config(),
      audit as unknown as AuditService,
    );

  const timersOf = (svc: NotificationDigestService) =>
    (svc as unknown as { timers: Map<string, unknown> }).timers;

  beforeEach(() => {
    mockRedisInstances.length = 0;
    redisCtor.mockClear();
    notificationService = {
      notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    redisConfig = {
      "redis.host": "redis-host",
      "redis.port": 6380,
      "redis.password": "pw",
      "redis.db": 3,
    };
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("惰性建连：首次用到才 new ioredis（host/port/password/db + lazyConnect + commandTimeout），注册 error 监听并 connect()；之后复用同一连接", async () => {
    const svc = build();

    await expect(svc.flush("t-live")).resolves.toBeNull();

    expect(mockRedisInstances).toHaveLength(1);
    const inst = mockRedisInstances[0];
    expect(inst.opts).toMatchObject({
      host: "redis-host",
      port: 6380,
      password: "pw",
      db: 3,
      lazyConnect: true,
      commandTimeout: 3000,
    });
    expect(inst.connect).toHaveBeenCalledTimes(1);
    expect(inst.on).toHaveBeenCalledWith("error", expect.any(Function));
    // 重连退避：线性 100ms 递增、上限 3s（安静重试，不惊动主链）
    const retry = inst.opts.retryStrategy as (times: number) => number;
    expect(retry(5)).toBe(500);
    expect(retry(100)).toBe(3000);

    // error 监听只记 warn（聚合是增强面，绝不因连接抖动打扰主链）
    const onError = inst.on.mock.calls[0][1] as (err: Error) => void;
    onError(new Error("conn reset"));
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      "digest redis error: conn reset",
    );

    // 第二次使用不重复构造（连接池复用）
    await expect(svc.flush("t-live-2")).resolves.toBeNull();
    expect(mockRedisInstances).toHaveLength(1);
    expect(inst.connect).toHaveBeenCalledTimes(1);

    await svc.onModuleDestroy();
  });

  it("建连构造失败（驱动/参数抛错）→ 客户端缺席：flush 返回 null、recordFailure 回退 bypass（fail-open 第一层）", async () => {
    redisCtor.mockImplementationOnce(() => {
      throw new Error("ECONNREFUSED 6379");
    });
    const svc = build();

    await expect(svc.flush("t1")).resolves.toBeNull();
    await expect(svc.recordFailure(rec())).resolves.toBe("bypass");

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("digest redis unavailable: ECONNREFUSED 6379"),
    );
    // 降级为逐条直发由调用方负责：digest 自身一条都不发
    expect(notificationService.notifyFailureWithConfig).not.toHaveBeenCalled();
  });

  it("onModuleDestroy：quit 惰性建连的存活连接（不留句柄拖住进程），二次调用幂等", async () => {
    const svc = build();
    await svc.flush("t-boot");
    const inst = mockRedisInstances[0];

    await svc.onModuleDestroy();
    expect(inst.quit).toHaveBeenCalledTimes(1);
    expect(
      (svc as unknown as { client: unknown }).client,
    ).toBeNull();

    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    expect(inst.quit).toHaveBeenCalledTimes(1);
  });

  it("setRedisClientForTesting 替换客户端时先断开旧连接；onModuleDestroy 清空定时器表与替身", async () => {
    const svc = build();
    await svc.flush("t-boot"); // 真实客户端先就位
    const inst = mockRedisInstances[0];

    svc.setRedisClientForTesting(new FakeRedis());
    expect(inst.disconnect).toHaveBeenCalledTimes(1);

    await svc.recordFailure(rec());
    expect(timersOf(svc).size).toBe(1);

    await svc.onModuleDestroy();
    expect(timersOf(svc).size).toBe(0);
    expect(
      (svc as unknown as { testClient?: unknown }).testClient,
    ).toBeNull();
  });

  it("窗到期由定时器自己 flush（不依赖调用方）：只发一条汇总，定时器先摘表，窗不再重复发", async () => {
    const svc = build();
    svc.setRedisClientForTesting(new FakeRedis());

    jest.useFakeTimers();
    try {
      await svc.recordFailure(rec());
      expect(timersOf(svc).has("t1")).toBe(true);
      // 窗内不发：聚合的全部意义
      expect(notificationService.notifyFailureWithConfig).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(WINDOW_MINUTES * 60_000 + 1);

      expect(timersOf(svc).has("t1")).toBe(false);
      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        1,
      );
      const call = notificationService.notifyFailureWithConfig.mock.calls[0];
      expect(call[10]).toBe("任务失败汇总: nightly-etl");
      expect(call[2]).toContain("窗口内共失败 1 次");

      // 窗已原子取走：再等一个窗口不会复发
      await jest.advanceTimersByTimeAsync(WINDOW_MINUTES * 60_000 + 1);
      expect(notificationService.notifyFailureWithConfig).toHaveBeenCalledTimes(
        1,
      );
    } finally {
      jest.useRealTimers();
    }

    await svc.onModuleDestroy();
  });

  it("flush 取窗失败 → 返回 null + NOTIFICATION_FAILED 审计兜底（审计自身再失败也不外泄）", async () => {
    const broken = {
      hgetall: jest.fn().mockRejectedValue(new Error("redis gone")),
    } as unknown as DigestRedisClient;
    const svc = build(auditService);
    svc.setRedisClientForTesting(broken);

    await expect(svc.flush("t1")).resolves.toBeNull();

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("digest flush failed for task t1: redis gone"),
    );
    expect(auditService.log).toHaveBeenCalledWith({
      action: "NOTIFICATION_FAILED",
      resource: "notification_digest",
      resourceId: "t1",
      detail: { error: "redis gone" },
    });

    // 审计是 best-effort：它自己抛也不许冒泡
    auditService.log.mockRejectedValueOnce(new Error("audit down"));
    await expect(svc.flush("t1")).resolves.toBeNull();

    // 非 Error 抛出物同样收敛为字符串（String(err) 分支）
    const stringThrower = {
      hgetall: jest.fn().mockRejectedValue("plain-string-redis-error"),
    } as unknown as DigestRedisClient;
    svc.setRedisClientForTesting(stringThrower);
    await expect(svc.flush("t1")).resolves.toBeNull();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("plain-string-redis-error"),
    );
  });

  it("审计服务缺席（@Optional）时 flush 失败只记 warn，不抛错", async () => {
    const broken = {
      hgetall: jest.fn().mockRejectedValue(new Error("redis gone")),
    } as unknown as DigestRedisClient;
    const svc = build(); // 未提供 AuditService
    svc.setRedisClientForTesting(broken);

    await expect(svc.flush("t1")).resolves.toBeNull();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("digest flush failed for task t1"),
    );
  });
});
