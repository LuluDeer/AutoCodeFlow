/**
 * 任务版本面（3 个工具）：list_task_versions / rollback_task_version / compare_task_versions。
 *
 * R6「工具清单化」第 2 批（2026-11-04）从 `tools.ts` **整体搬出**：`server.tool`
 * 调用块逐字节未改（name / description / 入参 schema / 注解 / handler 都保持原样），
 * 只是换了个文件。
 *
 * 搬迁纪律：**块逐字节搬移**，不重排、不改写、不「顺手优化」。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  JSON_CONTENT,
  UUID_PATH_ID,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerTaskVersionTools(server: McpServer, call: ApiCall): void {
  // ---- list_task_versions --------------------------------------------------
  server.tool(
    "list_task_versions",
    "List the historical configuration versions of a task (newest first). Use with rollback_task_version / compare_task_versions.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { readOnlyHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/versions`);
      return JSON_CONTENT(data);
    },
  );

  // ---- rollback_task_version ----------------------------------------------
  server.tool(
    "rollback_task_version",
    "Roll a task back to a specific historical version snapshot. Returns the updated task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      versionId: UUID_PATH_ID.describe("Version ID to roll back to (from list_task_versions)"),
    }, { destructiveHint: true },
    async ({ taskId, versionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/versions/${versionId}/rollback`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- compare_task_versions ----------------------------------------------
  server.tool(
    "compare_task_versions",
    "Diff two task versions. Returns a map of changed fields with their old and new values.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      versionId1: UUID_PATH_ID.describe("First version ID"),
      versionId2: UUID_PATH_ID.describe("Second version ID"),
    }, { readOnlyHint: true },
    async ({ taskId, versionId1, versionId2 }) => {
      const data = await call<unknown>(
        "GET",
        `/tasks/${taskId}/versions/${versionId1}/compare/${versionId2}`,
      );
      return JSON_CONTENT(data);
    },
  );

}
