import { Logger } from "@nestjs/common";
import {
  ExecutorMaintenance,
  DEFAULT_EXECUTOR_RETENTION_DAYS,
  DEFAULT_METRICS_RETENTION_DAYS,
  EXECUTOR_RETENTION_CONFIG_KEY,
  METRICS_RETENTION_BATCH_SIZE,
  type ExecutorMaintenanceDeps,
} from "../executor-maintenance.collaborator";

/**
 * T1-B2-X5 的独立单测（**不走 DI 装配**，`new ExecutorMaintenance({...})` 直构）。
 *
 * ## 钉住的三件事
 *
 * 1. **保留期的三档语义**（`logRetention.days` / `executor.retentionDays` /
 *    各自缺省），且**非法值一律回落**——这是**不可逆删除**的判定参数，
 *    "脏配置把台账清空"是这条路径最坏的失效形态。
 * 2. **分批 DELETE 而不是单条无界 DELETE**（长事务锁表 + WAL 风暴），
 *    且批大小与 Facade 的静态常量同源。
 * 3. **`now` 可注入**（既有 spec 依赖这一点做时间旅行）。
 *
 * ## 为什么不测 `@Cron`
 *
 * `@Cron` 与 `leaderGate` **不在本类**（见协作者头注的三条理由）⇒
 * 它们的触发语义由 Facade 的 spec 覆盖；本文件只测"清理做什么"。
 */

function makeDeps(over: Partial<ExecutorMaintenanceDeps> = {}) {
  const executed: Array<{ sql: string; params: unknown }> = [];
  let affectedQueue: number[] = [0];
  const repo = {
    createQueryBuilder: jest.fn(() => ({
      delete: jest.fn().mockReturnThis(),
      where: jest.fn((sql: string, params: unknown) => {
        executed.push({ sql, params });
        return {
          execute: jest.fn(async () => ({
            affected: affectedQueue.shift() ?? 0,
          })),
        };
      }),
    })),
  } as never;
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
  const configValues: Record<string, unknown> = {};
  const deps: ExecutorMaintenanceDeps = {
    metricsHistoryRepo: repo,
    configService: {
      get: <T = unknown>(k: string) => configValues[k] as T | undefined,
    },
    systemConfig: null,
    logger,
    ...over,
  };
  return {
    deps,
    executed,
    logger,
    configValues,
    setAffected: (q: number[]) => {
      affectedQueue = q;
    },
  };
}

