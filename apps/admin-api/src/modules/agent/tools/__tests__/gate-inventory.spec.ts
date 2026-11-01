import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentToolSpec } from "../tool-registry";
import { ALL_AGENT_TOOL_SPECS } from "../tool-registry";
import {
  GATE_INVENTORY,
  HIGH_RISK_NAME_PATTERN,
  MIN_REASON_LENGTH,
  auditGateInventory,
  formatGateInventoryAudit,
  isGateInventoryClean,
  type GateInventoryAudit,
  type GateInventoryEntry,
} from "../gate-inventory";

/**
 * 门判据清单的**双向守卫**（S1-C5）。
 *
 * 背景：审批/硬禁用是逐工具手标的，默认策略 `writeRequiresApproval=false`
 * （`boundary/agent-boundary.service.ts:68`）——新增一个 `tier: "write"` 却不写
 * `approvalRequired` 的工具，天生无门且**没有任何信号**。于是「文档说某工具要审批、
 * 代码里没有」可以长期静默存在（`deploy_application` 就是这么漂移的）。
 *
 * 本 spec 钉四件事：
 *   ① **双向**：注册表里「write 且无审批」的集合 == `GATE_INVENTORY` 的名字集合。
 *      多一个（漏登记）红，少一个（清单陈旧）红，名字不存在（幽灵名）红；
 *   ② 每条登记**逐条有理由**：非空、非占位，`known-gap` 必须带 `ref`；
 *   ③ 高危动词命名（`delete_` / `kill_` / `stop_` / `deploy_` / `rollback_` /
 *      `publish_` / `offline`）的工具不得被标成 `read`；
 *   ④ `kind: "unbound"` 的理由**不会静默过期**——它在 binder 里必须真的没有执行体。
 *
 * 后半段是**红队**：用合成夹具把守卫自己钉住（否则「今天恰好一致」也能让 spec 绿，
 * 而守卫本身早就不工作了）。
 */

/** 构造一个最小可用的工具 spec（只为跑审计，不参与真实注册）。 */
function spec(
  name: string,
  overrides: Partial<AgentToolSpec> = {},
): AgentToolSpec {
  return {
    name,
    description: `${name} fixture`,
    parameters: { type: "object", properties: {} },
    tier: "write",
    resourceKind: "none",
    effectBound: "call",
    ...overrides,
  } as AgentToolSpec;
}

/** 审计结果全空才算绿；不绿时抛出人话修复指引（而不是一串数组 diff）。 */
function assertClean(audit: GateInventoryAudit): void {
  if (isGateInventoryClean(audit)) return;
  throw new Error(
    `\n门判据清单守卫失败：\n\n${formatGateInventoryAudit(audit)}\n`,
  );
}

const CLEAN: GateInventoryAudit = {
  unregistered: [],
  noLongerExempt: [],
  missingFromRegistry: [],
  badReasons: [],
  duplicateNames: [],
  unexplainedHighRisk: [],
};

describe("门判据清单（gate inventory）— 真实注册表", () => {
  it("① 双向一致：注册表「write 且无审批」== 清单名字集合", () => {
    assertClean(auditGateInventory(ALL_AGENT_TOOL_SPECS));
  });

  it("② 清单非空且每条理由逐条成立（空/占位/known-gap 缺 ref 都红）", () => {
    // 空清单会让 ① 变红，但那样失败信息是「14 个漏登记」而不是「清单被清空了」，
    // 所以这里单独钉一次，让「把清单删光以求解红」这条歪路走不通。
    expect(GATE_INVENTORY.length).toBeGreaterThan(0);
    const audit = auditGateInventory(ALL_AGENT_TOOL_SPECS);
    expect(audit.badReasons).toEqual([]);
  });

  it("③ 高危动词命名的工具不得被标成 read", () => {
    const audit = auditGateInventory(ALL_AGENT_TOOL_SPECS);
    expect(audit.unexplainedHighRisk).toEqual([]);
  });

  it("④ kind=unbound 的条目在 binder 里确实没有执行体（理由不会静默过期）", () => {
    // 「执行体未绑定所以不可执行」是最容易过期的一条理由：谁把 register(...) 补上，
    // 这条豁免就变成了假话，而审计函数看不出来（它只读注册表）。这里直接读 binder
    // 源码钉住——绑定执行体的人必须回来重新裁定「它现在要不要门」。
    const binderSrc = readFileSync(
      join(__dirname, "..", "tool-binder.service.ts"),
      "utf8",
    );
    const unbound = GATE_INVENTORY.filter((e) => e.kind === "unbound").map(
      (e) => e.name,
    );
    const nowBound = unbound.filter((n) =>
      binderSrc.includes(`register("${n}"`),
    );
    expect({ unboundButBound: nowBound }).toEqual({ unboundButBound: [] });
  });

  it("④b 2026-11-02 出清：update_application / cancel_deployment 已绑定 + 需审批 + 不在清单", () => {
    // 反向守卫：④ 只管「登记成 unbound 的不能已经绑上」，管不到「绑上了却没补门」。
    // 这两条此前正是「注册表声明了 + binder 没 register」⇒ 模型调用永远得到
    // 「尚未实现」。现在它们必须同时满足三件事，缺一条就红：
    //   ① binder 里真的有 register(...)（不再「尚未实现」）；
    //   ② 注册表声明 approvalRequired: true（否则就是**无门**的写工具）；
    //   ③ 不在 GATE_INVENTORY 里（有审批的写工具不属于「无门写工具」清单）。
    const binderSrc = readFileSync(
      join(__dirname, "..", "tool-binder.service.ts"),
      "utf8",
    );
    for (const name of ["update_application", "cancel_deployment"]) {
      const spec = ALL_AGENT_TOOL_SPECS.find((s) => s.name === name);
      expect({ name, bound: binderSrc.includes(`register("${name}"`) }).toEqual(
        {
          name,
          bound: true,
        },
      );
      expect({ name, approvalRequired: spec?.approvalRequired }).toEqual({
        name,
        approvalRequired: true,
      });
      expect({
        name,
        inInventory: GATE_INVENTORY.some((e) => e.name === name),
      }).toEqual({ name, inInventory: false });
    }
  });
});

