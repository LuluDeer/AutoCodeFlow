/**
 * 任务定义读面与触发（3 个工具）：list_tasks / get_task / trigger_task。
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
  JSON_CONTENT,
  TASK_STATUS,
  UUID_PATH_ID,
  taskParamsWithinLimits,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerTaskDefinitionTools(server: McpServer, call: ApiCall): void {
  // ---- list_tasks ----------------------------------------------------------
  server.tool(
    "list_tasks",
    "List tasks defined in AutoCodeFlow with optional status/name filtering. Returns the backend paginated envelope { list, items, total, page, pageSize, totalPages } (list and items carry the same rows); each row has id, name, status, trigger config (cron or fixed rate), and last trigger time.",
    {
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
        .describe("Items per page (default 20)"),
      status: TASK_STATUS.optional().describe(
        "Filter by task status: active | paused | deleted (deleted = soft-deleted rows)",
      ),
      name: z
        .string()
        .optional()
        .describe(
          "Filter by task name (fuzzy match, backend ListTasksQueryDto field)",
        ),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({ page, pageSize, status, name }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(status ? { status } : {}),
        ...(name ? { name } : {}),
      });
      const data = await call<unknown>("GET", `/tasks?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_task ------------------------------------------------------------
  server.tool(
    "get_task",
    "Get full details of a specific task by its ID, including script source, cron, timeout, and dependencies.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- trigger_task --------------------------------------------------------
  server.tool(
    "trigger_task",
    "Manually trigger a task to run immediately. Returns the execution ID that can be polled with get_execution.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to trigger"),
      // R115：后端 `@TaskParamsMaxBytes()` = 65536 字节（task/params-size.util.ts:15）——
      // 超限的 params 会被后端 400，agent 白跑一趟网络。
      params: taskParamsWithinLimits()
        .optional()
        .describe(
          "Optional runtime parameters to pass to the task. Merged as a WHOLE override, not per-key: an empty object ({}) is treated as 'no override' (= use the task's configured default params), never as 'run with zero params'",
        ),
      // NOTE: no executorId parameter here — TriggerTaskDto only accepts
      // `params`, and the backend's global ValidationPipe runs with
      // forbidNonWhitelisted, so a per-trigger pin would be rejected with 400.
      // Executor pinning IS supported by the backend, but as a task-level
      // field (tasks.executorId, set via create/update — see the update_task
      // tool), not a per-run override.
    }, { destructiveHint: false },
    async ({ taskId, params }) => {
      // R107-A1: 空对象 ≠ 覆盖。后端是
      // `const effectiveParams = dto.params ?? task.params`
      // （apps/admin-api/src/modules/task/task.service.ts:2730）——`{}` 不是
      // nullish，所以 `params: {}` 会把任务的默认参数**整组清空**。agent 说
      // 「不加参数直接跑一次」时最容易发 `{}`，而响应仍是成功，于是它就在
      // 「参数被清空」的假数据上继续动作（真实执行的输入与它以为的不一致）。
      // 契约：空对象按「无覆盖」处理（省略 body 才等价于任务默认参数）。
      const hasParams = params !== undefined && Object.keys(params).length > 0;
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/trigger`,
        hasParams ? { params } : {},
      );
      return JSON_CONTENT(data);
    },
  );

}
