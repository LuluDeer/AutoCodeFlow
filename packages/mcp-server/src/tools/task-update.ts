/**
 * update_task（1 个工具）**与它的参数 schema 声明**。schema 是 308 行**声明**（不是逻辑），留在函数体里会让函数体超 300 行阈值（硬 error）；因此整段**字段行逐字节**提到同文件的常量里，server.tool 的实参位置换成常量名。
 *
 * R6「工具清单化」第 2 批（2026-11-04）从 `tools.ts` **整体搬出**：`server.tool`
 * 调用块逐字节未改（name / description / 入参 schema / 注解 / handler 都保持原样），
 * 只是换了个文件。
 *
 * 搬迁纪律：**块逐字节搬移**，不重排、不改写、不「顺手优化」。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BLOCK_STRATEGY,
  EXECUTE_MODE,
  JSON_CONTENT,
  JSON_ERROR,
  MAINTENANCE_WINDOW_ITEM,
  MISFIRE_STRATEGY,
  TASK_NAME_MAX_LENGTH,
  TASK_PRIORITY,
  TASK_RUNTIME,
  TASK_STATUS,
  TASK_TRIGGER_TYPE,
  TIMEOUT_ACTION,
  UUID_PATH_ID,
  rejectRedactionSentinel,
  taskParamsWithinLimits,
  taskSecretsMap,
  textWithin,
} from "./shared";
import type { ApiCall } from "./shared";

const UPDATE_TASK_SCHEMA = {
      taskId: UUID_PATH_ID.describe("Task ID to update"),
      // R111-A1 上限出处：CreateTaskDto.name 的 @IsTaskName()
      // （apps/admin-api/src/modules/task/dto/create-task.dto.ts:66-69）→
      // TASK_NAME_MAX_LENGTH=255（同目录 task-name.constraint.ts:43，按**码点**计）。
      // UpdateTaskDto 是 PartialType(CreateTaskDto)，PATCH 继承同一 255。
      name: textWithin(TASK_NAME_MAX_LENGTH).optional().describe(
        "New task name (max 255 chars — the backend's IsTaskName limit)",
      ),
      // R111-A1：**后端无约束**（create-task.dto.ts:70 只有 @IsString/@IsOptional，
      // tasks.description 列也无长度，task.entity.ts:136）——2000 是本侧**客户端保护**，
      // 刻意不假称与后端对齐（口径取本仓既有 2KB 文本闸：PublishSopDto.changelog）。
      description: textWithin(2000).optional().describe(
        "New task description (max 2000 chars — client-side cap; the backend imposes none)",
      ),
      status: TASK_STATUS.optional().describe(
        "Task status: active | paused | deleted",
      ),
      triggerType: TASK_TRIGGER_TYPE.optional().describe(
        "Trigger type: cron | fixed_rate | api | manual",
      ),
      cronExpression: z
        .string()
        .optional()
        .describe("Cron expression (5 fields) for cron triggers"),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone for cron schedules, e.g. Asia/Shanghai"),
      fixedRate: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Fixed interval in seconds for fixed_rate triggers"),
      runtime: TASK_RUNTIME.optional().describe(
        "Runtime type: python | node | shell (backend enum — other values are rejected with 400)",
      ),
      entrypoint: z
        .string()
        .optional()
        .describe("Entry point file path relative to the repo root"),
      // MCP-DTO-ALIGN：timeout（遗留字段，create-task.dto.ts:184-192）此前
      // 整体缺失——@IsInt @Min(0) @Max(86400)，0 = 不限制；与 timeoutSeconds
      // 同值域（后端把 timeoutSeconds 归一化到 timeout）。
      timeout: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .optional()
        .describe(
          "Execution timeout in seconds (legacy field — prefer timeoutSeconds; 0 = no limit; backend accepts 0-86400)",
        ),
      // MCP-DTO-ALIGN：timeoutSeconds 补上界 max(86400)（此前只写 min(0)，
      // 缺失的 .max 让 >86400 的值原样上送、被后端 @Max(86400) 400——与描述
      // 文案"backend accepts 0-86400"不符）。对齐 create-task.dto.ts:197-201。
      timeoutSeconds: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .optional()
        .describe(
          "Execution timeout in seconds (0 = no limit; backend accepts 0-86400)",
        ),
      // CORE-04（create-task.dto.ts:209-216）：null/缺省 = kill；显式 null 重置。
      timeoutAction: TIMEOUT_ACTION
        .nullable()
        .optional()
        .describe(
          'Timeout action: kill (default — executor kills the process tree) | kill_retry (kill + re-enqueue once within retry budget) | notify_only (admin only notifies, executor-side hard timeout still applies). Omit = keep current value; explicit null = reset to kill.',
        ),
      // CORE-04（create-task.dto.ts:226-230）：百分数 0-90；null = 未启用。
      timeoutWarnRatio: z
        .number()
        .int()
        .min(0)
        .max(90)
        .nullable()
        .optional()
        .describe(
          "Timeout early-warning threshold: integer percent (0-90) of timeout. One WARNING notification fires when runtime reaches timeout×ratio/100 (at most once per execution). Omit = keep; explicit null = disable.",
        ),
      // CORE-05（create-task.dto.ts:246-254）：0/缺省 = 未知；null = 重置为未知。
      estimatedDurationSec: z
        .number()
        .int()
        .min(0)
        .max(604800)
        .nullable()
        .optional()
        .describe(
          "Estimated execution duration in seconds (0/omitted = unknown; 0-604800). Only feeds scheduler executor load scoring — never consumed by the execution path. Explicit null = reset to unknown.",
        ),
      maxRetry: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Max retry attempts (0-10)"),
      // A4 乐观锁（update-task.dto.ts:22-29）：透传 + 409 语义写在 description。
      expectedUpdatedAt: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optimistic lock: the task's updatedAt (ISO timestamp) you read before editing. When present, the backend rejects the update with 409 TASK_UPDATE_STALE if the stored row moved (someone else updated first); re-fetch via get_task and retry. Omitted/null = skip the check (last write wins).",
        ),
      executeMode: EXECUTE_MODE.optional().describe(
        "Dispatch mode: single | broadcast. broadcast fans out to all online executors and cannot be combined with executorId.",
      ),
      // A4（第三轮审计·中）/ N-14（create-task.dto.ts:260-279 语义）。
      blockStrategy: BLOCK_STRATEGY
        .nullable()
        .optional()
        .describe(
          'Re-trigger policy while a same-params run is active: serial (queue, default) | discard (skip this trigger) | cover_early (cancel the running execution and rerun). null = legacy rows default to serial.',
        ),
      misfireStrategy: MISFIRE_STRATEGY
        .nullable()
        .optional()
        .describe(
          "Misfire policy when the scheduler was down at fire time: ignore (skip, default) | fire_once (fire once on recovery).",
        ),
      // CORE-01：数字 1-4 或大写 label（@IsEnum 的经验接受面，见 TASK_PRIORITY 注释）。
      priority: TASK_PRIORITY.optional().describe(
        "Task priority: 1 (LOW) | 2 (NORMAL, default) | 3 (HIGH) | 4 (CRITICAL) — integers, or the uppercase labels LOW/NORMAL/HIGH/CRITICAL. Lowercase labels and numeric strings are rejected (backend @IsEnum).",
      ),
      executorId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Pin the task to this executor ID (uuid). Pass null to remove an existing pin. Mutually exclusive with executeMode=broadcast.",
        ),
      executorGroup: z
        .string()
        .optional()
        .describe("Restrict auto-dispatch to executors in this group"),
      executorTags: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict auto-dispatch to executors carrying all these tags",
        ),
      // R115：同 trigger_task —— 后端 65536 字节上限。
      params: taskParamsWithinLimits().optional().describe("Default runtime parameters"),
      applicationId: z
        .string()
        .optional()
        .describe("Associated application ID"),
      // ---------------------------------------------------------------------------
      // MCP-DTO-ALIGN（2026-10-25）：以下 9 个字段上轮登记缺失，值域逐字对齐
      // CreateTaskDto（PartialType 传播到 UpdateTaskDto）。null 语义照抄 DTO：
      // 可空列显式 null = 清除/重置，缺省 = 保留旧值（N28）。
      // ---------------------------------------------------------------------------
      // SEC-02（create-task.dto.ts:292-321）：逐键合并语义在后端，这里只校键名。
      secrets: taskSecretsMap()
        .nullable()
        .optional()
        .describe(
          'Task-level secrets (credential key/value pairs, separate from params; stored encrypted, read back masked as "******"). Per-key merge on PATCH: omit a key or keep its "******" value to preserve it, null a key to delete it, any other value overwrites; the whole field as explicit null clears all secrets. Dispatched both merged into params as AUTOFLOW_<KEY> (legacy channel) and as a standalone secrets payload injected under the original key names.',
        ),
      // FEAT-06（create-task.dto.ts:94-112）：≤10 条；null/[] = 清空窗口。
      maintenanceWindows: z
        .array(MAINTENANCE_WINDOW_ITEM)
        .max(10)
        .nullable()
        .optional()
        .describe(
          "Task-level maintenance windows: scheduled triggers falling inside a window are skipped (manual/API triggers unaffected). Each item {start, end, description?} uses 5-field cron; the window opens at the latest start-cron fire and closes at the latest end-cron fire (half-open). At most 10 items; explicit null or [] clears all windows.",
        ),
      // W-21（create-task.dto.ts:148-158）：≤50 条非空；服务层拒前导 '-'。
      requirements: z
        .array(z.string().min(1))
        .max(50)
        .nullable()
        .optional()
        .describe(
          'Dependency specs the executor installs before running (python: per-task uv venv; node: npm packages), e.g. ["requests>=2.31", "rich==13.7.1"]. Ignored for GLUE tasks. At most 50 non-empty strings; specs with a leading "-" are rejected. Explicit null = clear.',
        ),
      // FIX-1.1（create-task.dto.ts:159-178）：value 才是依赖任务 id。
      dependencies: z
        .record(z.string(), z.string())
        .nullable()
        .optional()
        .describe(
          "Upstream task dependencies: { display-name: upstream-task-id } — the VALUE is the dependency task id (consumed by cycle detection / dependency fan-out). Every value must be an existing task id; self-dependency and cycles are rejected. Explicit null = clear.",
        ),
      // NF-04（create-task.dto.ts:334-350）：OR 亲和；null/[] = 清除。
      executorAffinityTags: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Executor tag affinity (OR semantics — executors holding ANY of these tags are candidates, then load-scored). Orthogonal to executorTags (hard AND capability requirement). Explicit null/[] clears.",
        ),
      // NF-04（create-task.dto.ts:351-366）：排除语义；null/[] = 清除。
      executorAntiAffinityTags: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Executor tag anti-affinity (exclusion — executors holding ANY of these tags are excluded). Applies to single and broadcast dispatch; combined with affinity, anti-affinity subtracts from the affinity hit set. Explicit null/[] clears.",
        ),
      // FEAT-22（create-task.dto.ts:322-330）：strict/prefer；null = 跟随全局。
      deploymentPolicy: z
        .enum(["strict", "prefer"])
        .nullable()
        .optional()
        .describe(
          "Task-level dispatch deployment override: strict restricts candidates to executors explicitly deployed with the bound app (queues as WAITING when none can take it); prefer keeps the soft preference. null/omitted = follow the global executor.deploymentPolicy. Priority chain: executorId pin > executorAppName > deployment constraint > whole cluster.",
        ),
      // F1（本轮审计）：CreateTaskDto 有、而本 shape 缺的 7 个字段 —— PATCH
      // （update_task）是本包唯一能**就地改**任务定义字段的入口，缺一个就等于
      // 那件事"调了、成功了、没发生"。本包**没有** create_task（创建只能走
      // create_task_from_template / import_task）；rollback_task_version 把定义
      // 回滚到历史版本；trigger_task / pause_task / resume_task 改的是运行态
      // 与开关，不改定义字段。逐个对齐 DTO 的约束：
      //   runtimeVersion: /^\d+\.\d+$/（仅 runtime=python 有意义）
      //   retryDelay: 整数 0..86400（更大值会把指数退避顶到 int32 毫秒溢出线）
      //   retryableErrors / alarmChannels: 字符串数组，**元素不得含逗号**
      //     （simple-array 列以逗号 join 落库，含逗号会在读回时被劈成两条）
      //   codeSource: git | glue | application_zip；显式 null = 清除声明
      //   runbook: markdown 运维手册（随失败通知一并附上）
      //   projectId: uuid 或 null（null = 未分配；设置它会改任务归属与可见范围）
      runtimeVersion: z
        .string()
        .regex(/^\d+\.\d+$/, 'must be "major.minor" (e.g. 3.12)')
        .optional()
        .describe(
          "Python interpreter version as major.minor (e.g. 3.12). Only meaningful when runtime=python.",
        ),
      retryDelay: z
        .number()
        .int()
        .min(0)
        .max(86_400)
        .optional()
        .describe("Delay before a retry, in seconds (0..86400)."),
      retryableErrors: z
        .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
        .optional()
        .describe(
          "Substrings that mark a failure as retryable. Elements must not contain commas (simple-array storage splits on commas).",
        ),
      alarmChannels: z
        .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
        .optional()
        .describe(
          "Alarm channels notified on failure. Elements must not contain commas.",
        ),
      codeSource: z
        .enum(["git", "glue", "application_zip"])
        .nullable()
        .optional()
        .describe(
          "Code source channel: git | glue | application_zip (application_zip also needs applicationId). Mutually exclusive with gitRepo/glueSource. Explicit null clears the declaration.",
        ),
      runbook: z
        .string()
        .optional()
        .describe(
          "Markdown runbook shown on the task page and attached to failure notifications.",
        ),
      projectId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe(
          "Owning project id (null = unassigned). Changing it changes the task's visibility and write authorisation scope.",
        ),
};

export function registerTaskUpdateTools(server: McpServer, call: ApiCall): void {
  // ---- update_task ---------------------------------------------------------
  server.tool(
    "update_task",
    'Update an existing task via PATCH (only the fields you pass are changed; explicit null clears nullable fields). Supports executor pinning: set executorId to pin the task to one executor (fails fast if it is offline), or pass executorId: null to clear the pin. executorId is mutually exclusive with executeMode="broadcast" — the backend rejects that combination with 400. Also supports task-level secrets (per-key merge; leaf "******" keeps the stored value, null deletes the key), maintenance windows, priority (1-4), timeout policy (timeoutSeconds/timeoutAction/timeoutWarnRatio), dependency requirements, upstream task dependencies (map display-name → upstream task id), block/misfire strategies, executor affinity tags, deployment policy, and expectedUpdatedAt optimistic locking (409 on conflict).',
    UPDATE_TASK_SCHEMA,
    { destructiveHint: true, idempotentHint: true },
    async ({ taskId, ...fields }) => {
      // Drop undefined fields so PATCH only touches what the caller supplied;
      // keep explicit nulls (e.g. executorId: null) so a pin can be cleared.
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      // 空 patch = 必然空转（后端对 `{}` 返回 200 并落一条 task.update 审计）。
      // 与其让 agent 以为改完了，不如明确失败并列出可写字段。
      if (Object.keys(body).length === 0) {
        return JSON_ERROR({
          error: "NO_UPDATABLE_FIELDS",
          message:
            "update_task received no updatable field, so nothing would change. " +
            "Pass at least one of: name, cronExpression, timezone, fixedRate, maintenanceWindows, " +
            "runtime, runtimeVersion, requirements, dependencies, timeout, timeoutSeconds, " +
            "timeoutAction, timeoutWarnRatio, maxRetry, retryDelay, estimatedDurationSec, " +
            "retryableErrors, priority, executeMode, blockStrategy, misfireStrategy, alarmChannels, " +
            "params, secrets, deploymentPolicy, executorTags, executorAffinityTags, " +
            "executorAntiAffinityTags, executorId, codeSource, runbook, projectId, status.",
        });
      }
      const redacted = rejectRedactionSentinel(body, "update_task");
      if (redacted) return redacted;
      const data = await call<unknown>("PATCH", `/tasks/${taskId}`, body);
      return JSON_CONTENT(data);
    },
  );

}
