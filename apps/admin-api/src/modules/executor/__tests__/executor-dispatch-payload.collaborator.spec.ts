import { Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecutorDispatchPayload,
  type ExecutorDispatchPayloadDeps,
} from "../executor-dispatch-payload.collaborator";
import type { Executor } from "../entities/executor.entity";
import type { Task } from "../../task/entities/task.entity";
import type { TaskExecution } from "../../task/entities/task-execution.entity";

/**
 * T1-B3a 的独立单测（**不走 DI 装配**，`new ExecutorDispatchPayload({...})` 直构）。
 *
 * ## 这些用例钉住三件"错了会静默"的事
 *
 * 1. **params 键名闸真的过滤**（SEC-02/P2-2）——闸失效 ⇒ 非法键变成
 *    `AUTOFLOW_A=B` 这种**永远不会被注入**的 env 名（执行器侧静默丢凭据）。
 * 2. **secrets 覆盖同名 params** —— 任务级凭据被逐触发参数顶掉 ⇒ 执行器用错凭据。
 * 3. **解释器过滤的"在线可下载"放行**（3.8+）与"离线层硬拦"（3.7）——
 *    判反了 ⇒ 3.7 任务被派到没缓存的机器（现场 250MB 下载失败），
 *    或 3.8+ 任务被误拦（明明能在线下载却直接失败）。
 *
 * ## 与集成测试的分工
 *
 * `executor.service.spec.ts` / `dispatch-params-keys.util.spec.ts` 覆盖的是
 * **装配后**的行为；本文件覆盖**协作者自身的判据**，不需要 21 个位置参数。
 */

