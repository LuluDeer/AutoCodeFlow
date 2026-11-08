import {
  applyAffinityFilters,
  applyBasicFilters,
  filterExecutorCandidates,
  hasAllRequiredTags,
  hasAnyAffinityTag,
  hasNoAntiAffinityTag,
  satisfiesRuntime,
  type ExecutorFilterCriteria,
} from "../executor-filters.util";

/**
 * 派发候选过滤链（**单一事实源**）的表驱动测试。
 *
 * ## 这个文件要证明什么
 *
 * 本仓有**三条**「从在线执行器里挑候选」的路径（`dispatch` / `dispatchBroadcast` /
 * `selectLeastLoaded`），此前**各自手写**一份过滤链，且维度不一致 ——
 * `selectLeastLoaded` 缺 affinity / anti-affinity ⇒ **同一语义的两种实现，
 * 其中一份是错的**（部署选机不执行亲和约束，而单播派发执行）。
 *
 * R1 阶段 1 把它们收拢到 `executor-filters.util.ts` 的**一个**实现。本 spec 钉住
 * 四件事：
 *
 *   ① **各维度的既有语义逐字不变**（空标签执行器在必需标签下**不**合格、
 *      在亲和下**不**合格、在反亲和下**合格**；空 capabilities = 万能）。
 *   ② **三条路径的维度差异是显式的**：`dispatch`/`broadcast` 恒实施亲和过滤，
 *      `selection` 由开关决定（默认关闭 = 保持现状，**行为变更必须可回退**）。
 *   ③ **模式无关时结果一致**：开关开启后，`selection` 与 `dispatch` 在同一
 *      候选集 + 同一条件下必须给出**完全相同**的候选集（这才是"收拢"的定义）。
 *   ④ **顺序与短路**：过滤链是纯函数，重复调用幂等。
 */

type Exec = {
  groupName: string | null;
  tags: string[] | null;
  capabilities: string[] | null;
};

const ex = (
  groupName: string | null,
  tags: string[] | null,
  capabilities: string[] | null = null,
): Exec => ({ groupName, tags, capabilities });

