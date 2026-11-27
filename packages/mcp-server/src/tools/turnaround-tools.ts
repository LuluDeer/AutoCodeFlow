/**
 * High-leverage core tools (6 tools):
 *   - create_task
 *   - delete_task
 *   - list_artifacts
 *   - send_agent_message
 *   - cancel_agent_session
 *   - decide_agent_approval
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BLOCK_STRATEGY,
  DEPLOYMENT_ENV_VALUE_MAX_BYTES,
  EXECUTE_MODE,
  JSON_CONTENT,
  MAINTENANCE_WINDOW_ITEM,
  MISFIRE_STRATEGY,
  TASK_FIXED_RATE_MAX_SECONDS,
  TASK_NAME_MAX_LENGTH,
  TASK_PRIORITY,
  TASK_RUNTIME,
  TASK_TRIGGER_TYPE,
  TIMEOUT_ACTION,
  TASK_STATUS,
  UUID_PATH_ID,
  rejectRedactionSentinel,
  taskParamsWithinLimits,
  taskSecretsMap,
  textWithin,
} from "./shared";
import type { ApiCall } from "./shared";

const ARTIFACT_EXTENSION = z.enum([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
  "zip",
  "json",
  "txt",
  "log",
  "md",
  "csv",
  "xlsx",
  "html",
]);

const SAFE_APPROVAL_KEY = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "approvalKey may only contain alphanumeric characters and . _ : -",
  );

const CREATE_TASK_SCHEMA = {
  name: textWithin(TASK_NAME_MAX_LENGTH).describe(
    "Unique task name (max 255 chars — backend IsTaskName limit)",
  ),
  // CreateTaskDto defaults new tasks to paused; expose status so an agent can
  // create an active task in one call instead of create + resume.
  status: TASK_STATUS.optional().describe(
    "Initial task status: active | paused | deleted (backend default: paused)",
  ),
  triggerType: TASK_TRIGGER_TYPE.describe(
    "Trigger type: cron | fixed_rate | api | manual",
  ),
  description: textWithin(2000)
    .optional()
    .describe("Task description (max 2000 chars)"),
  cronExpression: z
    .string()
    .optional()
    .describe(
      "5-field cron expression (required when triggerType=cron, e.g. '0 2 * * *')",
    ),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone for cron schedules, e.g. Asia/Shanghai"),
  fixedRate: z
    .number()
    .int()
    .min(1)
    .max(2_147_483)
    .optional()
    .describe(
      "Fixed interval in seconds (required when triggerType=fixed_rate; 1-2147483)",
    ),
  runtime: TASK_RUNTIME.optional().describe(
    "Runtime type: python | node | shell",
  ),
  runtimeVersion: z
    .string()
    .regex(/^\d+\.\d+$/, 'must be "major.minor" (e.g. 3.12)')
    .optional()
    .describe(
      "Python interpreter version as major.minor (e.g. 3.12); only meaningful when runtime=python",
    ),
  entrypoint: z
    .string()
    .optional()
    .describe("Entrypoint script path relative to the repo/app root"),
  codeSource: z
    .enum(["git", "glue", "application_zip"])
    .optional()
    .describe("Code source: git | glue | application_zip"),
  glueSource: z
    .string()
    .optional()
    .describe("Inline script source when codeSource=glue"),
  // Legacy timeout field shares timeoutSeconds' backend range and is
  // normalised to the same value by admin-api.
  timeout: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .optional()
    .describe("Legacy execution timeout in seconds (0 = no limit; 0-86400)"),
  timeoutSeconds: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .optional()
    .describe("Execution timeout in seconds (0 = no limit; 0-86400)"),
  timeoutAction: TIMEOUT_ACTION.nullable().optional().describe(
    "Timeout action: kill | kill_retry | notify_only (null = backend default kill)",
  ),
  timeoutWarnRatio: z
    .number()
    .int()
    .min(0)
    .max(90)
    .nullable()
    .optional()
    .describe("Timeout early-warning threshold percentage (0-90)"),
  maxRetry: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Max retry attempts (0-10)"),
  retryDelay: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .optional()
    .describe("Base retry delay in seconds (0-86400)"),
  // CORE-05: scheduler load-score hint only; does not affect execution.
  estimatedDurationSec: z
    .number()
    .int()
    .min(0)
    .max(604800)
    .nullable()
    .optional()
    .describe(
      "Estimated execution duration in seconds (0/omitted = unknown; 0-604800); only feeds executor load scoring",
    ),
  // simple-array columns reject comma-containing elements: reading them back
  // would silently split one entry into several.
  retryableErrors: z
    .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
    .optional()
    .describe(
      "Substrings that mark a failure as retryable; elements must not contain commas",
    ),
  alarmChannels: z
    .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
    .optional()
    .describe("Alarm channels notified on failure; elements must not contain commas"),
  executeMode: EXECUTE_MODE.optional().describe(
    "Dispatch mode: single | broadcast (broadcast cannot be combined with executorId)",
  ),
  blockStrategy: BLOCK_STRATEGY.nullable().optional().describe(
    "Re-trigger policy while active: serial | discard | cover_early (null = legacy serial)",
  ),
  misfireStrategy: MISFIRE_STRATEGY.nullable().optional().describe(
    "Misfire policy on scheduler recovery: ignore | fire_once (null = default ignore)",
  ),
  priority: TASK_PRIORITY.optional().describe(
    "Task priority: 1 (LOW) | 2 (NORMAL) | 3 (HIGH) | 4 (CRITICAL) or uppercase label",
  ),
  executorId: UUID_PATH_ID.optional().describe(
    "Pin the task to a specific executor ID (UUID)",
  ),
  executorGroup: z
    .string()
    .optional()
    .describe("Restrict auto-dispatch to executors in this group"),
  executorTags: z
    .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
    .optional()
    .describe("Restrict auto-dispatch to executors carrying all these tags"),
  // NF-04: OR affinity / anti-affinity, orthogonal to executorTags.
  executorAffinityTags: z
    .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
    .nullable()
    .optional()
    .describe(
      "Executor tag affinity (OR semantics: any listed tag makes an executor a candidate); null/[] clears",
    ),
  executorAntiAffinityTags: z
    .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
    .nullable()
    .optional()
    .describe(
      "Executor tag anti-affinity (exclusion: executors with any listed tag are excluded); null/[] clears",
    ),
  applicationId: UUID_PATH_ID.optional().describe(
    "Associated application ID (UUID)",
  ),
  projectId: UUID_PATH_ID.optional().describe(
    "Project ID (UUID) for ownership and visibility scoping",
  ),
  params: taskParamsWithinLimits()
    .optional()
    .describe("Default runtime parameters object (max 65536 UTF-8 bytes)"),
  secrets: taskSecretsMap()
    .optional()
    .describe("Task-level encrypted secrets (key/value pairs)"),
  requirements: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Dependency specs installed before running (pip/npm, max 50)"),
  dependencies: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Upstream task dependencies: { displayName: upstreamTaskId } — the VALUE is the dependency task id",
    ),
  runOnUpstreamFailure: z
    .boolean()
    .optional()
    .describe("Also trigger when an upstream dependency ends in a failure terminal state (default false)"),
  maintenanceWindows: z
    .array(MAINTENANCE_WINDOW_ITEM)
    .max(10)
    .optional()
    .describe("Task-level maintenance windows (max 10 items)"),
  deploymentPolicy: z
    .enum(["strict", "prefer"])
    .nullable()
    .optional()
    .describe("Task-level dispatch deployment policy: strict | prefer (null = follow global policy)"),
  runbook: z
    .string()
    .optional()
    .describe("Markdown runbook attached to failure alerts"),
};

export function registerTurnaroundTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- create_task ----------------------------------------------------------
  server.tool(
    "create_task",
    "Create a new scheduled or on-demand task (POST /tasks). Required fields: name (unique across all tasks, max 255 chars) and triggerType (cron | fixed_rate | api | manual). Provide cronExpression when triggerType=cron, or fixedRate (seconds) when triggerType=fixed_rate. Default status is paused; pass status=active to schedule immediately. Payloads containing the [redacted] sentinel are rejected before POST.",
    CREATE_TASK_SCHEMA,
    { destructiveHint: false },
    async (fields) => {
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const blocked = rejectRedactionSentinel(body, "create_task");
      if (blocked) return blocked;
      const data = await call<unknown>("POST", "/tasks", body);
      return JSON_CONTENT(data);
    },
  );

  // ---- delete_task ----------------------------------------------------------
  server.tool(
    "delete_task",
    "Soft-delete a task by ID (DELETE /tasks/:id). Any currently running executions of this task are force-terminated. This action is irreversible.",
    {
      taskId: UUID_PATH_ID.describe("Task ID (UUID) to delete"),
    },
    { destructiveHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("DELETE", `/tasks/${taskId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- list_artifacts -------------------------------------------------------
  server.tool(
    "list_artifacts",
    "List execution artifacts. When executionId is provided, returns that execution's artifact manifest (GET /tasks/executions/:execId/artifacts). Otherwise queries the cross-execution artifact index (GET /artifacts) with optional filters (taskId, applicationId, q, ext, from, to, mine, page, pageSize).",
    {
      executionId: UUID_PATH_ID.optional().describe(
        "Execution ID (UUID). When provided, returns that execution's artifact manifest directly.",
      ),
      taskId: UUID_PATH_ID.optional().describe(
        "Filter artifact index by task ID (UUID)",
      ),
      applicationId: UUID_PATH_ID.optional().describe(
        "Filter artifact index by application ID (UUID)",
      ),
      q: textWithin(100)
        .optional()
        .describe("Filename substring filter (case-insensitive, max 100 chars)"),
      ext: ARTIFACT_EXTENSION.optional().describe(
        "Filter by lowercase file extension without dot (e.g. json, csv, png, log)",
      ),
      from: z
        .string()
        .optional()
        .describe("ISO-8601 lower bound for createdAt (inclusive)"),
      to: z
        .string()
        .optional()
        .describe("ISO-8601 upper bound for createdAt (inclusive)"),
      mine: z
        .boolean()
        .optional()
        .describe("When true, only include artifacts for tasks owned by the caller"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number for index queries (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page for index queries (default 20, max 100)"),
    },
    { readOnlyHint: true },
    async ({
      executionId,
      taskId,
      applicationId,
      q,
      ext,
      from,
      to,
      mine,
      page,
      pageSize,
    }) => {
      if (executionId) {
        const data = await call<unknown>(
          "GET",
          `/tasks/executions/${executionId}/artifacts`,
        );
        return JSON_CONTENT(data);
      }
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(taskId ? { taskId } : {}),
        ...(applicationId ? { applicationId } : {}),
        ...(q ? { q } : {}),
        ...(ext ? { ext } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(mine ? { mine: "true" } : {}),
      });
      const data = await call<unknown>("GET", `/artifacts?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- send_agent_message ---------------------------------------------------
  server.tool(
    "send_agent_message",
    "ADMIN only. Send a user message to an agent session (POST /agent/sessions/:id/messages). Mode followup (default) queues the next user turn; mode steer injects at the next step boundary. Appends the message and drives/resumes execution according to the session state.",
    {
      sessionId: UUID_PATH_ID.describe("Agent session ID (UUID)"),
      content: textWithin(8000)
        .refine((v) => v.trim().length > 0, {
          message: "content must not be empty",
        })
        .describe("Non-empty message content to send to the agent session (max 8000 chars)"),
      mode: z
        .enum(["followup", "steer"])
        .optional()
        .describe(
          "Delivery mode: followup (default; queue as the next user turn) | steer (inject at the next step boundary)",
        ),
    },
    { destructiveHint: false },
    async ({ sessionId, content, mode }) => {
      const body = { content, ...(mode ? { mode } : {}) };
      const blocked = rejectRedactionSentinel(body, "send_agent_message");
      if (blocked) return blocked;
      const data = await call<unknown>(
        "POST",
        `/agent/sessions/${sessionId}/messages`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- cancel_agent_session -------------------------------------------------
  server.tool(
    "cancel_agent_session",
    "ADMIN only. Cancel an active or waiting agent session (POST /agent/sessions/:id/cancel). Stops further agent steps and marks the session aborted/cancelled. The endpoint accepts no body.",
    {
      sessionId: UUID_PATH_ID.describe("Agent session ID (UUID) to cancel"),
    },
    { destructiveHint: true },
    async ({ sessionId }) => {
      const data = await call<unknown>(
        "POST",
        `/agent/sessions/${sessionId}/cancel`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- decide_agent_approval ------------------------------------------------
  server.tool(
    "decide_agent_approval",
    "ADMIN only. Grant or deny a pending agent tool approval (POST /agent/sessions/:id/approvals/:approvalKey/grant or /deny). Granting resumes a waiting_input session once no other approvals remain pending; four-eyes rules may block self-approval.",
    {
      sessionId: UUID_PATH_ID.describe("Agent session ID (UUID)"),
      approvalKey: SAFE_APPROVAL_KEY.describe(
        "Approval key from agent_session_get or pending approvals",
      ),
      decision: z
        .enum(["grant", "deny"])
        .describe("Approval decision: grant | deny"),
      note: textWithin(1000)
        .optional()
        .describe("Optional decision note or rationale (max 1000 chars)"),
    },
    { destructiveHint: true },
    async ({ sessionId, approvalKey, decision, note }) => {
      const trimmedNote = note?.trim();
      const body = trimmedNote ? { note: trimmedNote } : undefined;
      const data =
        decision === "grant"
          ? await call<unknown>(
              "POST",
              `/agent/sessions/${sessionId}/approvals/${approvalKey}/grant`,
              body,
            )
          : await call<unknown>(
              "POST",
              `/agent/sessions/${sessionId}/approvals/${approvalKey}/deny`,
              body,
            );
      return JSON_CONTENT(data);
    },
  );
}