/** 造一个最小 deps（可覆盖任意项）。 */
function makeDeps(over: Partial<ExecutorDispatchPayloadDeps> = {}): {
  deps: ExecutorDispatchPayloadDeps;
  decrypt: jest.Mock;
  warn: jest.Mock;
  buildTraceparent: jest.Mock;
} {
  const decrypt = jest.fn((secrets: unknown) =>
    secrets == null ? null : (secrets as Record<string, unknown>),
  );
  const warn = jest.fn();
  const buildTraceparent = jest.fn(() => "00-trace-span-01");
  const logger = {
    debug: jest.fn(),
    warn,
    error: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const deps: ExecutorDispatchPayloadDeps = {
    secretsCrypto: { decryptForDispatch: decrypt } as never,
    tracing: { buildTraceparentFromTraceId: buildTraceparent } as never,
    logger,
    ...over,
  };
  return { deps, decrypt, warn, buildTraceparent };
}

const mkTask = (over: Partial<Task> = {}): Task =>
  ({ id: "task-1", secrets: null, ...over }) as unknown as Task;

const mkExecution = (over: Partial<TaskExecution> = {}): TaskExecution =>
  ({ id: "exec-1", params: null, ...over }) as unknown as TaskExecution;

const mkExecutor = (over: Partial<Executor> = {}): Executor =>
  ({
    id: "e1",
    appName: "app-a",
    interpreters: [{ version: "3.12", path: "/opt/py312" }],
    ...over,
  }) as unknown as Executor;

describe("ExecutorDispatchPayload（T1-B3a 独立单测）", () => {
  describe("buildDispatchParams", () => {
    it("非法键 skip + warn（带 taskId/executionId），合法键照常合并", () => {
      const { deps, warn } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);

      const merged = collab.buildDispatchParams(
        mkTask(),
        mkExecution({ params: { LIMIT: "3", "A=B": 1, "MY-KEY": 2 } }),
      );

      expect(merged).toEqual({ LIMIT: "3" });
      const warnText = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnText).toContain("Dispatch params key gate (P2-2)");
      expect(warnText).toContain("[task task-1 execution exec-1]");
      expect(warnText).toContain('"A=B"');
      expect(warnText).toContain('"MY-KEY"');
    });

    it("全部键非法 → 空合并；全部合法 → 零 warn（好路径零噪音）", () => {
      const { deps, warn } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);

      expect(
        collab.buildDispatchParams(
          mkTask(),
          mkExecution({ params: { "X Y": 1 } }),
        ),
      ).toEqual({});
      expect(
        collab.buildDispatchParams(
          mkTask(),
          mkExecution({ params: { OK: 1 } }),
        ),
      ).toEqual({ OK: 1 });
      expect(
        warn.mock.calls.filter((c) =>
          String(c[0]).includes("Dispatch params key gate"),
        ),
      ).toHaveLength(1);
    });

    it("secrets 覆盖同名 params（任务级凭据不被逐触发参数顶掉）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);

      const merged = collab.buildDispatchParams(
        mkTask({ secrets: { API_KEY: "from-secret" } }),
        mkExecution({ params: { API_KEY: "from-param", OTHER: "keep" } }),
      );

      expect(merged).toEqual({ API_KEY: "from-secret", OTHER: "keep" });
    });

    it("execution.params 优先于 task.params（缺省回落 task 面）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);

      expect(
        collab.buildDispatchParams(
          mkTask({ params: { FROM_TASK: "t" } }),
          mkExecution({ params: { FROM_EXEC: "e" } }),
        ),
      ).toEqual({ FROM_EXEC: "e" });
      expect(
        collab.buildDispatchParams(
          mkTask({ params: { FROM_TASK: "t" } }),
          mkExecution({ params: null }),
        ),
      ).toEqual({ FROM_TASK: "t" });
    });

    it("解密失败 → 抛 TASK_SECRET_DECRYPT_FAILED（绝不静默裸跑）", () => {
      const { deps } = makeDeps({
        secretsCrypto: {
          decryptForDispatch: jest.fn(() => {
            throw new Error("key rotated away");
          }),
        } as never,
      });
      const collab = new ExecutorDispatchPayload(deps);

      expect(() =>
        collab.buildDispatchParams(
          mkTask({ secrets: { A: "b" } }),
          mkExecution(),
        ),
      ).toThrow(/key rotated away/);
    });
  });

  describe("buildDispatchSecrets", () => {
    it("解密产物原样返回（按原名注入的凭据面）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);

      expect(
        collab.buildDispatchSecrets(
          mkTask({ secrets: { FEISHU_APP_ID: "x" } }),
        ),
      ).toEqual({ FEISHU_APP_ID: "x" });
    });

    it("无 secrets → null（不是 undefined）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);

      expect(collab.buildDispatchSecrets(mkTask())).toBeNull();
    });

    it("解密失败 → 抛 TASK_SECRET_DECRYPT_FAILED", () => {
      const { deps } = makeDeps({
        secretsCrypto: {
          decryptForDispatch: jest.fn(() => {
            throw new Error("boom");
          }),
        } as never,
      });
      const collab = new ExecutorDispatchPayload(deps);

      expect(() => collab.buildDispatchSecrets(mkTask())).toThrow(/boom/);
    });
  });

  describe("applyInterpreterFilter", () => {
    it("未声明 runtimeVersion → 零过滤（存量任务逐字节不变）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);
      const all = [mkExecutor()];

      expect(collab.applyInterpreterFilter(all, null)).toEqual({
        kept: all,
        message: null,
      });
      expect(collab.applyInterpreterFilter(all, "")).toEqual({
        kept: all,
        message: null,
      });
    });

    it("有缓存者满足 → 硬过滤到满足者（不全员满足才放行）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);
      const hit = mkExecutor({
        id: "hit",
        interpreters: [{ version: "3.12" }],
      });
      const miss = mkExecutor({
        id: "miss",
        interpreters: [{ version: "3.7" }],
      });

      const out = collab.applyInterpreterFilter([hit, miss], "3.12");
      expect(out.message).toBeNull();
      expect(out.kept.map((e) => e.id)).toEqual(["hit"]);
    });

    it("3.8+ 在线可下载 → 缓存全缺也放行（不硬拦）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);
      const all = [mkExecutor({ interpreters: [{ version: "3.7" }] })];

      const out = collab.applyInterpreterFilter(all, "3.9");
      expect(out.message).toBeNull();
      expect(out.kept).toHaveLength(1);
    });

    it("3.7 离线层 → 缓存全缺时硬拦 + 消息含候选快照", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);
      const all = [mkExecutor({ interpreters: [{ version: "3.12" }] })];

      const out = collab.applyInterpreterFilter(all, "3.7");
      expect(out.kept).toHaveLength(0);
      expect(out.message).toContain("interpreter_unavailable");
      expect(out.message).toContain("3.7");
    });
  });

  describe("buildExecutionTraceparent", () => {
    it("tracing 缺席 → null（零注入）", () => {
      const { deps } = makeDeps({ tracing: null });
      const collab = new ExecutorDispatchPayload(deps);

      expect(
        collab.buildExecutionTraceparent({ traceId: "t-1" } as never),
      ).toBeNull();
    });

    it("tracing 在场 → 由 traceId 构造（追踪未开启时服务侧返 null）", () => {
      const { deps, buildTraceparent } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);

      expect(
        collab.buildExecutionTraceparent({ traceId: "t-1" } as never),
      ).toBe("00-trace-span-01");
      expect(buildTraceparent).toHaveBeenCalledWith("t-1");
    });
  });

  describe("self-call 禁令（Facade 转发层同时是 spy 拦截面）", () => {
    it("协作者的 public 方法之间不存在 self-call（否则 Facade 的 spy 静默失效）", () => {
      const { deps } = makeDeps();
      const collab = new ExecutorDispatchPayload(deps);
      const proto = Object.getPrototypeOf(collab) as Record<string, unknown>;
      const source = readFileSync(
        join(__dirname, "..", "executor-dispatch-payload.collaborator.ts"),
        "utf-8",
      );

      // 判据与 `scripts/check-collaborator-self-call.mjs` 一致：**只判 public 方法**
      // （私有计算不参与外部 spy，私有 self-call 不算违规）。
      const publicMethods = Object.getOwnPropertyNames(proto).filter(
        (n) =>
          n !== "constructor" &&
          typeof proto[n] === "function" &&
          !new RegExp(`^\\s*private\\s+${n}\\s*[(<]`, `m`).test(source),
      );
      expect(publicMethods.length).toBeGreaterThan(0);

      // 源码级判定：类体内不得出现 `this.<publicMethod>(` 形态的调用。
      // （守卫脚本 scripts/check-collaborator-self-call.mjs 做同一判据，
      //   但它扫全仓；本用例让本协作者的这条不变量在单测层也可回归。）
      for (const name of publicMethods) {
        expect(source).not.toMatch(new RegExp(`this\\.${name}\\s*\\(`));
      }
    });
  });
});
