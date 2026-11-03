import { Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecutorHeartbeatRestart,
  type ExecutorHeartbeatRestartDeps,
} from "../executor-heartbeat-restart.collaborator";
import type { Executor } from "../entities/executor.entity";
import type { TaskExecution } from "../../task/entities/task-execution.entity";

/**
 * T1-B3c 的独立单测（**不走 DI 装配**，`new ExecutorHeartbeatRestart({...})` 直构）。
 *
 * ## 这些用例钉住四件"错了会静默"的事
 *
 * 1. **startupId-only 重启不得静默退化** —— `resolveRestartBaseline` 必须取
 *    **服务端 now**（不是 DB 旧基线）。取 DB 旧基线 = "零恢复"：旧行终态化后
 *    下一条都不终态化，**恢复路径空转**（旧进程死掉的行只能靠 stale sweep 回收）。
 * 2. **恢复窗口内新派发的行不得被误杀** —— `shouldFailAfterRestart` 是
 *    `startTime < 基线`（严格早于）。写成 `<=` 会误杀恢复后新派发的行。
 * 3. **时间解析非法 → null**（不是 Invalid Date）—— Invalid Date 会让
 *    比较运算恒 false ⇒ 重启永远判不出来。
 * 4. **槽位冲销走 `manager` 而不是 `repo`** —— 既有 spec 钉住「冲销不触碰
 *    `repo.createQueryBuilder`」（索引型断言的依赖）。
 */

/** 造一个最小 deps（可覆盖任意项）。 */
function makeDeps(over: Partial<ExecutorHeartbeatRestartDeps> = {}) {
  const warn = jest.fn();
  const logger = {
    debug: jest.fn(),
    warn,
    error: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const manager = {
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    })),
  };

  const deps: ExecutorHeartbeatRestartDeps = {
    manager: manager as never,
    logger,
    ...over,
  };
  return { deps, warn, manager };
}

const mkExecutor = (over: Partial<Executor> = {}): Executor =>
  ({
    id: "e1",
    executorStartupId: "startup-old",
    executorStartedAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  }) as unknown as Executor;

const mkExecution = (over: Partial<TaskExecution> = {}): TaskExecution =>
  ({ id: "exec-1", ...over }) as unknown as TaskExecution;

