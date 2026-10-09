import type { AgentToolTier } from "../entities/agent-tool-call.entity";

/**
 * P3（agent-and-deployment）：Agent 工具注册表（设计文档 03）。
 *
 * ## 为什么收编 mcp-server 而不是另起一套
 * `packages/mcp-server/src/tools.ts` 已把 admin-api 的 HTTP 面封装成 56 个
 * 工具（参数校验、端点路径、错误翻译都有）。本表复刻其**名称与语义**，
 * 使 Agent 与外部 AI（Claude Desktop 等）操作的是同一批端点、同一套语义，
 * 不存在「Agent 调 A、MCP 调 B」的行为漂移。
 *
 * ## 为什么不直接 import mcp-server 的 zod schema
 * 三个理由：① 那是 MCP SDK 的 zod 形状，转成 LLM function-calling schema
 * 需要一层转换，转换本身若草率就会丢约束；② 中台 Agent 是 **in-process**，
 * 直接调 Service 层比绕 HTTP 更可靠（设计文档 10 §调整1），执行体不同；
 * ③ 工具需要在**此表**上叠加 tier / scope 维度（MCP 侧不需要）。
 * 故本表是「定义单一事实源」，并由 `scripts/agent-boundary-check.mjs` 断言
 * 「每个 mcp 工具要么被闸门纳管、要么在显式排除清单里」——漂移即检查变红
 * （同 check-enum-drift 的精神）。
 *
 * 注意：**不**断言「与 mcp-server 逐一镜像」。两个面各自演进（mcp 现有 56
 * 个，而 agent 面刻意不开放其中一部分，另有 mcp 没有的内部工具），硬编码
 * 数字曾三次漂移。当前不变量见 agent-boundary-check 的两条断言：① 纳管或
 * 显式排除（新增 mcp 工具必须做决定）；② 闸门对未知工具 fail-closed。
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
  resourceKind?:
    "application" | "executor" | "task" | "project" | "sop" | "none";
  /** 参数中哪个字段承载资源 id（scope 交叉验证用）。 */
  resourceIdParam?: string;
  /**
   * 该工具**默认需要人工审批**（独立于全局 writeRequiresApproval 的
   * 逐工具闸）。
   *
   * 为什么需要它：`sop_publish` 的发布权 = 间接的指令注入权（SOP 会成为
   * 另一个 Agent 的执行依据，04 §4.3），这一条不随全局写审批策略放宽而
   * 放宽。注意与 hardDisabled 的区别：需审批的工具人工点头后可执行。
   */
  approvalRequired?: true;
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
 * 47 个收编的工具（对齐 mcp-server/src/tools.ts）。
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
    /** 03 §2：改生产任务配置需审批——不随全局写策略放宽而放宽。 */
    approvalRequired: true,
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
    /** 03 §2：影响运行行为需审批。 */
    approvalRequired: true,
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

  // ═══ 互斥组（4，对齐 registerMutexTools · MUTEX-01）═══
  //
  // 分级依据（沿用 03 §2 的「产生多大后果」标尺）：
  //   · list/read —— 只读，全开；
  //   · create —— 新建无破坏（与 create_application 同档：建组本身不改任何
  //     既有应用的行为，应用只在被显式挂组后才受约束）；
  //   · update —— write（可逆但**影响生产并发**）：把 scope 收紧为 global 或
  //     调低 maxConcurrentPerDevice 会立刻限制在跑业务的并发度。按 03 §2
  //     「可逆/收敛性写操作默认放行」列为 write 而非 dangerous——它可随时改回，
  //     且改错不会丢数据（对比 delete_* 的不可逆）；
  //   · delete —— **dangerous**：挂载中的应用会经 FK SET NULL 静默解除互斥，
  //     此后本该串行的独占型负载（浏览器实例/单点登录顶号）可能并发相撞。
  //     不可逆且后果落在生产，与 delete_application 同档（默认禁用 + 强制审批）。
  {
    name: "list_mutex_groups",
    description:
      "List application mutex groups. Apps in one group never run concurrently on the same device (maxConcurrentPerDevice, default 1 = serial). scope=device serialises per device (cross-device concurrent); scope=global serialises platform-wide. Read this before attaching an app to a group.",
    parameters: {
      type: "object",
      properties: { ...pagination },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "create_mutex_group",
    description:
      "Create an application mutex group. Creating is non-destructive — existing applications keep their behaviour until an app is explicitly attached via update_application's mutexGroupId.",
    parameters: {
      type: "object",
      properties: {
        name: str("Unique group name (max 64 chars)"),
        maxConcurrentPerDevice: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "Concurrent runs per device (1-100, default 1 = serial). Meaning platform-wide when scope=global.",
        },
        scope: {
          type: "string",
          enum: ["device", "global"],
          description:
            "device (default) = serial per device, cross-device concurrent; global = serial platform-wide (single-sign-on takeover)",
        },
        description: str("Optional description (max 500 chars)"),
      },
      required: ["name"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "none",
  },
  {
    name: "update_mutex_group",
    description:
      "Update a mutex group (name / maxConcurrentPerDevice / scope / description). Takes effect on the next dispatch — tightening scope to global or lowering maxConcurrentPerDevice immediately restricts production concurrency.",
    parameters: {
      type: "object",
      properties: {
        groupId: uuid("Mutex group ID"),
        name: str("New group name (unique)"),
        maxConcurrentPerDevice: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "New per-device concurrency (1-100)",
        },
        scope: {
          type: "string",
          enum: ["device", "global"],
          description: "New scope: device | global",
        },
        description: str("New description (max 500 chars)"),
      },
      required: ["groupId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "none",
  },
  {
    name: "delete_mutex_group",
    description:
      "Delete a mutex group. IRREVERSIBLE and affects production: attached applications silently lose the mutual-exclusion constraint (mutexGroupId is nulled), so workloads that must never overlap can start colliding. The backend refuses with 409 while apps are still attached unless force=true.",
    parameters: {
      type: "object",
      properties: {
        groupId: uuid("Mutex group ID"),
        force: {
          type: "boolean",
          description:
            "Delete even when applications are still attached (they silently lose the constraint)",
        },
      },
      required: ["groupId"],
      additionalProperties: false,
    },
    tier: "dangerous",
    resourceKind: "none",
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
    /** 03 §2：影响在跑部署需审批。 */
    approvalRequired: true,
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
    /** 03 §2：停掉在跑应用需审批。 */
    approvalRequired: true,
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

/**
 * 内部工具（设计文档 03 §4 + 10 §调整2）：Agent 专属能力，mcp-server 不
 * 暴露——它们是「Agent 的能力」，不是「外部 AI 管理 AutoCodeFlow」的能力。
 *
 * ## 为什么独立成表而不是塞进 AGENT_TOOL_SPECS
 * AGENT_TOOL_SPECS 是 mcp-server 工具的**收编镜像**（当前 56 → 纳管 47，
 * 差额在 `scripts/agent-boundary-check.mjs` 的显式排除清单里逐项声明）。
 * 内部工具进同一数组会打破「纳管集合只放 mcp 工具」这个不变量。分表后：
 * 边界检查只对 AGENT_TOOL_SPECS 断言，内部工具数量自由生长（07 §7 之后还会
 * 加），两者最终在 ALL_AGENT_TOOL_SPECS 合流，闸门与 LLM 都只见合流后的全集。
 *
 * ## P5 的 6 个 SOP 工具（03 §4）
 * sop_publish 默认需审批（发布权 = 间接指令注入权，04 §4.3）；澄清场景的
 * 小版本修订走 sop_reply_clarification 自主路径（04 §4.3：后续小版本可配
 * 自主）——但仍然过与人工发布同一道严格校验 + 不可变快照。
 */
export const AGENT_INTERNAL_TOOL_SPECS: readonly AgentToolSpec[] = [
  {
    name: "sop_list",
    description:
      "List SOPs with slug, title, status (draft|published|deprecated), currentVersion.",
    parameters: {
      type: "object",
      properties: {
        ...pagination,
        status: str("Filter by status: draft | published | deprecated"),
      },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "none",
  },
  {
    name: "sop_get",
    description:
      "Get one SOP by id or slug: front-matter (machine contract: target/capabilities/acceptance/constraints) + body markdown.",
    parameters: {
      type: "object",
      properties: {
        sopId: uuid("SOP id (either sopId or slug)"),
        slug: str("SOP slug (either sopId or slug)"),
      },
      additionalProperties: false,
    },
    tier: "read",
    resourceKind: "sop",
    resourceIdParam: "sopId",
  },
  {
    name: "sop_draft",
    description:
      "Create or update a SOP draft: slug, title, frontMatterYaml (machine contract), bodyMarkdown. Drafts are NOT executable until published.",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,127}$",
          description:
            "Machine-readable slug, lowercase letters/digits/hyphens",
        },
        title: str("Human-readable title"),
        frontMatterYaml: {
          type: "string",
          description:
            "YAML front-matter (machine contract). Parsed and validated; unknown keys rejected at publish.",
        },
        bodyMarkdown: {
          type: "string",
          description: "Markdown body for humans/LLM",
        },
      },
      required: ["slug", "title"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "none",
  },
  {
    name: "sop_publish",
    description:
      "Publish a SOP version (strict validation + immutable snapshot + contentHash). Requires human approval — publishing grants instruction authority over executor agents.",
    parameters: {
      type: "object",
      properties: {
        sopId: uuid("SOP id"),
        bump: {
          type: "string",
          enum: ["patch", "minor", "major"],
          description: "Version bump (default patch; first publish is 1.0.0)",
        },
        changelog: str("What changed in this version"),
      },
      required: ["sopId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "sop",
    resourceIdParam: "sopId",
    /** 发布权 = 指令注入权（04 §4.3）——默认审批，不随全局写策略放宽。 */
    approvalRequired: true,
  },
  {
    name: "sop_assign",
    description:
      "Assign a published SOP version to an executor (agent:sop capable). Creates an assignment ticket the executor pulls via agent-collab poll.",
    parameters: {
      type: "object",
      properties: {
        sopId: uuid("SOP id"),
        version: str("Version (default: currentVersion)"),
        executorId: uuid(
          "Target executor id (either executorId or executorAddress)",
        ),
        executorAddress: str(
          "Target executor address (either executorId or executorAddress)",
        ),
      },
      required: ["sopId"],
      additionalProperties: false,
    },
    tier: "write",
    resourceKind: "sop",
    resourceIdParam: "sopId",
  },
  {
    name: "sop_reply_clarification",
    description:
      "Reply to an executor-agent clarification. resolution: answered | sop_amended (provide amended content; publishes a new patch version autonomously) | escalated_to_human.",
    parameters: {
      type: "object",
      properties: {
        clarificationId: str("Clarification id to reply to"),
        resolution: {
          type: "string",
          enum: ["answered", "sop_amended", "escalated_to_human"],
          description: "How the clarification is resolved",
        },
        answer: str("Reply text (goes back to the executor agent)"),
        amendedFrontMatterYaml: {
          type: "string",
          description:
            "Required when resolution=sop_amended (if contract changed)",
        },
        amendedBodyMarkdown: {
          type: "string",
          description: "Required when resolution=sop_amended (if body changed)",
        },
        changelog: str("Change note for the amended version"),
      },
      required: ["clarificationId", "resolution", "answer"],
      additionalProperties: false,
    },
    tier: "write",
    // resourceKind=none：clarificationId 不是 scope 白名单的资源键，闸门的
    // 交叉验证不适用。但回复权 = 修订权（sop_amended 自主发版）——归属校验
    // 在工具执行体入口补齐（ToolExecutorService，B-3）：仅限本会话复核的
    // 澄清，或澄清所属 SOP ∈ 会话 scope.sops 白名单。
    resourceKind: "none",
  },
];

/** 闸门与 LLM 可见的全集：47 收编 + 6 内部工具（设计文档 10 §调整2）。 */
export const ALL_AGENT_TOOL_SPECS: readonly AgentToolSpec[] = [
  ...AGENT_TOOL_SPECS,
  ...AGENT_INTERNAL_TOOL_SPECS,
];

/** 按名字索引（O(1) 查表，闸门每次调用都要查）。 */
export const AGENT_TOOL_BY_NAME: ReadonlyMap<string, AgentToolSpec> = new Map(
  ALL_AGENT_TOOL_SPECS.map((t) => [t.name, t]),
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
    ops_watch: ALL_AGENT_TOOL_SPECS.filter((t) => t.tier === "read").map(
      (t) => t.name,
    ),

    /**
     * 事件处置：只读 + 有限的收敛性写操作（触发/重试/暂停/终止）。
     * 刻意**不含** update_task / delete_* / approve_*——故障处置场景下
     * 改配置与审批应由人来决定。
     */
    incident: ALL_AGENT_TOOL_SPECS.filter(
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

    /**
     * SOP 起草：读 + SOP 工具（起草/发布/指派）+ 建应用/建任务/部署
     * （部署仍需审批；sop_publish 逐工具默认审批——发布权 = 间接指令注入权）。
     * MUTEX-01：含 create_mutex_group——起草「独占型资源」编排（浏览器实例/
     * 单点登录账号）时需要先建组再挂应用；建组本身不改任何既有应用行为。
     */
    sop_authoring: ALL_AGENT_TOOL_SPECS.filter(
      (t) =>
        t.tier === "read" ||
        [
          "create_application",
          "create_mutex_group",
          "create_task_from_template",
          "deploy_application",
          "deploy_app",
          "trigger_task",
          "sop_draft",
          "sop_publish",
          "sop_assign",
        ].includes(t.name),
    ).map((t) => t.name),

    /**
     * SOP 复核（P6 澄清循环 + 交付复核）：读（含 sop_get/sop_list——复核
     * 要先读 SOP）+ 澄清回复 + trigger_task（04 §3 ⑤ 独立验证——执行器
     * 回报「完成」不等于真成功，中台按 acceptance kind=platform 真跑一次；
     * 可触发的任务被会话 scope 的 tasks 集合收窄）。**没有**
     * sop_draft/sop_publish——修订只经 sop_reply_clarification 的受控路径
     * （发 patch 版本），不给复核会话自由发布权。
     */
    sop_review: ALL_AGENT_TOOL_SPECS.filter(
      (t) =>
        t.tier === "read" ||
        t.name === "sop_reply_clarification" ||
        t.name === "trigger_task",
    ).map((t) => t.name),

    /**
     * 应用脚手架（P5/P7）：建应用/建任务/部署，外加 MUTEX-01 的建组
     * （脚手架一个需要独占资源的应用时，先建互斥组再挂上去）。
     */
    app_scaffold: ALL_AGENT_TOOL_SPECS.filter(
      (t) =>
        t.tier === "read" ||
        [
          "create_application",
          "create_mutex_group",
          "create_task_from_template",
          "deploy_application",
          "deploy_app",
          "trigger_task",
        ].includes(t.name),
    ).map((t) => t.name),

    /** 人工对话：不限工具（管理员与 Agent 对话，等价于管理员自己在操作）。 */
    chat: null,
  };

/**
 * MUTEX-01 闸门姿态（为什么 update/delete_mutex_group 不在任何自动化会话白名单里）：
 *
 * 只有 `chat`（管理员直接对话，等价于本人操作）能改档或删组，四个自动化
 * 会话类型都拿不到——理由与 `incident` 排除 update_task/delete_* 同源：
 *
 *   · `update_mutex_group` 收紧 scope/maxConcurrentPerDevice 会**立即限制**
 *     在跑业务的并发度（可能让本可并行的负载排队）；
 *   · `delete_mutex_group` 更重——挂载应用经 FK 静默解除互斥，本该串行的
 *     独占型负载（浏览器实例/单点登录顶号）会开始相撞。
 *
 * 两者都是「人该拍板」的语义变更，而不是故障处置中的收敛性动作（对比
 * kill/pause/resume 那种"往安全方向收敛"的写操作）。建组（create）与读组
 * （list）则无此顾虑：前者不改任何既有应用行为，后者纯读。
 */

/** 取会话类型的可用工具集。未登记的类型 → 空集（拒绝一切，安全默认）。 */
export function toolsForSessionKind(kind: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(SESSION_TOOL_ALLOWLIST, kind)
    ? SESSION_TOOL_ALLOWLIST[kind]
    : [];
}