describe("门判据清单（gate inventory）— 红队：守卫必须真的会红", () => {
  const realSpecs = ALL_AGENT_TOOL_SPECS;

  it("⑤ 新增一个 write 且无审批的工具（仅夹具）⇒ 漏登记", () => {
    const fixture = [
      ...realSpecs,
      spec("delete_project", { resourceKind: "project" }),
    ];
    const audit = auditGateInventory(fixture, GATE_INVENTORY);
    expect(audit.unregistered).toEqual(["delete_project"]);
    // 而且必须是**红**：整张审计不为空
    expect(isGateInventoryClean(audit)).toBe(false);
  });

  it("⑤b 新工具只要带上 approvalRequired 就不进清单（不该被误报）", () => {
    const fixture = [
      ...realSpecs,
      spec("delete_project", {
        resourceKind: "project",
        approvalRequired: true,
      }),
    ];
    expect(auditGateInventory(fixture, GATE_INVENTORY)).toEqual(CLEAN);
  });

  it("⑥ 从清单删掉一条仍存在的工具名 ⇒ 漏登记（清单陈旧/被清空同样红）", () => {
    const shrunk = GATE_INVENTORY.filter((e) => e.name !== "trigger_task");
    expect(shrunk).toHaveLength(GATE_INVENTORY.length - 1);
    const audit = auditGateInventory(realSpecs, shrunk);
    expect(audit.unregistered).toEqual(["trigger_task"]);
    expect(isGateInventoryClean(audit)).toBe(false);

    // 极端情形：清单被整个删光 ⇒ 每个无门写工具都算漏登记（14 条），
    // 绝不是「没有要检查的东西」
    const auditEmpty = auditGateInventory(realSpecs, []);
    expect(auditEmpty.unregistered).toHaveLength(GATE_INVENTORY.length);
  });

  it("⑦ 清单里加一个注册表不存在的名字 ⇒ 幽灵名", () => {
    const ghost: GateInventoryEntry = {
      name: "no_such_tool_xyz",
      kind: "convergent",
      note: "这条理由写得足够长，但工具根本不存在。",
    };
    const audit = auditGateInventory(realSpecs, [...GATE_INVENTORY, ghost]);
    expect(audit.missingFromRegistry).toEqual(["no_such_tool_xyz"]);
    expect(isGateInventoryClean(audit)).toBe(false);
  });

  it("⑧ 清单里的工具变成有 approvalRequired ⇒ 提示应从清单移除", () => {
    const upgraded = realSpecs.map((s) =>
      s.name === "trigger_task" ? { ...s, approvalRequired: true as const } : s,
    );
    const audit = auditGateInventory(upgraded, GATE_INVENTORY);
    expect(audit.noLongerExempt).toEqual(["trigger_task"]);
    expect(audit.unregistered).toEqual([]);
    expect(formatGateInventoryAudit(audit)).toContain(
      "从 GATE_INVENTORY 删掉这些行",
    );
  });

  it("⑨ 理由空/过短/占位、known-gap 缺 ref ⇒ 不合格", () => {
    const blank: GateInventoryEntry = {
      name: "trigger_task",
      kind: "convergent",
      note: "   ",
    };
    const short: GateInventoryEntry = {
      name: "retry_execution",
      kind: "convergent",
      note: "x".repeat(MIN_REASON_LENGTH - 1),
    };
    const placeholder: GateInventoryEntry = {
      name: "pause_task",
      kind: "reversible",
      note: "TODO: 以后再想为什么它不需要门",
    };
    const noRef: GateInventoryEntry = {
      name: "resume_task",
      kind: "known-gap",
      note: "这是一个写得足够长但没有 ref 的 known-gap 理由。",
    };
    const audit = auditGateInventory(realSpecs, [
      blank,
      short,
      placeholder,
      noRef,
    ]);
    expect(audit.badReasons).toHaveLength(4);
    expect(audit.badReasons.join("\n")).toContain("known-gap 必须带 ref");
  });

  it("⑩ 高危动词命名的工具被标成 read ⇒ 红（命名判据不是摆设）", () => {
    const fixture = [
      ...realSpecs,
      spec("delete_project", { tier: "read", resourceKind: "project" }),
    ];
    const audit = auditGateInventory(fixture, GATE_INVENTORY);
    expect(audit.unexplainedHighRisk).toEqual(["delete_project"]);
    // 命名判据的锚定语义：名词形态的 deploy 不该被误伤
    expect(HIGH_RISK_NAME_PATTERN.test("list_deployments")).toBe(false);
    expect(HIGH_RISK_NAME_PATTERN.test("upgrade_deployment")).toBe(false);
    expect(HIGH_RISK_NAME_PATTERN.test("deploy_application")).toBe(true);
    expect(HIGH_RISK_NAME_PATTERN.test("sop_publish")).toBe(true);
  });

  it("⑪ 清单内重名 ⇒ 红（复制粘贴不该静默通过）", () => {
    const dup: GateInventoryEntry = {
      name: "trigger_task",
      kind: "convergent",
      note: "重复的一行，理由长度足够触发不到别的问题。",
    };
    const audit = auditGateInventory(realSpecs, [...GATE_INVENTORY, dup]);
    expect(audit.duplicateNames).toEqual(["trigger_task"]);
  });
});