describe("executor-filters.util（派发过滤链单一事实源）", () => {
  // ---------------------------------------------------------------------------
  // ① 各维度的既有语义
  // ---------------------------------------------------------------------------
  describe("维度语义（与派发路径既有行为逐字一致）", () => {
    it("必需标签 = AND 子集：执行器须持有全部", () => {
      expect(hasAllRequiredTags(ex(null, ["a", "b"]), ["a"])).toBe(true);
      expect(hasAllRequiredTags(ex(null, ["a", "b"]), ["a", "b"])).toBe(true);
      expect(hasAllRequiredTags(ex(null, ["a"]), ["a", "b"])).toBe(false);
    });

    it("空必需集 = 全部合格（不构成约束）", () => {
      expect(hasAllRequiredTags(ex(null, null), null)).toBe(true);
      expect(hasAllRequiredTags(ex(null, null), [])).toBe(true);
    });

    it("空标签的执行器不满足任何非空必需集（既有语义）", () => {
      // ⚠️ 这一条容易被"优化"掉：`!e.tags ⇒ false` 是派发路径的既有语义。
      expect(hasAllRequiredTags(ex(null, null), ["a"])).toBe(false);
    });

    it("亲和标签 = OR 语义：持有任一即合格", () => {
      expect(hasAnyAffinityTag(ex(null, ["a", "b"]), ["b", "z"])).toBe(true);
      expect(hasAnyAffinityTag(ex(null, ["a"]), ["b", "z"])).toBe(false);
    });

    it("空亲和集 = 全部合格；空标签执行器不满足非空亲和集（既有语义）", () => {
      expect(hasAnyAffinityTag(ex(null, null), [])).toBe(true);
      expect(hasAnyAffinityTag(ex(null, null), ["a"])).toBe(false);
    });

    it("反亲和 = 排除语义：持有任一即淘汰", () => {
      expect(hasNoAntiAffinityTag(ex(null, ["a"]), ["a"])).toBe(false);
      expect(hasNoAntiAffinityTag(ex(null, ["b"]), ["a"])).toBe(true);
    });

    it("空反亲和集 = 全部合格；空标签执行器通过反亲和（无从违反）", () => {
      expect(hasNoAntiAffinityTag(ex(null, null), [])).toBe(true);
      expect(hasNoAntiAffinityTag(ex(null, null), ["a"])).toBe(true);
    });

    it("运行时：空 capabilities = 万能（放行）", () => {
      expect(satisfiesRuntime(ex(null, null, null), "node")).toBe(true);
      expect(satisfiesRuntime(ex(null, null, []), "node")).toBe(true);
      expect(satisfiesRuntime(ex(null, null, ["node"]), "node")).toBe(true);
      expect(satisfiesRuntime(ex(null, null, ["python"]), "node")).toBe(false);
    });

    it("运行时：无约束时全部合格", () => {
      expect(satisfiesRuntime(ex(null, null, ["python"]), null)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ② 三条路径的亲和差异是显式的（行为变更可回退）
  // ---------------------------------------------------------------------------
  // D-2（2026-11-03）：此前标题写「selection 由**开关**决定」——那个开关
  // （env `EXECUTOR_SELECTION_AFFINITY_ENABLED`）已被独立验收判定为**空转**并删除
  // （选机入参不含 affinity 字段 ⇒ hasAffinityDim 恒 false）。
  // 现在 selection 的亲和实施只由**纯函数形参** `affinityEnabled` 决定（默认 false），
  // 属函数契约的一部分，不是全局配置。下列断言逐条仍成立，只是措辞已订正。
  describe("模式差异（dispatch/broadcast 恒实施；selection 由纯函数形参决定）", () => {
    const candidates = [ex(null, ["prod"]), ex(null, ["dev"])];

    it("dispatch 恒实施亲和过滤（与现状逐字一致，与开关无关）", () => {
      const criteria: ExecutorFilterCriteria = { affinityTags: ["prod"] };
      for (const enabled of [true, false]) {
        const out = applyAffinityFilters(candidates, criteria, "dispatch", {
          affinityEnabled: enabled,
        });
        expect(out).toEqual([ex(null, ["prod"])]);
      }
    });

    it("broadcast 恒实施亲和过滤（与现状逐字一致）", () => {
      const criteria: ExecutorFilterCriteria = { affinityTags: ["prod"] };
      const out = applyAffinityFilters(candidates, criteria, "broadcast");
      expect(out).toEqual([ex(null, ["prod"])]);
    });

    it("selection 默认**不**实施亲和过滤（保持现状，行为变更需显式开启）", () => {
      const criteria: ExecutorFilterCriteria = { affinityTags: ["prod"] };
      const out = applyAffinityFilters(candidates, criteria, "selection");
      expect(out).toEqual(candidates);
    });

    it("selection 在开关开启时实施亲和过滤", () => {
      const criteria: ExecutorFilterCriteria = { affinityTags: ["prod"] };
      const out = applyAffinityFilters(candidates, criteria, "selection", {
        affinityEnabled: true,
      });
      expect(out).toEqual([ex(null, ["prod"])]);
    });

    it("无亲和维度时任何模式都直接返回原集（不做无谓遍历）", () => {
      const out = applyAffinityFilters(candidates, {}, "selection", {
        affinityEnabled: true,
      });
      expect(out).toEqual(candidates);
    });
  });

  // ---------------------------------------------------------------------------
  // ③ 模式无关时结果一致 —— 这才是"收拢"的定义
  // ---------------------------------------------------------------------------
  describe("收拢语义：开关开启后 selection 与 dispatch 结果一致", () => {
    const candidates = [
      ex("g1", ["prod", "fast"], ["node"]),
      ex("g1", ["prod"], ["node"]),
      ex("g2", ["dev"], ["python"]),
      ex("g1", null, ["node"]),
    ];

    const CASES: Array<[string, ExecutorFilterCriteria]> = [
      ["按 group", { group: "g1" }],
      ["按必需标签 AND", { tags: ["prod"] }],
      ["按亲和 OR", { affinityTags: ["fast"] }],
      ["按反亲和排除", { antiAffinityTags: ["dev"] }],
      ["按运行时", { runtime: "node" }],
      [
        "group + 标签 + 亲和 + 反亲和 + 运行时 全维度",
        {
          group: "g1",
          tags: ["prod"],
          affinityTags: ["fast", "prod"],
          antiAffinityTags: ["dev"],
          runtime: "node",
        },
      ],
    ];

    it.each(CASES)("%s：selection(开关开) === dispatch", (_name, criteria) => {
      const asSelection = filterExecutorCandidates(
        candidates,
        criteria,
        "selection",
        { affinityEnabled: true },
      );
      const asDispatch = filterExecutorCandidates(
        candidates,
        criteria,
        "dispatch",
      );
      expect(asSelection).toEqual(asDispatch);
    });

    it("全维度用例的预期结果被显式钉住（防止两端一起漂移）", () => {
      const criteria: ExecutorFilterCriteria = {
        group: "g1",
        tags: ["prod"],
        affinityTags: ["fast", "prod"],
        antiAffinityTags: ["dev"],
        runtime: "node",
      };
      // g1/prod/fast/node → 命中；g1/prod（无 fast，但亲和是 OR，命中 prod）→ 也命中
      // g2/dev → group 不符 + 反亲和命中 → 淘汰；g1/null tags → 必需标签不满足 → 淘汰
      expect(
        filterExecutorCandidates(candidates, criteria, "dispatch"),
      ).toEqual([
        ex("g1", ["prod", "fast"], ["node"]),
        ex("g1", ["prod"], ["node"]),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // ④ 纯函数性质
  // ---------------------------------------------------------------------------
  describe("纯函数性质", () => {
    it("不修改入参（不原地 mutate 候选集）", () => {
      const candidates = [ex("g1", ["prod"]), ex("g2", ["dev"])];
      const snapshot = JSON.parse(JSON.stringify(candidates));
      filterExecutorCandidates(candidates, { group: "g1" }, "dispatch");
      expect(candidates).toEqual(snapshot);
    });

    it("重复调用幂等", () => {
      const candidates = [ex("g1", ["prod"]), ex("g2", ["dev"])];
      const criteria: ExecutorFilterCriteria = {
        group: "g1",
        affinityTags: ["prod"],
      };
      const once = filterExecutorCandidates(candidates, criteria, "dispatch");
      const twice = filterExecutorCandidates(once, criteria, "dispatch");
      expect(twice).toEqual(once);
    });

    it("无约束时返回全部候选（顺序不变）", () => {
      const candidates = [ex("g1", ["prod"]), ex("g2", ["dev"])];
      expect(filterExecutorCandidates(candidates, {}, "dispatch")).toEqual(
        candidates,
      );
    });

    it("applyBasicFilters 与 applyAffinityFilters 的组合 === filterExecutorCandidates", () => {
      const candidates = [ex("g1", ["prod"]), ex("g2", ["dev"])];
      const criteria: ExecutorFilterCriteria = {
        group: "g1",
        affinityTags: ["prod"],
      };
      const combined = applyAffinityFilters(
        applyBasicFilters(candidates, criteria),
        criteria,
        "dispatch",
      );
      expect(combined).toEqual(
        filterExecutorCandidates(candidates, criteria, "dispatch"),
      );
    });
  });
});
