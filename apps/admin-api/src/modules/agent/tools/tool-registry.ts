import type { AgentToolTier } from "../entities/agent-tool-call.entity";

/**
 * P3（agent-and-deployment）：Agent 工具注册表（设计文档 03）。
 *
 * ## 为什么收编 mcp-server 而不是另起一套
 * `packages/mcp-server/src/tools.ts` 已把 admin-api 的 HTTP 面封装成 43 个
 * 工具（参数校验、端点路径、错误翻译都有）。本表复刻其**名称与语义**，
 * 使 Agent 与外部 AI（Claude Desktop 等）操作的是同一批端点、同一套语义，
 * 不存在「Agent 调 A、MCP 调 B」的行为漂移。
 *
 * ## 为什么不直接 import mcp-server 的 zod schema
 * 三个理由：① 那是 MCP SDK 的 zod 形状，转成 LLM function-calling schema
 * 需要一层转换，转换本身若草率就会丢约束；② 中台 Agent 是 **in-process**，
 * 直接调 Service 层比绕 HTTP 更可靠（设计文档 10 §调整1），执行体不同；
 * ③ 工具需要在**此表**上叠加 tier / scope 维度（MCP 侧不需要）。
 * 故本表是「定义单一事实源」，并由 `check-tool-parity` 断言与 mcp-server
 * 的 43 个工具名逐一对应——漂移即测试变红（同 check-enum-drift 的精神）。
 */

/**
 * 工具定义（喂给 LLM 的 function-calling schema + 本地执行信息）。
 */
export interface AgentToolSpec {
  name: string;
  description: string;
  /** JSON Schema 形式的参数（LLM function-calling 用）。 */
  parameters: Record<string, unknown>;
  /** 分级——决定是否需要审批（设计文档 03 §2）。 */
  tier: AgentToolTier;
  /**
   * 硬禁用标记。
   *
   * 与「需审批」的区别：需审批的工具在人工点头后可执行；**硬禁用**的工具
   * 任何情况下都不可执行，且**不提供配置开关**。
   * 当前只有审批类工具（approve/reject_deployment）被硬禁用——理由见
   * HARD_DISABLED_REASON。
   */
  hardDisabled?: true;
  /** 本工具操作的目标资源类型（scope 校验用）。 */
  resourceKind?: "application" | "executor" | "task" | "project" | "none";
  /** 参数中哪个字段承载资源 id（scope 交叉验证用）。 */
  resourceIdParam?: string;
}

/**
 * 硬禁用理由（写进 denial message，让模型理解为什么被拒而不是盲目重试）。
 */
export const HARD_DISABLED_REASON =
  "审批类工具对 Agent 永久禁用：DEP-04 审批的核心价值是「申请人 ≠ 审批人」的" +
  "双人原则。若 Agent 既能发起部署又能自行审批，双人原则被彻底架空——" +
  "这是安全红线，不是可调参数（设计文档 03 §2）。";

// ─────────────────────────────────────────────────────────────────────
// 通用参数片段（复用，避免每个工具重复写）
// ─────────────────────────────────────────────────────────────────────
const pagination = {
  page: { type: "integer", minimum: 1, description: "Page number (default 1)" },
  pageSize: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "Items per page (default 20)",
  },
} as const;

const uuid = (desc: string) => ({
  type: "string",
  format: "uuid",
  description: desc,
});

const str = (desc: string) => ({ type: "string", description: desc });

/**
 * 43 个收编的工具（对齐 mcp-server/src/tools.ts）。
 *
 * 分级依据（设计文档 03 §2）：
 *   read      —— 只读，默认全开
 *   write     —— 有副作用；其中「可逆/收敛性」的（触发/重试/暂停/终止）
 *                默认允许，其余需审批
 *   dangerous —— 默认禁用或强制审批
 */
