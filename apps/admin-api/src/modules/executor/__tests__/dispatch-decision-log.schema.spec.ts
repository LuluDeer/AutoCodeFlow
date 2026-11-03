import {
  buildDispatchDecisionLog,
  roundScore,
  type DispatchDecisionLog,
} from "../dispatch-decision-log.schema";

/**
 * 调度决策日志 schema 的规格测试。
 *
 * ## 这组用例在守什么
 *
 * 决策日志是「**为什么派到这台、为什么没派到那台**」的唯一留痕。此前本仓有
 * **两个**出口（`dispatch` / `selectLeastLoaded`），各手写一份 JSON：
 *
 *   · **字段集不同**（选机路径缺 `task` / `executionId`）⇒ 日志消费方要写
 *     两套解析；
 *   · **取整口径不同**（一个从快照取、可能为 `null`；另一个用 `toFixed(3)`）
 *     ⇒ 同一语义字段的值格式不一致。
 *
 * 收拢到一份 schema 后，本文件守住三件事：
 *   ① **字段集完整**：缺失显式 `null`（而非被 `JSON.stringify` 整个省略——
 *      「没这个字段」与「这个字段无值」在日志里必须可区分）；
 *   ② **取整口径唯一**；
 *   ③ **校验失败抛错**（畸形 JSON 进日志系统会污染排障面板）。
 */