describe("ExecutorHeartbeatRestart（T1-B3c 独立单测）", () => {
  describe("parseExecutorStartedAt", () => {
    it("合法时间串 → Date；Date 原样返回", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(
        collab.parseExecutorStartedAt("2026-10-02T03:04:05Z")?.toISOString(),
      ).toBe("2026-10-02T03:04:05.000Z");
      const d = new Date("2026-10-02T03:04:05Z");
      expect(collab.parseExecutorStartedAt(d)).toBe(d);
    });

    it("空/非法 → null（**不是** Invalid Date —— 那会让比较恒 false）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(collab.parseExecutorStartedAt(null)).toBeNull();
      expect(collab.parseExecutorStartedAt(undefined)).toBeNull();
      expect(collab.parseExecutorStartedAt("")).toBeNull();
      expect(collab.parseExecutorStartedAt("not-a-date")).toBeNull();
    });
  });

  describe("hasExecutorRestarted", () => {
    it("startupId 变了 → 重启", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(
        collab.hasExecutorRestarted(mkExecutor(), null, "startup-new"),
      ).toBe(true);
    });

    it("startupId 相同 → 不是重启（除非时间判据命中）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(
        collab.hasExecutorRestarted(mkExecutor(), null, "startup-old"),
      ).toBe(false);
    });

    it("上报的 restartedAt 晚于 DB 侧 → 重启", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(
        collab.hasExecutorRestarted(
          mkExecutor(),
          new Date("2026-10-05T00:00:00Z"),
          "startup-old",
        ),
      ).toBe(true);
    });

    it("上报的 restartedAt 早于/等于 DB 侧 → 不是重启", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(
        collab.hasExecutorRestarted(
          mkExecutor(),
          new Date("2026-09-01T00:00:00Z"),
          "startup-old",
        ),
      ).toBe(false);
      expect(
        collab.hasExecutorRestarted(
          mkExecutor(),
          new Date("2026-10-01T00:00:00Z"),
          "startup-old",
        ),
      ).toBe(false);
    });

    it("任一侧缺失 → 不判为重启（不误杀）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      // DB 侧没有 startupId ⇒ 无从比对。
      expect(
        collab.hasExecutorRestarted(
          mkExecutor({ executorStartupId: null }),
          null,
          "startup-new",
        ),
      ).toBe(false);
      // DB 侧没有 startedAt ⇒ 无从比对。
      expect(
        collab.hasExecutorRestarted(
          mkExecutor({ executorStartedAt: null }),
          new Date("2026-10-05T00:00:00Z"),
          null,
        ),
      ).toBe(false);
    });
  });

  describe("resolveRestartBaseline", () => {
    it("有 incomingStartedAt → 直接取它（不 warn）", () => {
      const { deps, warn } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);
      const at = new Date("2026-10-05T00:00:00Z");

      expect(
        collab.resolveRestartBaseline("addr", at, "startup-new", null),
      ).toBe(at);
      expect(warn).not.toHaveBeenCalled();
    });

    it("startupId-only 重启 → 取**服务端 now**（不是 DB 旧基线）且 warn 留痕", () => {
      const { deps, warn } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);
      const dbBaseline = new Date("2026-10-01T00:00:00Z");

      const before = Date.now();
      const baseline = collab.resolveRestartBaseline(
        "addr",
        null,
        "startup-new",
        dbBaseline,
      );
      const after = Date.now();

      // 基线是服务端此刻（DB 旧基线仅作 warn 展示、不参与判定）。
      expect(baseline.getTime()).toBeGreaterThanOrEqual(before);
      expect(baseline.getTime()).toBeLessThanOrEqual(after);
      expect(baseline.getTime()).not.toBe(dbBaseline.getTime());

      const warnText = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnText).toContain("startup-new");
      expect(warnText).toContain("server-side now=");
      expect(warnText).toContain("DB executorStartedAt=");
      expect(warnText).toContain("2026-10-01T00:00:00.000Z");
    });
  });

  describe("shouldFailAfterRestart", () => {
    it("无基线 → 全部终态化（存量语义）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(
        collab.shouldFailAfterRestart(
          mkExecution({ startTime: new Date() }),
          null,
        ),
      ).toBe(true);
    });

    it("无 startTime → 终态化（不残留幽灵 RUNNING 行）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      expect(
        collab.shouldFailAfterRestart(
          mkExecution({ startTime: null }),
          new Date("2026-10-05T00:00:00Z"),
        ),
      ).toBe(true);
    });

    it("startTime 早于基线 → 终态化；晚于/等于基线 → 存活", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);
      const baseline = new Date("2026-10-05T00:00:00Z");

      expect(
        collab.shouldFailAfterRestart(
          mkExecution({ startTime: new Date("2026-10-01T00:00:00Z") }),
          baseline,
        ),
      ).toBe(true);
      // 恢复窗口内新派发（startTime > 基线）⇒ 存活（**不得**误杀）。
      expect(
        collab.shouldFailAfterRestart(
          mkExecution({ startTime: new Date("2026-10-06T00:00:00Z") }),
          baseline,
        ),
      ).toBe(false);
      // 严格早于：等于基线 ⇒ 存活。
      expect(
        collab.shouldFailAfterRestart(
          mkExecution({ startTime: baseline }),
          baseline,
        ),
      ).toBe(false);
    });
  });

  describe("releaseExecutorSlot", () => {
    it("地址为空 → 早退不触碰 manager（无谓写）", async () => {
      const { deps, manager } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      await collab.releaseExecutorSlot(null);
      await collab.releaseExecutorSlot(undefined);

      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("有地址 → 经共享 util 的 manager 路径冲销（不触碰 repo）", async () => {
      const { deps, manager } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);

      await collab.releaseExecutorSlot("10.0.0.5:3002");

      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
      const qb = manager.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith(
        `"id" = (SELECT "id" FROM "executors" WHERE "address" = :addr)`,
        { addr: "10.0.0.5:3002" },
      );
    });
  });

  describe("self-call 禁令（Facade 转发层同时是 spy 拦截面）", () => {
    it("协作者的 public 方法之间不存在 self-call", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorHeartbeatRestart(deps);
      const proto = Object.getPrototypeOf(collab) as Record<string, unknown>;
      const source = readFileSync(
        join(__dirname, "..", "executor-heartbeat-restart.collaborator.ts"),
        "utf-8",
      );

      // 判据与 `scripts/check-collaborator-self-call.mjs` 一致：**只判 public 方法**
      // （私有计算不参与外部 spy，私有 self-call 不算违规）。
      // 运行时拿不到 `private` 修饰符 ⇒ 从源码声明里读出来排除。
      const publicMethods = Object.getOwnPropertyNames(proto).filter(
        (n) =>
          n !== "constructor" &&
          typeof proto[n] === "function" &&
          !new RegExp(`^\\s*private\\s+${n}\\s*[(<]`, `m`).test(source),
      );
      expect(publicMethods.length).toBeGreaterThan(0);
      // 私有实现确实存在（证明上面的排除不是空转）。
      expect(
        Object.getOwnPropertyNames(proto).filter(
          (n) =>
            n !== "constructor" &&
            typeof proto[n] === "function" &&
            new RegExp(`^\\s*private\\s+${n}\\s*[(<]`, `m`).test(source),
        ),
      ).toContain("parseDate");

      for (const name of publicMethods) {
        expect(source).not.toMatch(new RegExp(`this\\.${name}\\s*\\(`));
      }
    });
  });
});
