/**
 * 任务模板面（2 个工具）：list_task_templates / create_task_from_template。
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
  JSON_ERROR,
  TASK_NAME_MAX_LENGTH,
  taskParamsWithinLimits,
  textWithin,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerTaskTemplateTools(server: McpServer, call: ApiCall): void {
  // ---- list_task_templates (CORE-03) -----------------------------------------
  server.tool(
    "list_task_templates",
    "List task templates available for create_task_from_template (GET /task-templates): official presets (scheduled_backup, health_check, data_sync, log_cleanup, webhook_ping) come first, custom templates follow. Each row has id (uuid), key (stable identifier), name, description, category, config (CreateTaskDto defaults without name) and isOfficial.",
    {}, { readOnlyHint: true },
    async () => {
      const data = await call<unknown>("GET", "/task-templates");
      return JSON_CONTENT(data);
    },
  );

  // ---- create_task_from_template (CORE-03) -----------------------------------
  // Reworked from expanding a hardcoded local TASK_TEMPLATES copy onto
  // POST /tasks to the server-side template endpoints: the template is
  // resolved via GET /task-templates (by `key` — the historical input — or
  // by uuid) and created via POST /task-templates/:id/instantiate, so
  // server-defined templates (official + custom) are authoritative and the
  // local copy can no longer drift. Precedence kept from the old tool:
  // name > overrides > explicit description > template description.
  server.tool(
    "create_task_from_template",
    "Create a runnable task from a task template (server-side POST /task-templates/:id/instantiate — the template config expands as defaults, the overrides win per field; name is always required). Create-side required set (differs from update_task's all-optional PATCH): name, plus triggerType which must come from the template config or the overrides — the backend validates the merged payload against CreateTaskDto and rejects with 400 otherwise; every other field is optional with backend defaults, and update-only fields (expectedUpdatedAt) are not part of the create face. Pass template as its key (official presets: scheduled_backup | health_check | data_sync | log_cleanup | webhook_ping) or its uuid — browse all templates including custom ones with list_task_templates. Returns the created task — trigger it with trigger_task.",
    {
      template: z
        .string()
        .describe(
          "Template key or uuid (resolve with list_task_templates; official keys: scheduled_backup | health_check | data_sync | log_cleanup | webhook_ping)",
        ),
      // R111-A1 上限出处：与 update_task.name 同一字段、同一 DTO 约束
      // （CreateTaskDto.name 的 @IsTaskName() → task-name.constraint.ts:43，255 码点）。
      name: textWithin(TASK_NAME_MAX_LENGTH).describe(
        "Unique task name for the new task (max 255 chars — the backend's IsTaskName limit)",
      ),
      // R111-A1：**后端无约束**（create-task.dto.ts:70），2000 为客户端保护，同 update_task。
      description: textWithin(2000)
        .optional()
        .describe(
          "Task description (max 2000 chars — client-side cap; the backend imposes none; defaults to the template's description)",
        ),
      // R115：overrides 会并进 CreateTaskDto 的 params 一路落库 —— 同 65536 字节口径。
      overrides: taskParamsWithinLimits()
        .optional()
        .describe(
          "Field overrides applied on top of the template config (any CreateTaskDto field, e.g. cronExpression, fixedRate, timeoutSeconds, params, executorGroup, secrets, maintenanceWindows, priority, timeoutAction/timeoutWarnRatio, estimatedDurationSec, requirements, dependencies, blockStrategy, misfireStrategy, executorAffinityTags/executorAntiAffinityTags, deploymentPolicy, executorId, projectId, runbook. NOTE: template instantiate merges then validates the WHOLE payload against CreateTaskDto — triggerType must be set by the template config or the overrides or the backend rejects with 400; expectedUpdatedAt is update-only and never accepted here)",
        ),
    }, { destructiveHint: false },
    async ({ template, name, description, overrides }) => {
      const rows = await call<
        Array<{ id?: string; key?: string; description?: string | null }>
      >("GET", "/task-templates");
      const list = Array.isArray(rows) ? rows : [];
      const tpl = list.find((r) => r?.key === template || r?.id === template);
      if (!tpl?.id) {
        return JSON_ERROR({
          error: `Unknown template "${template}" — list the available template keys/uuids with list_task_templates`,
          available: list.map((r) => r?.key).filter(Boolean),
        });
      }
      const body = {
        ...(tpl.description ? { description: tpl.description } : {}),
        ...(description ? { description } : {}),
        ...(overrides ?? {}),
        name,
      };
      const data = await call<unknown>(
        "POST",
        `/task-templates/${tpl.id}/instantiate`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

}
