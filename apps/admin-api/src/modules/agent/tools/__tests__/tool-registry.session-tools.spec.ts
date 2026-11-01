/**
 * 会话工具面（类型 × 阶段）的冻结与收窄断言。
 *
 * 背景（N1，主会话裁定 R4）：只做**静态**裁剪——`SESSION_TOOL_ALLOWLIST` 按
 * `kind` 收窄、`SESSION_PHASE_TOOL_ALLOWLIST` 按「kind × 阶段」再收窄；
 * **不做**检索式渐进披露、**不做**桥接工具（桥会以工具名为键重写 tool_call，
 * 打穿审批键 / 在途台账 / 逐工具配额 / 逐工具指标四套机制）。
 *
 * 本 spec 钉四件事：
 *   ① 每个 kind 的工具集 = 冻结基线（「任何 kind 都不得拿到今天拿不到的工具」，
 *      收窄方向恒为 ⊆；顺序也钉住——工具数组是 prompt 前缀的一部分，重排会让
 *      provider 侧前缀缓存失效）；
 *   ② 阶段维度 fail-closed：未登记的 (kind, phase) 是**空集**，且登记值只能
 *      ⊆ 同 kind 的类型级白名单；
 *   ③ 未登记的类型 → 空集（含原型链键名）；
 *   ④ `chat` 的 `null`（不限工具）语义逐字未变。
 */
import {
  AGENT_TOOL_BY_NAME,
  SESSION_PHASE_TOOL_ALLOWLIST,
  SESSION_TOOL_ALLOWLIST,
  toolsForSessionKind,
} from "../tool-registry";

/**
 * 冻结基线：2026-11-01 / HEAD a7f8ba46 的逐 kind 工具集，顺序 = registry 产出顺序。
 *
 * 这是**棘轮**而不是快照：新增一个只读工具会让 `ops_watch` 等集合自动变宽
 * （它们按 `tier === "read"` 派生），于是本表会红——那不是回归，而是要求
 * 在 diff 里显式确认「新工具也要给这些自动化会话」。任何 kind 出现基线之外
 * 的工具，就是**放宽**，必须在这里先改基线（且理由要写进 PR）。
 */
const BASELINE: Record<string, readonly string[]> = {
  ops_watch: [
    "list_tasks",
    "get_task",
    "list_task_versions",
    "compare_task_versions",
    "list_executions",
    "get_execution",
    "get_session_steps",
    "get_tool_call_result",
    "analyze_execution",
    "get_execution_stats",
    "suggest_schedule",
    "get_execution_logs",
    "list_applications",
    "get_application",
    "analyze_application",
    "list_mutex_groups",
    "list_deployments",
    "list_pending_approvals",
    "list_executors",
    "get_executor",
    "get_executor_metrics",
    "get_execution_timeline",
    "list_dead_letters",
    "get_scheduler_health",
    "list_audit_logs",
    "list_projects",
    "get_project_members",
    "get_my_project_roles",
    "sop_list",
    "sop_get",
  ],
  incident: [
    "list_tasks",
    "get_task",
    "trigger_task",
    "list_task_versions",
    "compare_task_versions",
    "list_executions",
    "get_execution",
    "get_session_steps",
    "get_tool_call_result",
    "analyze_execution",
    "get_execution_stats",
    "suggest_schedule",
    "get_execution_logs",
    "kill_execution",
    "retry_execution",
    "pause_task",
    "resume_task",
    "list_applications",
    "get_application",
    "analyze_application",
    "list_mutex_groups",
    "list_deployments",
    "list_pending_approvals",
    "list_executors",
    "get_executor",
    "get_executor_metrics",
    "get_execution_timeline",
    "list_dead_letters",
    "get_scheduler_health",
    "list_audit_logs",
    "list_projects",
    "get_project_members",
    "get_my_project_roles",
    "sop_list",
    "sop_get",
  ],
  sop_authoring: [
    "list_tasks",
    "get_task",
    "trigger_task",
    "list_task_versions",
    "compare_task_versions",
    "list_executions",
    "get_execution",
    "get_session_steps",
    "get_tool_call_result",
    "analyze_execution",
    "get_execution_stats",
    "suggest_schedule",
    "get_execution_logs",
    "create_task_from_template",
    "list_applications",
    "get_application",
    "create_application",
    "analyze_application",
    "list_mutex_groups",
    "create_mutex_group",
    "list_deployments",
    "deploy_application",
    "deploy_app",
    "list_pending_approvals",
    "list_executors",
    "get_executor",
    "get_executor_metrics",
    "get_execution_timeline",
    "list_dead_letters",
    "get_scheduler_health",
    "list_audit_logs",
    "list_projects",
    "get_project_members",
    "get_my_project_roles",
    "sop_list",
    "sop_get",
    "sop_draft",
    "sop_publish",
    "sop_assign",
  ],
  sop_review: [
    "list_tasks",
    "get_task",
    "trigger_task",
    "list_task_versions",
    "compare_task_versions",
    "list_executions",
    "get_execution",
    "get_session_steps",
    "get_tool_call_result",
    "analyze_execution",
    "get_execution_stats",
    "suggest_schedule",
    "get_execution_logs",
    "list_applications",
    "get_application",
    "analyze_application",
    "list_mutex_groups",
    "list_deployments",
    "list_pending_approvals",
    "list_executors",
    "get_executor",
    "get_executor_metrics",
    "get_execution_timeline",
    "list_dead_letters",
    "get_scheduler_health",
    "list_audit_logs",
    "list_projects",
    "get_project_members",
    "get_my_project_roles",
    "sop_list",
    "sop_get",
    "sop_reply_clarification",
  ],
  app_scaffold: [
    "list_tasks",
    "get_task",
    "trigger_task",
    "list_task_versions",
    "compare_task_versions",
    "list_executions",
    "get_execution",
    "get_session_steps",
    "get_tool_call_result",
    "analyze_execution",
    "get_execution_stats",
    "suggest_schedule",
    "get_execution_logs",
    "create_task_from_template",
    "list_applications",
    "get_application",
    "create_application",
    "analyze_application",
    "list_mutex_groups",
    "create_mutex_group",
    "list_deployments",
    "deploy_application",
    "deploy_app",
    "list_pending_approvals",
    "list_executors",
    "get_executor",
    "get_executor_metrics",
    "get_execution_timeline",
    "list_dead_letters",
    "get_scheduler_health",
    "list_audit_logs",
    "list_projects",
    "get_project_members",
    "get_my_project_roles",
    "sop_list",
    "sop_get",
  ],
};

