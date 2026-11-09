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
    "Manually trigger a task to run immediately. Returns the execution ID that can be polled with get_execution. Optional consumeNextFirePoint (cron tasks only): run the task now AND consume the NEXT scheduled cron fire point — that single fire point is skipped once (a ONE-SHOT skip, NOT a pause: the schedule keeps running normally afterwards). Only cron tasks have fire points to consume — a non-cron task is rejected with 400. If the task already carries an unconsumed fire-point registration, the request is rejected with 409 (the existing registration is never silently overwritten). Omitting consumeNextFirePoint (or passing false) keeps the default behaviour unchanged: a manual trigger consumes no scheduled fire point.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to trigger"),
      // R115：后端 `@TaskParamsMaxBytes()` = 65536 字节（task/params-size.util.ts:15）——
      // 超限的 params 会被后端 400，agent 白跑一趟网络。
      params: taskParamsWithinLimits()
        .optional()
        .describe(
          "Optional runtime parameters to pass to the task. Merged as a WHOLE override, not per-key: an empty object ({}) is treated as 'no override' (= use the task's configured default params), never as 'run with zero params'",
        ),
      // R143（A6b）：后端 TriggerTaskDto 的可选体字段 `consumeNextFirePoint`
      // （apps/admin-api/src/modules/task/dto/trigger-task.dto.ts:61）。
      //
      // 口径：**仅 cron** 可用（非 cron ⇒ 400）；已有未消耗登记 ⇒ 409。
      // 语义是「本次立即执行 + **下一个** cron 落点被跳过（**只跳一次**）」——
      // **不是暂停**：跳过那一个落点后，登记即清除，后续落点照常跑。
      //
      // ⚠️ 缺省 false ⇒ 后端行为逐字节不变 ⇒ **不发这个键**（不是发 false：
      // 发 false 会让请求体与「未传」不再逐字节一致）。
      consumeNextFirePoint: z
        .boolean()
        .optional()
        .describe(
          "Cron tasks only: run the task now AND consume (skip) the NEXT scheduled cron fire point — a ONE-SHOT skip of that single fire point, NOT a pause (the schedule keeps running normally after it). Only cron tasks can consume a fire point: a non-cron task is rejected with 400. If the task already has an unconsumed fire-point registration, the request is rejected with 409 and the existing registration is kept. Omit it (or pass false) to keep the default behaviour unchanged — a manual trigger consumes no scheduled fire point.",
        ),
      // NOTE: no executorId parameter here — TriggerTaskDto only accepts
      // `params`, and the backend's global ValidationPipe runs with
      // forbidNonWhitelisted, so a per-trigger pin would be rejected with 400.
      // Executor pinning IS supported by the backend, but as a task-level
      // field (tasks.executorId, set via create/update — see the update_task
      // tool), not a per-run override.
    }, { destructiveHint: false },
    async ({ taskId, params, consumeNextFirePoint }) => {
      // R107-A1: 空对象 ≠ 覆盖。后端是
      // `const effectiveParams = dto.params ?? task.params`
      // （apps/admin-api/src/modules/task/task.service.ts:2730）——`{}` 不是
      // nullish，所以 `params: {}` 会把任务的默认参数**整组清空**。agent 说
      // 「不加参数直接跑一次」时最容易发 `{}`，而响应仍是成功，于是它就在
      // 「参数被清空」的假数据上继续动作（真实执行的输入与它以为的不一致）。
      // 契约：空对象按「无覆盖」处理（省略 body 才等价于任务默认参数）。
      const hasParams = params !== undefined && Object.keys(params).length > 0;
      // R143：请求体**只收显式给出的键**。`consumeNextFirePoint` 缺省（undefined）
      // 或为 false 时**整个键不出现** ⇒ 与 A6b 落地前的请求体逐字节一致。
      const body: Record<string, unknown> = {};
      if (hasParams) body.params = params;
      if (consumeNextFirePoint === true) body.consumeNextFirePoint = true;
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/trigger`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

}
