/**
 * 执行面（8 个工具）：list_executions / get_execution / analyze_execution / get_execution_stats / suggest_schedule / get_execution_logs / kill_execution / retry_execution。
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
  ANALYZE_TIMEOUT_MS,
  EXECUTION_STATUS,
  JSON_CONTENT,
  JSON_ERROR,
  UUID_PATH_ID,
  taskParamsWithinLimits,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerTaskExecutionTools(server: McpServer, call: ApiCall): void {
  // ---- list_executions ------------------------------------------------------
  // 分页参数与其余 list_* 工具统一口径（default 20 / max 100，对齐后端
  // PageQueryDto 契约）；此前 default 10 / max 50 是无出处的独头部形状。
  server.tool(
    "list_executions",
    "List recent task executions (newest first). Optionally filter by taskId and status.",
    {
      taskId: UUID_PATH_ID.optional().describe("Filter by task ID"),
      status: EXECUTION_STATUS.optional().describe(
        "Filter by status: pending | running | waiting | success | failed | timeout | killed | cancelled",
      ),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page, max 100 (default 20)"),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({ taskId, status, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(taskId ? { taskId } : {}),
        ...(status ? { status } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/all?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution --------------------------------------------------------
  // 大输出治理（对齐 admin-api PERF-03 的同一决策）：GET /tasks/executions/:id
  // 的 compat alias 原样回传实体行，其中 logs 是 text 列、单条上限 512_000
  // 字符——后端已把列表/详情/统计读面的日志全部迁到独立分页端点
  // GET .../logs（本包的 get_execution_logs 工具）。这里如实剥离并在响应里
  // 说明去向（而不是静默丢弃或把 512KB 塞进 agent 上下文）。
  server.tool(
    "get_execution",
    "Get the details of a specific execution by ID: status, duration, result, runtime params, error info, and AI analysis if available. The full log payload is stripped from this response (single rows can reach 512 KB) — page through logs with get_execution_logs.",
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
    }, { readOnlyHint: true },
    async ({ executionId }) => {
      const data = await call<Record<string, unknown>>(
        "GET",
        `/tasks/executions/${executionId}`,
      );
      // R112：**空载荷不是成功**。此前 `JSON_CONTENT(null)` 会让 agent 拿到一个「成功但内容为 null」
      // 的响应，它没有任何办法区分「执行不存在」与「执行存在但字段全空」——于是继续在假数据上动作。
      // （正常路径下后端 404 会抛错；这里兜的是 200 + 空体/空载荷的形态。）
      if (data === null || data === undefined) {
        return JSON_ERROR({
          error: "Execution not found (the API returned an empty payload)",
          errorCode: "EXECUTION_NOT_FOUND",
          executionId,
        });
      }
      if (data && typeof data === "object" && "logs" in data) {
        const { logs: _logs, ...rest } = data;
        return JSON_CONTENT({
          ...rest,
          logsStripped: true,
          note: "The full log payload was stripped from this response (it can reach 512 KB). Page through it with get_execution_logs (fromLine/limit).",
        });
      }
      return JSON_CONTENT(data);
    },
  );

  // ---- analyze_execution ----------------------------------------------------
  server.tool(
    "analyze_execution",
    "Trigger AI analysis on a failed execution. Returns the AI-generated root cause and fix suggestion.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      // 后端 analyzeExecution 不按 status 硬闸（任何执行都可分析），只是
      // failed/timeout 之外的分析没有输入也没有意义——按「预期用途」表述，
      // 不谎称前置校验。
      executionId: UUID_PATH_ID.describe(
        "Execution ID (intended for failed/timeout executions)",
      ),
    }, { destructiveHint: false },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/executions/${executionId}/analyze`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_stats --------------------------------------------------
  server.tool(
    "get_execution_stats",
    "Get execution statistics for a task: success rate, average duration, and last 20 executions.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { readOnlyHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/stats`);
      return JSON_CONTENT(data);
    },
  );

  // ---- suggest_schedule -----------------------------------------------------
  server.tool(
    "suggest_schedule",
    "Ask AI to suggest an optimal cron schedule for a task based on its execution history (success rate, avg duration, failure patterns).",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { destructiveHint: false },
    async ({ taskId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/suggest-schedule`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_logs --------------------------------------------------
  // OBS-03: `level` filters at the SQL layer (strict uppercase enum, WARNING
  // is already normalized to WARN server-side at write time). With a level
  // set, fromLine becomes an offset into the FILTERED sequence and
  // totalLines/hasMore count only matching rows (unknown-level rows are
  // excluded); without it, behavior is unchanged (physical line cursor).
  server.tool(
    "get_execution_logs",
    "Fetch paginated execution logs for a given execution ID. Use fromLine + limit to page through large outputs, and the optional level filter (ERROR/WARN/INFO/DEBUG) to cut the noise.",
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
      fromLine: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Start line (0-based, default 0)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(500)
        .describe("Lines to return (max 2000, default 500)"),
      level: z
        .enum(["ERROR", "WARN", "INFO", "DEBUG"])
        .optional()
        .describe(
          "Filter by inferred log level (exact uppercase enum). When set, fromLine becomes an offset into the filtered sequence and totalLines/hasMore count only matching rows; rows with no inferable level are excluded. Omit to keep the legacy physical-line paging behavior",
        ),
    }, { readOnlyHint: true },
    async ({ executionId, fromLine, limit, level }) => {
      const params = new URLSearchParams({
        fromLine: String(fromLine),
        limit: String(limit),
        ...(level ? { level } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/${executionId}/logs?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- kill_execution ------------------------------------------------------
  server.tool(
    "kill_execution",
    "Force-cancel a running or pending execution by ID. Requires task ID because the underlying route is task-scoped.",
    {
      taskId: UUID_PATH_ID.describe("Task ID that owns the execution"),
      executionId: UUID_PATH_ID.describe("Execution ID to cancel"),
    }, { destructiveHint: true },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/executions/${executionId}/kill`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- retry_execution ------------------------------------------------------
  // NF-06: the admin API has NO native retry endpoint (grep task.controller/
  // task.service/docs — only BullMQ-side auto retry exists). Re-running a past
  // execution therefore goes through the ordinary manual-trigger path, which
  // creates a NEW execution row; the original row's params are replayed here
  // (fetched via the by-execId compat alias) so the rerun matches what the
  // failed run actually received, not today's task defaults.
  server.tool(
    "retry_execution",
    "Re-run a past execution: creates a NEW execution of the same task via the manual-trigger path (the admin API has no native retry endpoint — this is a fresh run, not a continuation of the original attempt counter). The original execution's runtime params are replayed automatically; pass params to override them. Returns the new execution (id) — poll it with get_execution.",
    {
      taskId: UUID_PATH_ID.describe("Task ID that owns the execution"),
      executionId: UUID_PATH_ID.describe("Execution ID to re-run (from list_executions / get_execution)"),
      // R115：同 trigger_task —— 后端 65536 字节上限。
      params: taskParamsWithinLimits()
        .optional()
        .describe(
          "Override the replayed runtime parameters (when absent — or when an empty object — the original execution's params are reused; if it had none, the task's current defaults apply)",
        ),
    }, { destructiveHint: false },
    async ({ taskId, executionId, params }) => {
      let body: Record<string, unknown> = {};
      // R107-A1: 与 trigger_task 同一口径——`params: {}` 是「不加覆盖」，
      // 不是「用空参数重跑」。后者会同时丢掉原执行的参数**和**任务默认参数
      // （后端 task.service.ts:2730），而响应仍是成功。
      // 注意：原执行行上真实存在的 `params: {}` 仍被逐字回放（faithful
      // replay）——它记录的正是「当时确实以空参数运行」，语义不同。
      const hasParams = params !== undefined && Object.keys(params).length > 0;
      if (hasParams) {
        body = { params };
      } else {
        const prev = await call<{ params?: Record<string, unknown> | null }>(
          "GET",
          `/tasks/executions/${executionId}`,
        );
        if (prev?.params) body = { params: prev.params };
      }
      const data = await call<Record<string, unknown>>(
        "POST",
        `/tasks/${taskId}/trigger`,
        body,
      );
      return JSON_CONTENT({ retriedFrom: executionId, ...data });
    },
  );

}