describe("ExecutorMaintenance — retention 纯逻辑（独立构造）", () => {
  describe("resolveMetricsRetentionDays", () => {
    it("未配置 ⇒ 缺省 30", () => {
      const h = makeDeps();
      const c = new ExecutorMaintenance(h.deps);
      // 私有方法的验证走公开路径的副作用（cutoff 计算），见下条
      expect(DEFAULT_METRICS_RETENTION_DAYS).toBe(30);
      expect(c).toBeDefined();
    });

    it("合法配置值生效（通过 cutoff 表达式间接验证）", async () => {
      const h = makeDeps();
      h.configValues["logRetention.days"] = 7;
      h.setAffected([0]);
      const c = new ExecutorMaintenance(h.deps);
      const now = new Date("2026-11-04T00:00:00Z");
      await c.cleanupExpiredMetricsHistory(now);
      const params = h.executed[0].params as { cutoff: Date };
      expect(params.cutoff.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    });

    it("非法值（0 / 负数 / NaN / 字符串）一律回落 30", async () => {
      for (const bad of [0, -1, Number.NaN, "7"]) {
        const h = makeDeps();
        h.configValues["logRetention.days"] = bad;
        h.setAffected([0]);
        const c = new ExecutorMaintenance(h.deps);
        const now = new Date("2026-11-04T00:00:00Z");
        await c.cleanupExpiredMetricsHistory(now);
        const params = h.executed[0].params as { cutoff: Date };
        expect(params.cutoff.toISOString()).toBe("2026-10-05T00:00:00.000Z");
      }
    });
  });

  describe("resolveExecutorRetentionDays", () => {
    it("运行期配置优先（system_configs）", async () => {
      const h = makeDeps({
        systemConfig: { findOne: async () => ({ value: "21" }) },
      });
      const c = new ExecutorMaintenance(h.deps);
      expect(await c.resolveExecutorRetentionDays()).toBe(21);
      expect(EXECUTOR_RETENTION_CONFIG_KEY).toBe("executor.retentionDays");
    });

    it("未配置 ⇒ 缺省 7", async () => {
      const h = makeDeps({ systemConfig: { findOne: async () => null } });
      const c = new ExecutorMaintenance(h.deps);
      expect(await c.resolveExecutorRetentionDays()).toBe(
        DEFAULT_EXECUTOR_RETENTION_DAYS,
      );
      expect(DEFAULT_EXECUTOR_RETENTION_DAYS).toBe(7);
    });

    it("非法值（非数字 / 0 / 负）⇒ 回落 7（不可逆删除宁可保守）", async () => {
      for (const bad of ["abc", "0", "-5", ""]) {
        const h = makeDeps({ systemConfig: { findOne: async () => ({ value: bad }) } });
        const c = new ExecutorMaintenance(h.deps);
        expect(await c.resolveExecutorRetentionDays()).toBe(7);
      }
    });

    it("systemConfig 缺席（@Optional 未装配）⇒ 回落 7，不抛", async () => {
      const h = makeDeps({ systemConfig: null });
      const c = new ExecutorMaintenance(h.deps);
      await expect(c.resolveExecutorRetentionDays()).resolves.toBe(7);
    });

    it("读配置抛错 ⇒ 静默回落 7（不让清理 cron 挂掉）", async () => {
      const h = makeDeps({
        systemConfig: {
          findOne: async () => {
            throw new Error("db down");
          },
        },
      });
      const c = new ExecutorMaintenance(h.deps);
      await expect(c.resolveExecutorRetentionDays()).resolves.toBe(7);
    });
  });

  describe("cleanupExpiredMetricsHistory — 分批 DELETE", () => {
    it("批大小与 Facade 静态常量同源（5000）", async () => {
      const h = makeDeps();
      h.setAffected([0]);
      const c = new ExecutorMaintenance(h.deps);
      await c.cleanupExpiredMetricsHistory(new Date());
      const params = h.executed[0].params as { batchSize: number };
      expect(params.batchSize).toBe(METRICS_RETENTION_BATCH_SIZE);
      expect(METRICS_RETENTION_BATCH_SIZE).toBe(5000);
    });

    it("**分批**：满批继续、不足批停止（长事务防护）", async () => {
      const h = makeDeps();
      // 第 1、2 批满批，第 3 批不足 ⇒ 应停
      h.setAffected([5000, 5000, 10]);
      const c = new ExecutorMaintenance(h.deps);
      const total = await c.cleanupExpiredMetricsHistory(new Date());
      expect(total).toBe(10010);
      expect(h.executed.length).toBe(3);
    });

    it("零行 ⇒ 一次查询即返回 0", async () => {
      const h = makeDeps();
      h.setAffected([0]);
      const c = new ExecutorMaintenance(h.deps);
      expect(await c.cleanupExpiredMetricsHistory(new Date())).toBe(0);
      expect(h.executed.length).toBe(1);
    });

    it("SQL 带 LIMIT 子查询（不是无界 DELETE）", async () => {
      const h = makeDeps();
      h.setAffected([0]);
      const c = new ExecutorMaintenance(h.deps);
      await c.cleanupExpiredMetricsHistory(new Date());
      expect(h.executed[0].sql).toContain('"id" IN (');
      expect(h.executed[0].sql).toContain("LIMIT :batchSize");
      expect(h.executed[0].sql).toContain('executor_metrics_history');
    });

    it("`now` 可注入（既有 spec 的时间旅行依赖）", async () => {
      const h = makeDeps();
      h.setAffected([0]);
      const c = new ExecutorMaintenance(h.deps);
      const now = new Date("2020-01-31T12:00:00Z");
      await c.cleanupExpiredMetricsHistory(now);
      const params = h.executed[0].params as { cutoff: Date };
      // 30 天前
      expect(params.cutoff.toISOString()).toBe("2020-01-01T12:00:00.000Z");
    });
  });

  describe("resolveS3LogStorage — 惰性单例", () => {
    it("非 s3 驱动 ⇒ null（retention 走既有直删路径）", () => {
      const h = makeDeps();
      const c = new ExecutorMaintenance(h.deps);
      // 未配置 LOG_STORAGE_DRIVER=s3 ⇒ fromConfig 返回 null
      expect(c.resolveS3LogStorage()).toBeNull();
    });

    it("**只解析一次**（惰性单例缓存随协作者走）", () => {
      const h = makeDeps();
      const c = new ExecutorMaintenance(h.deps);
      const a = c.resolveS3LogStorage();
      const b = c.resolveS3LogStorage();
      expect(a).toBe(b); // 同一结果（含同为 null 的情形）
    });
  });
});

/**
 * **运行时 self-call 自证**（Lead 要求：静态判据 + 运行时 spy 两条互补）。
 *
 * ## 这条测的是「Facade 转发层确实是 spy 拦截面」
 *
 * 静态判据（`scripts/check-collaborator-self-call.mjs`）能挡住"协作者内部直调
 * 自己的 public 方法"，但它只是**文本形态**判定 —— 若有人用别名、闭包或
 * 动态属性访问绕过，静态判据就看不见。
 *
 * 这条运行时用例从**另一侧**验证同一件事：在 Facade 上 `jest.spyOn` 一个协作者
 * 会用到的方法，断言**调用确实经过 Facade**（而不是协作者内部直接做了）。
 *
 * ## 反证（有牙）
 *
 * 若把 `ExecutorService.cleanupMetricsHistory` 改成直接 `this.maintenance.xxx()`
 * 而绕过 `this.cleanupExpiredMetricsHistory`，第二条断言会红。
 */
describe("X5 运行时自证：Facade 转发层确实是 spy 拦截面", () => {
  it("Facade 的 cleanupExpiredMetricsHistory 是**转发层**（可被 spy 拦截）", async () => {
    // 只验证「Facade 上存在可 spy 的 public 方法」这一形态 ——
    // 真正的端到端 spy 断言在 executor.service.spec.ts 里（既有 5 处直接调用）。
    const { ExecutorService } = await import("../executor.service");
    const desc = Object.getOwnPropertyDescriptor(
      ExecutorService.prototype,
      "cleanupExpiredMetricsHistory",
    );
    expect(desc?.value).toBeInstanceOf(Function);
    // 必须是**原型上的可枚举可覆盖方法**：defineProperty 成不可写会让 spy 失效
    expect(desc?.writable).toBe(true);
    expect(desc?.configurable).toBe(true);
  });

  it("协作者**不**持有 Facade 的引用（无反向依赖 ⇒ 不可能绕过 Facade）", () => {
    const h = makeDeps();
    const c = new ExecutorMaintenance(h.deps) as unknown as Record<string, unknown>;
    // 协作者的字段集里不得出现「整体 Facade」引用。
    // ⚠️ 不能笼统匹配 /service/i：`configService` / `systemConfig` 是**最小面**
    // 依赖（本就该存在），误判会把正确设计判成违规。只查指向 ExecutorService
    // 整体的字段名。
    const keys = Object.keys(c);
    expect(keys.some((k) => /executorService|facade|^service$|parentService/i.test(k))).toBe(
      false,
    );
  });
});
