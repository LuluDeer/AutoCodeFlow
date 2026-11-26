import {
  OUTPUT_BUDGET_DEFAULT_TURNS,
  OUTPUT_BUDGET_TURNS_CAP,
  OUTPUT_BUDGET_UNITS_CAP,
  minimalToolsForKind,
  outputBudgetFor,
} from "../context-budget";

describe("minimalToolsForKind (N12 最小工具集)", () => {
  it("控制组：已知 kind 只投影 available 中的最小交集，顺序稳定且去重", () => {
    const result = minimalToolsForKind("ops_watch", [
      "trigger_task",
      "list_tasks",
      "update_task",
      "get_scheduler_health",
      "get_scheduler_health",
      "delete_application",
      "list_executions",
    ]);

    expect(result).toEqual([
      "list_tasks",
      "get_scheduler_health",
      "list_executions",
    ]);
    expect(result).not.toContain("trigger_task");
    expect(result).not.toContain("update_task");
    expect(result).not.toContain("delete_application");
  });

  it("事件处置只保留最小收敛写集合，不放大到 update_task", () => {
    const result = minimalToolsForKind("incident", [
      "update_task",
      "kill_execution",
      "get_execution_logs",
      "retry_execution",
      "trigger_task",
      "delete_application",
      "get_execution",
    ]);

    expect(result).toEqual([
      "kill_execution",
      "get_execution_logs",
      "retry_execution",
      "trigger_task",
      "get_execution",
    ]);
  });

  it("SOP 复核保留澄清回复，不放行 sop_publish", () => {
    const result = minimalToolsForKind("sop_review", [
      "sop_publish",
      "sop_get",
      "sop_reply_clarification",
      "get_execution",
      "deploy_application",
    ]);

    expect(result).toEqual([
      "sop_get",
      "sop_reply_clarification",
      "get_execution",
    ]);
  });

  it("未登记的工具即使进入 available 也不会被投影出来", () => {
    expect(minimalToolsForKind("ops_watch", ["trigger_task"])).toEqual([]);
    expect(minimalToolsForKind("chat", ["sop_publish"])).toEqual([]);
  });

  it("fail-closed：未知 kind 返回空集（翻转成非空即转红）", () => {
    const available = ["list_tasks", "get_task", "trigger_task", "sop_publish"];

    expect(minimalToolsForKind("evil_kind", available)).toEqual([]);
    expect(minimalToolsForKind("", available)).toEqual([]);
    expect(minimalToolsForKind("__proto__", available)).toEqual([]);
  });

  it("available 缺失或非数组时返回空集", () => {
    expect(
      minimalToolsForKind("ops_watch", null as unknown as readonly string[]),
    ).toEqual([]);
    expect(
      minimalToolsForKind(
        "incident",
        "get_execution" as unknown as readonly string[],
      ),
    ).toEqual([]);
  });
});

describe("outputBudgetFor (N12 输出预算)", () => {
  it("控制组：缺省走默认轮次，返回相对单位与理由", () => {
    const result = outputBudgetFor({});

    expect(result.maxTurns).toBe(OUTPUT_BUDGET_DEFAULT_TURNS);
    expect(result.units).toBe(OUTPUT_BUDGET_DEFAULT_TURNS * 4);
    expect(result.unit).toBe("relative");
    expect(result.capabilityCount).toBe(0);
    expect(result.clamped).toBe(false);
    expect(result.reasons).toContain(
      `未提供 maxTurns，按默认 ${OUTPUT_BUDGET_DEFAULT_TURNS} 轮`,
    );
    expect(result.reasons).toContain(
      "单位为相对预算单位（RU），不折算真实 token",
    );
  });

  it("能力提示按可识别项追加预算，重复项与未知项不追加", () => {
    const result = outputBudgetFor({
      budget: { maxTurns: 6 },
      capabilityHints: ["browser", "gui", "browser", "unknown_cap", ""],
    });

    expect(result.maxTurns).toBe(6);
    expect(result.capabilityCount).toBe(2);
    expect(result.units).toBe(6 * 4 + 2 * 8);
    expect(result.clamped).toBe(false);
    expect(result.reasons).toContain(
      "能力 browser/gui 计入 2 项附加预算（每项 8 RU）",
    );
    expect(result.reasons).toContain(
      "忽略不在投影能力集合的 unknown_cap（不追加预算）",
    );
  });

  it("轮次超上限必须钳制（钳制翻转即转红）", () => {
    const result = outputBudgetFor({ budget: { maxTurns: 999 } });

    expect(result.maxTurns).toBe(OUTPUT_BUDGET_TURNS_CAP);
    expect(result.maxTurns).toBe(20);
    expect(result.units).toBe(OUTPUT_BUDGET_TURNS_CAP * 4);
    expect(result.clamped).toBe(true);
    expect(result.reasons).toContain(
      "请求 maxTurns=999 超过轮次上限 20，已钳制",
    );
  });

  it("总相对预算超上限必须钳制（钳制翻转即转红）", () => {
    const result = outputBudgetFor({
      budget: { maxTurns: OUTPUT_BUDGET_TURNS_CAP },
      capabilityHints: ["browser", "gui", "filesystem"],
    });

    expect(result.capabilityCount).toBe(3);
    expect(result.units).toBe(OUTPUT_BUDGET_UNITS_CAP);
    expect(result.units).toBe(100);
    expect(result.clamped).toBe(true);
    expect(result.reasons).toContain(
      "相对预算 104 RU 超过上限 100 RU，已钳制为 100 RU",
    );
  });

  it("非法轮次回落默认值，不静默放大预算", () => {
    const bad = outputBudgetFor({ budget: { maxTurns: "abc" } });
    const fraction = outputBudgetFor({ budget: { maxTurns: 0.5 } });

    expect(bad.maxTurns).toBe(OUTPUT_BUDGET_DEFAULT_TURNS);
    expect(bad.clamped).toBe(true);
    expect(bad.reasons).toContain(
      `maxTurns 非法，回落默认 ${OUTPUT_BUDGET_DEFAULT_TURNS} 轮`,
    );
    expect(fraction.maxTurns).toBe(OUTPUT_BUDGET_DEFAULT_TURNS);
    expect(fraction.clamped).toBe(true);
  });
});