describe("dispatch-decision-log.schema（决策日志单一事实源）", () => {
  const baseInput = {
    event: "dispatch.decision" as const,
    task: "t1",
    executionId: "exec-1",
    poolSize: 10,
    afterFilters: 4,
    scoredCount: 4,
    selected: {
      address: "10.0.0.1:9000",
      score: 0.123456,
      runningTaskCount: 1,
      maxConcurrentTasks: 5,
    },
  };

  describe("roundScore（唯一取整口径）", () => {
    it("保留 3 位小数", () => {
      expect(roundScore(0.123456)).toBe(0.123);
      expect(roundScore(1)).toBe(1);
      expect(roundScore(0.9999)).toBe(1);
    });

    it("null / undefined / 非有限数 ⇒ null（不留 NaN/Infinity 进日志）", () => {
      expect(roundScore(null)).toBeNull();
      expect(roundScore(undefined)).toBeNull();
      expect(roundScore(Number.NaN)).toBeNull();
      expect(roundScore(Number.POSITIVE_INFINITY)).toBeNull();
    });
  });

  describe("buildDispatchDecisionLog（字段集完整）", () => {
    it("输出完整字段集（缺失的显式 null，不被省略）", () => {
      const log = buildDispatchDecisionLog(baseInput);
      // 关键：这三个「未适用」的面必须**显式为 null**，而不是字段消失——
      // `JSON.stringify` 会把 undefined 的字段整个省略，于是「无值」与
      // 「不存在」在日志里不可区分。
      expect(log.deploymentAffinity).toBeNull();
      expect(log.deploymentConstraint).toBeNull();
      expect(log.interpreterCacheAffinity).toBeNull();
      expect(Object.keys(log)).toContain("deploymentAffinity");
      expect(Object.keys(log)).toContain("deploymentConstraint");
      expect(Object.keys(log)).toContain("interpreterCacheAffinity");

      // 序列化后字段仍在（这是「显式 null」的真正判据）
      const parsed = JSON.parse(JSON.stringify(log));
      expect(parsed).toHaveProperty("deploymentAffinity", null);
      expect(parsed).toHaveProperty("deploymentConstraint", null);
      expect(parsed).toHaveProperty("interpreterCacheAffinity", null);
    });

    it("**两个出口的字段集相同**（选机路径补上 task/executionId 的 null）", () => {
      // 这条断言是本轮收拢的**核心判据**：此前两处字段集不同，日志消费方要
      // 写两套解析。选机路径没有任务上下文 ⇒ 显式 null，而非缺字段。
      const fromDispatch = buildDispatchDecisionLog(baseInput);
      const fromSelection = buildDispatchDecisionLog({
        ...baseInput,
        event: "selectLeastLoaded.decision",
        task: null,
        executionId: null,
      });

      expect(Object.keys(fromDispatch).sort()).toEqual(
        Object.keys(fromSelection).sort(),
      );
      expect(fromSelection.task).toBeNull();
      expect(fromSelection.executionId).toBeNull();
      expect(fromSelection.event).toBe("selectLeastLoaded.decision");
    });

    it("评分统一取整到 3 位（两条出口口径一致）", () => {
      const log = buildDispatchDecisionLog({
        ...baseInput,
        selected: { ...baseInput.selected, score: 1.23456789 },
      });
      expect(log.selected.score).toBe(1.235);
    });

    it("topRunners 逐条取整", () => {
      const log = buildDispatchDecisionLog({
        ...baseInput,
        topRunners: [
          {
            address: "a",
            score: 0.111111,
            runningTaskCount: 0,
            maxConcurrentTasks: null,
          },
          {
            address: "b",
            score: 0.222222,
            runningTaskCount: 2,
            maxConcurrentTasks: 10,
          },
        ],
      });
      expect(log.topRunners.map((c) => c.score)).toEqual([0.111, 0.222]);
    });

    it("maxConcurrentTasks 为 null 时保留 null（= 无上限，不是 0）", () => {
      const log = buildDispatchDecisionLog({
        ...baseInput,
        selected: { ...baseInput.selected, maxConcurrentTasks: null },
      });
      expect(log.selected.maxConcurrentTasks).toBeNull();
    });

    it("部署偏好 / 约束 / 解释器面有值时原样透出", () => {
      const log = buildDispatchDecisionLog({
        ...baseInput,
        deploymentAffinity: {
          preferred: 2,
          matchedByExecutorId: 1,
          matchedByAddressOnly: 1,
          runningDeployments: 3,
        },
        deploymentConstraint: {
          mode: "strict",
          source: "task",
          setSize: 5,
          onlineInSet: 2,
        },
        interpreterCacheAffinity: { preferred: 1, unreported: 2 },
      });
      expect(log.deploymentAffinity?.preferred).toBe(2);
      expect(log.deploymentConstraint?.mode).toBe("strict");
      expect(log.interpreterCacheAffinity?.unreported).toBe(2);
    });
  });

  describe("校验失败抛错（畸形日志不得进日志系统）", () => {
    it("poolSize 非数字 ⇒ 抛错", () => {
      expect(() =>
        buildDispatchDecisionLog({
          ...baseInput,
          poolSize: "10" as unknown as number,
        }),
      ).toThrow(TypeError);
    });

    it("selected 缺失 ⇒ 抛错", () => {
      expect(() =>
        buildDispatchDecisionLog({
          ...baseInput,
          selected: undefined as unknown as DispatchDecisionLog["selected"],
        }),
      ).toThrow(TypeError);
    });

    it("selected.address 非字符串 ⇒ 抛错", () => {
      expect(() =>
        buildDispatchDecisionLog({
          ...baseInput,
          selected: {
            address: 123 as unknown as string,
            score: 1,
            runningTaskCount: 0,
            maxConcurrentTasks: null,
          },
        }),
      ).toThrow(TypeError);
    });

    // D-8（R1 复核 2026-11-03）：`score` 是必填数值字段（类型声明 `score: number`），
    // 原实现 `roundScore(...) ?? 0` 把 undefined/NaN/null **静默压成 0 且不记 problem**
    // ⇒ 契约与实现两头不靠。`score=0` 在决策日志里的语义是「最空闲/最优」，
    // 恰恰是最有误导性的值，且无任何缺字段痕迹。以下三条钉住它必须抛错。
    it("selected.score 缺失 ⇒ 抛错（不得静默压成 0）", () => {
      expect(() =>
        buildDispatchDecisionLog({
          ...baseInput,
          selected: {
            ...baseInput.selected,
            score: undefined as unknown as number,
          },
        }),
      ).toThrow(TypeError);
    });

    it("selected.score 为 NaN ⇒ 抛错（不得静默压成 0）", () => {
      expect(() =>
        buildDispatchDecisionLog({
          ...baseInput,
          selected: { ...baseInput.selected, score: Number.NaN },
        }),
      ).toThrow(TypeError);
    });

    it("selected.score 为 NaN ⇒ 错误信息指出 selected.score（可定位）", () => {
      let message = "";
      try {
        buildDispatchDecisionLog({
          ...baseInput,
          selected: { ...baseInput.selected, score: Number.NaN },
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("selected.score");
    });

    it("错误信息指出具体字段（可定位）", () => {
      let message = "";
      try {
        buildDispatchDecisionLog({
          ...baseInput,
          poolSize: Number.NaN,
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("poolSize");
    });
  });
});