/** 每个 kind 的期望规模（= 冻结基线的长度；规模变化同样是工具面变化）。 */
const EXPECTED_SIZE: Record<string, number> = {
  ops_watch: 30,
  incident: 35,
  sop_authoring: 39,
  sop_review: 32,
  app_scaffold: 36,
};

describe("会话工具面 · 类型维度（冻结基线 + 只收窄）", () => {
  it("每个 kind 的工具集与冻结基线逐字一致（顺序也一致）", () => {
    for (const [kind, expected] of Object.entries(BASELINE)) {
      const actual = toolsForSessionKind(kind);
      expect(Array.isArray(actual)).toBe(true);
      const names = actual as readonly string[];
      // 方向断言：基线之外的工具一个都不许出现（不得拿到今天拿不到的工具）
      expect({
        kind,
        widened: names.filter((n) => !expected.includes(n)),
      }).toEqual({ kind, widened: [] });
      // 今天：与基线逐字相等（不是更窄），顺序同样钉住
      expect([...names]).toEqual([...expected]);
      expect(names).toHaveLength(EXPECTED_SIZE[kind]);
    }
  });

  it("任何 kind 都不含硬禁用工具（它们连看都看不到）", () => {
    for (const kind of Object.keys(BASELINE)) {
      const names = toolsForSessionKind(kind) as readonly string[];
      expect({
        kind,
        hardDisabled: names.filter(
          (n) => AGENT_TOOL_BY_NAME.get(n)?.hardDisabled,
        ),
      }).toEqual({ kind, hardDisabled: [] });
    }
  });
});

describe("会话工具面 · 阶段维度（fail-closed 收窄）", () => {
  /** 候选阶段：今天**一个都没登记**（表里没有任何可靠来源，见 registry 注释）。 */
  const PHASES = ["draft", "publish", "read", "triage", "running", "init", ""];

  it("未登记的阶段 → 空集（不回落到类型级白名单）", () => {
    for (const kind of Object.keys(BASELINE)) {
      const base = toolsForSessionKind(kind) as readonly string[];
      for (const phase of PHASES) {
        const narrowed = toolsForSessionKind(kind, phase);
        expect(Array.isArray(narrowed)).toBe(true);
        const names = narrowed as readonly string[];
        // 空集 ⊆ 任何集合：阶段只能收窄，且未登记 = 拒绝一切
        expect(names).toEqual([]);
        expect(names.length).toBeLessThan(base.length);
      }
    }
  });

  it("阶段参数收窄：结果恒为「无阶段结果」的子集（chat 无阶段不限 → 阶段集为空集）", () => {
    for (const kind of [...Object.keys(BASELINE), "chat"]) {
      const base = toolsForSessionKind(kind);
      for (const phase of PHASES) {
        const narrowed = toolsForSessionKind(kind, phase) as readonly string[];
        if (base === null) {
          expect(narrowed).toEqual([]);
          continue;
        }
        expect(narrowed.filter((n) => !base.includes(n))).toEqual([]);
      }
    }
  });

  it("阶段表只能收窄：任何登记条目必须 ⊆ 同 kind 的类型级白名单", () => {
    // 今天表为空 → 空转；这条断言是为**将来**的条目守方向（登记值写宽即红）。
    for (const [kind, phases] of Object.entries(SESSION_PHASE_TOOL_ALLOWLIST)) {
      const base: readonly string[] | null | undefined =
        SESSION_TOOL_ALLOWLIST[kind];
      for (const [phase, subset] of Object.entries(phases)) {
        // chat 的类型级是 null（不限），阶段集本身就是它的上限。
        if (base === null) continue;
        expect({
          kind,
          phase,
          outsideBase:
            base === undefined
              ? [...subset]
              : subset.filter((n) => !base.includes(n)),
        }).toEqual({ kind, phase, outsideBase: [] });
      }
    }
  });

  it("省略阶段 = 传 null（默认参数不改变类型级结果）", () => {
    for (const kind of Object.keys(BASELINE)) {
      expect(toolsForSessionKind(kind, undefined)).toEqual(
        toolsForSessionKind(kind),
      );
    }
  });
});

describe("会话工具面 · fail-closed 默认与 chat 语义", () => {
  it("未登记的会话类型 → 空集（含原型链键名）", () => {
    for (const kind of [
      "evil_kind",
      "",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(toolsForSessionKind(kind)).toEqual([]);
      expect(toolsForSessionKind(kind, "draft")).toEqual([]);
    }
  });

  it("chat 语义未变：无阶段 → null（不限工具），不是空集", () => {
    expect(SESSION_TOOL_ALLOWLIST.chat).toBeNull();
    // 同一个引用（不是拷贝、不是空数组）：specsForSession 靠 `=== null` 展开全集
    expect(toolsForSessionKind("chat")).toBe(SESSION_TOOL_ALLOWLIST.chat);
    expect(toolsForSessionKind("chat", null)).toBeNull();
  });
});