export const AGENT_TOOL_SPECS: readonly AgentToolSpec[] = [
  // ═══ 任务组（18，对齐 registerTaskTools）═══
  {
    name: "list_tasks",
    description:
      "List all tasks defined in AutoCodeFlow. Returns id, name, status, cron, and last execution info.",
    parameters: {
      type: "object",
      properties: {
        ...pagination,
        status: str("Filter by task status: active | paused"),
        name: str("Filter by task name (fuzzy match)"),
      },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "get_task",
    description:
      "Get full details of a specific task by its ID, including script source, cron, timeout, and dependencies.",
    parameters: {
      type: "object",
      properties: { taskId: uuid("Task ID") },
      required: ["taskId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "trigger_task",
    description:
      "Manually trigger a task to run immediately. Returns the execution ID that can be polled with get_execution. " +
      "This is the primary action for ad-hoc verification after a fix.",
    parameters: {
      type: "object",
      properties: {
        taskId: uuid("Task ID"),
        params: {
          type: "object",
          description: "Optional runtime parameters (AUTOFLOW_<KEY> injected)",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    // 触发是幂等意图且可终止——排障最常用的动作，默认允许
    tier: "write",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "update_task",
    description:
      "Partially update a task (PATCH). Changing cronExpression or the script affects production behaviour — use with evidence.",
    parameters: {
      type: "object",
      properties: {
        taskId: uuid("Task ID"),
        patch: {
          type: "object",
          description: "Fields to update (CreateTaskDto whitelist)",
        },
      },
      required: ["taskId", "patch"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "list_task_versions",
    description:
      "List historical configuration versions of a task (newest first).",
    parameters: {
      type: "object",
      properties: { taskId: uuid("Task ID") },
      required: ["taskId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "rollback_task_version",
    description:
      "Roll a task back to a specific historical version snapshot. Changes production behaviour.",
    parameters: {
      type: "object",
      properties: {
        taskId: uuid("Task ID"),
        versionId: uuid("Target version ID"),
      },
      required: ["taskId", "versionId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "compare_task_versions",
    description:
      "Diff two task versions, returns changed fields with old/new values.",
    parameters: {
      type: "object",
      properties: {
        taskId: uuid("Task ID"),
        fromVersionId: uuid("Source version ID"),
        toVersionId: uuid("Target version ID"),
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "list_executions",
    description:
      "List recent executions, filterable by task and status. Primary entry point for failure investigation.",
    parameters: {
      type: "object",
      properties: {
        ...pagination,
        taskId: uuid("Filter by task ID"),
        status: str(
          "Filter by status: pending | running | success | failed | timeout | killed | cancelled",
        ),
      },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "get_execution",
    description:
      "Get full execution details including logs and AI analysis. The main evidence source when diagnosing a failure.",
    parameters: {
      type: "object",
      properties: { executionId: uuid("Execution ID") },
      required: ["executionId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "analyze_execution",
    description:
      "Trigger AI root-cause analysis on a failed execution. Consumes AI quota (counts toward the session token budget).",
    parameters: {
      type: "object",
      properties: {
        taskId: uuid("Task ID"),
        executionId: uuid("Execution ID"),
      },
      required: ["taskId", "executionId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "get_execution_stats",
    description:
      "Success rate, average duration and recent-run statistics for a task.",
    parameters: {
      type: "object",
      properties: { taskId: uuid("Task ID") },
      required: ["taskId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "suggest_schedule",
    description:
      "Get an AI-recommended cron schedule based on execution history. Returns a suggestion only — it does not persist. Consumes AI quota.",
    parameters: {
      type: "object",
      properties: { taskId: uuid("Task ID") },
      required: ["taskId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "get_execution_logs",
    description: "Paginated execution logs (fromLine + limit).",
    parameters: {
      type: "object",
      properties: {
        executionId: uuid("Execution ID"),
        fromLine: {
          type: "integer",
          minimum: 0,
          description: "Start line (default 0)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          description: "Max lines (default 500, cap 2000)",
        },
      },
      required: ["executionId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "kill_execution",
    description:
      "Force-cancel a running or pending execution. A converging action — safe direction.",
    parameters: {
      type: "object",
      properties: {
        taskId: uuid("Task ID (route is task-scoped)"),
        executionId: uuid("Execution ID"),
      },
      required: ["taskId", "executionId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "retry_execution",
    description:
      "Re-run a past execution (creates a fresh run, replaying the original runtime params).",
    parameters: {
      type: "object",
      properties: {
        taskId: uuid("Task ID"),
        executionId: uuid("Execution ID"),
        params: { type: "object", description: "Override runtime params" },
      },
      required: ["taskId", "executionId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "pause_task",
    description:
      "Pause a task — stops scheduled triggers (in-progress executions are unaffected).",
    parameters: {
      type: "object",
      properties: { taskId: uuid("Task ID") },
      required: ["taskId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "resume_task",
    description: "Resume a previously paused task.",
    parameters: {
      type: "object",
      properties: { taskId: uuid("Task ID") },
      required: ["taskId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "task",
    resourceIdParam: "taskId",
  },
  {
    name: "create_task_from_template",
    description:
      "Create a runnable task from a built-in template (scheduled_backup / health_check / data_sync / log_cleanup / webhook_ping). Creating is non-destructive.",
    parameters: {
      type: "object",
      properties: {
        template: str("Template key"),
        name: str("New task name"),
        description: str("Optional description"),
        overrides: {
          type: "object",
          description: "Optional CreateTaskDto field overrides",
        },
      },
      required: ["template", "name"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "none",
  },

  // ═══ 应用组（6，对齐 registerApplicationTools）═══
  {
    name: "list_applications",
    description: "List registered applications.",
    parameters: {
      type: "object",
      properties: { ...pagination },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "get_application",
    description:
      "Full application details (version, git repo, runtime config).",
    parameters: {
      type: "object",
      properties: { applicationId: uuid("Application ID") },
      required: ["applicationId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "application",
    resourceIdParam: "applicationId",
  },
  {
    name: "create_application",
    description:
      "Register a new application (name / version / runtime). Creating is non-destructive.",
    parameters: {
      type: "object",
      properties: {
        name: str("Application name (globally unique)"),
        version: str("Version string"),
        runtime: str("Runtime: node | python | shell"),
        description: str("Optional description"),
      },
      required: ["name", "version", "runtime"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "none",
  },
  {
    name: "update_application",
    description:
      "Update an application (renaming is not supported). Affects production behaviour.",
    parameters: {
      type: "object",
      properties: {
        applicationId: uuid("Application ID"),
        patch: { type: "object", description: "Fields to update" },
      },
      required: ["applicationId", "patch"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "application",
    resourceIdParam: "applicationId",
  },
  {
    name: "delete_application",
    description: "Delete an application by ID. IRREVERSIBLE.",
    parameters: {
      type: "object",
      properties: { applicationId: uuid("Application ID") },
      required: ["applicationId"],
      additionalProperties: false,
    },
    // 不可逆 → dangerous（默认禁用，需显式开启 + 强制审批）
    tier: "dangerous",
    resourceKind: "application",
    resourceIdParam: "applicationId",
  },
  {
    name: "analyze_application",
    description:
      "AI health analysis across an application's tasks. Consumes AI quota.",
    parameters: {
      type: "object",
      properties: { applicationId: uuid("Application ID") },
      required: ["applicationId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "application",
    resourceIdParam: "applicationId",
  },

  // ═══ 部署与审批组（9，对齐 registerDeploymentTools）═══
  {
    name: "list_deployments",
    description: "List deployments, filterable by application ID.",
    parameters: {
      type: "object",
      properties: {
        ...pagination,
        applicationId: uuid("Filter by application ID"),
      },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "deploy_application",
    description:
      "Deploy an application to an executor (auto-selects the lowest-load executor when executorId is omitted). " +
      "With approval enabled this returns approvalStatus=pending_approval and is NOT dispatched until a human approves — " +
      "report that back rather than retrying.",
    parameters: {
      type: "object",
      properties: {
        applicationId: uuid("Application ID"),
        executorId: uuid("Target executor (optional)"),
        version: str("Version to deploy (optional)"),
      },
      required: ["applicationId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "application",
    resourceIdParam: "applicationId",
  },
  {
    name: "deploy_app",
    description:
      "Deploy an application by NAME (resolved via GET /applications). Same approval semantics as deploy_application.",
    parameters: {
      type: "object",
      properties: {
        name: str("Application name"),
        executorId: uuid("Target executor (optional)"),
      },
      required: ["name"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "application",
    resourceIdParam: "name",
  },
  {
    name: "upgrade_deployment",
    description:
      "Trigger an overlay upgrade for a running deployment (pulls the latest application version).",
    parameters: {
      type: "object",
      properties: { deploymentId: uuid("Deployment ID") },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "none",
  },
  {
    name: "stop_deployment",
    description: "Stop a running application deployment.",
    parameters: {
      type: "object",
      properties: { deploymentId: uuid("Deployment ID") },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "none",
  },
  {
    name: "list_pending_approvals",
    description: "List deployments awaiting approval (requires ADMIN).",
    parameters: {
      type: "object",
      properties: { ...pagination },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "approve_deployment",
    description:
      "Approve a pending deployment — dispatches it. Approver must differ from requester (second-person rule).",
    parameters: {
      type: "object",
      properties: {
        deploymentId: uuid("Deployment ID"),
        reason: str("Optional reason (<=200 chars)"),
      },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    tier: "dangerous",
    // ★ 安全红线：永久硬禁用，不提供配置开关
    hardDisabled: true,
    resourceKind: "none",
  },
  {
    name: "reject_deployment",
    description: "Reject a pending deployment; it is never dispatched.",
    parameters: {
      type: "object",
      properties: {
        deploymentId: uuid("Deployment ID"),
        reason: str("Optional reason"),
      },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    tier: "dangerous",
    // 同上：Agent 不应能替人做拒绝决定
    hardDisabled: true,
    resourceKind: "none",
  },
  {
    name: "cancel_deployment",
    description:
      "Cancel your own pending deployment request (requester-only exit). Releases the in-flight slot.",
    parameters: {
      type: "object",
      properties: { deploymentId: uuid("Deployment ID") },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    // 撤回自己的请求不破坏双人原则，且是释放占坑的必要动作
    tier: "write",
    resourceKind: "none",
  },

  // ═══ 执行器组（3，对齐 registerExecutorTools）═══
  {
    name: "list_executors",
    description: "List executors with their status and current load.",
    parameters: {
      type: "object",
      properties: { ...pagination },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "get_executor",
    description:
      "Single executor detail: config, status, group/tags, resource usage, heartbeat-reported running executions.",
    parameters: {
      type: "object",
      properties: { executorId: uuid("Executor ID") },
      required: ["executorId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "executor",
    resourceIdParam: "executorId",
  },
  {
    name: "get_executor_metrics",
    description:
      "7-day stats (successRate / avgDurationMs) plus current runningTaskCount / cpuUsage / memUsage.",
    parameters: {
      type: "object",
      properties: { executorId: uuid("Executor ID") },
      required: ["executorId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "executor",
    resourceIdParam: "executorId",
  },

  // ═══ 可观测组（3，对齐 registerObservabilityTools）═══
  {
    name: "get_execution_timeline",
    description:
      "Execution timeline: created -> started -> finished, plus a failure triage card (reason -> suggested first action).",
    parameters: {
      type: "object",
      properties: { executionId: uuid("Execution ID") },
      required: ["executionId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "list_dead_letters",
    description: "Callback dead-letter backlog per executor.",
    parameters: {
      type: "object",
      properties: { ...pagination },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "get_scheduler_health",
    description:
      "Scheduler health snapshot: leader election, BullMQ queue depths, tick rate, trigger counters, P99 trigger latency.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    resourceKind: "none",
  },

  // ═══ 审计组（1，对齐 registerAuditTools）═══
  {
    name: "list_audit_logs",
    description: "Query the audit log (pagination + whitelisted filters).",
    parameters: {
      type: "object",
      properties: {
        ...pagination,
        action: str("Filter by action"),
        resource: str("Filter by resource"),
        userId: str("Filter by user ID"),
        username: str("Filter by username"),
        startTime: str("ISO start time"),
        endTime: str("ISO end time"),
      },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },

  // ═══ 项目组（3，对齐 registerProjectTools）═══
  {
    name: "list_projects",
    description:
      "Projects visible to the current credential, each with myRole.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "get_project_members",
    description: "Members (userId + role) of one project.",
    parameters: {
      type: "object",
      properties: { projectId: uuid("Project ID") },
      required: ["projectId"],
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "project",
    resourceIdParam: "projectId",
  },
  {
    name: "get_my_project_roles",
    description:
      "Caller's project memberships: { userId, isAdmin, memberships }.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    resourceKind: "none",
  },
];

/** 按名字索引（O(1) 查表，闸门每次调用都要查）。 */
export const AGENT_TOOL_BY_NAME: ReadonlyMap<string, AgentToolSpec> = new Map(
  AGENT_TOOL_SPECS.map((t) => [t.name, t]),
);

/**
 * 会话类型 → 可用工具白名单（设计文档 03 §5.1 第①道检查）。
 *
 * `null` 表示「该类型不限制工具」（仅用于 chat：管理员直接对话，与
 * 人工操作同权限面，闸门仍逐调用判 tier）。
 */
export const SESSION_TOOL_ALLOWLIST: Record<string, readonly string[] | null> =
  {
    /**
     * 运维值守：**纯只读**。定时巡检不应有副作用——它每小时醒一次，
     * 任何写操作都会被重复执行很多次。
     */
    ops_watch: AGENT_TOOL_SPECS.filter((t) => t.tier === "read").map(
      (t) => t.name,
    ),

    /**
     * 事件处置：只读 + 有限的收敛性写操作（触发/重试/暂停/终止）。
     * 刻意**不含** update_task / delete_* / approve_*——故障处置场景下
     * 改配置与审批应由人来决定。
     */
    incident: AGENT_TOOL_SPECS.filter(
      (t) =>
        t.tier === "read" ||
        [
          "trigger_task",
          "retry_execution",
          "kill_execution",
          "pause_task",
          "resume_task",
        ].includes(t.name),
    ).map((t) => t.name),

    /** SOP 起草：读 + 建应用/建任务/部署（部署仍需审批）。 */
    sop_authoring: AGENT_TOOL_SPECS.filter(
      (t) =>
        t.tier === "read" ||
        [
          "create_application",
          "create_task_from_template",
          "deploy_application",
          "deploy_app",
          "trigger_task",
        ].includes(t.name),
    ).map((t) => t.name),

    /** SOP 复核（P6）：读 + 澄清回复（澄清工具在 P6 加）。当前纯只读。 */
    sop_review: AGENT_TOOL_SPECS.filter((t) => t.tier === "read").map(
      (t) => t.name,
    ),

    /** 应用脚手架（P5/P7）：与 sop_authoring 同集。 */
    app_scaffold: AGENT_TOOL_SPECS.filter(
      (t) =>
        t.tier === "read" ||
        [
          "create_application",
          "create_task_from_template",
          "deploy_application",
          "deploy_app",
          "trigger_task",
        ].includes(t.name),
    ).map((t) => t.name),

    /** 人工对话：不限工具（管理员与 Agent 对话，等价于管理员自己在操作）。 */
    chat: null,
  };

/** 取会话类型的可用工具集。未登记的类型 → 空集（拒绝一切，安全默认）。 */
export function toolsForSessionKind(kind: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(SESSION_TOOL_ALLOWLIST, kind)
    ? SESSION_TOOL_ALLOWLIST[kind]
    : [];
}
