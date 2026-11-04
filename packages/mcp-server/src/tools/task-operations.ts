/**
 * 任务开关与跨环境搬运（4 个工具）：pause_task / resume_task / export_task / import_task。
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
  UUID_PATH_ID,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerTaskOperationTools(server: McpServer, call: ApiCall): void {
  // ---- pause_task -----------------------------------------------------------
  server.tool(
    "pause_task",
    "Pause a task — stops scheduled triggers. In-progress executions are not affected.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to pause"),
    }, { destructiveHint: true, idempotentHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("POST", `/tasks/${taskId}/pause`);
      return JSON_CONTENT(data);
    },
  );

  // ---- resume_task ----------------------------------------------------------
  server.tool(
    "resume_task",
    "Resume a previously paused task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to resume"),
    }, { destructiveHint: false, idempotentHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("POST", `/tasks/${taskId}/resume`);
      return JSON_CONTENT(data);
    },
  );

  // ---- export_task / import_task (E-1) ---------------------------------------
  // Cross-environment task-definition transfer. The export payload IS the
  // import body (two endpoints are symmetric per docs/api-reference.md), so
  // export_task returns the payload VERBATIM — wrapping it in extra keys
  // (note/links/…) would break the round-trip because POST /tasks/import
  // runs with forbidNonWhitelisted (unknown keys → 400). The "save the file
  // yourself" hint lives in the description: MCP tool outputs are agent
  // context, not a file-write surface.
  server.tool(
    "export_task",
    "Export a task definition as a portable JSON payload ({ schemaVersion: \"1\", exportedAt, task }) for cross-environment transfer. Secrets are NEVER part of the export (SEC-02 red line). The returned JSON text is the verbatim POST /tasks/import body: save it to a file yourself (MCP tool output is not written to disk), or pass it straight back to import_task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to export"),
    }, { readOnlyHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/export`);
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "import_task",
    "Create a task from an export_task payload (POST /tasks/import). Name conflicts are never overwritten — an ' (imported)' suffix (then 2, 3, …) is appended; the new task starts paused and without secrets, so review the response's warnings before running it. Accepts the export JSON text verbatim or the equivalent object.",
    {
      payload: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .describe(
          'Export payload produced by export_task: pass the JSON text verbatim, or the equivalent object with "schemaVersion" and "task" keys',
        ),
    }, { destructiveHint: false },
    async ({ payload }) => {
      let body: unknown;
      if (typeof payload === "string") {
        try {
          body = JSON.parse(payload);
        } catch (err) {
          return JSON_ERROR({
            error: `payload is not valid JSON (${
              err instanceof Error ? err.message : String(err)
            }) — pass the export_task output verbatim`,
          });
        }
      } else {
        body = payload;
      }
      // Light pre-flight guard: the backend would 400 anyway, but catching
      // the common "passed only the task object" mistake locally avoids a
      // network round trip and points straight at the fix.
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !("task" in body) ||
        !("schemaVersion" in body)
      ) {
        return JSON_ERROR({
          error:
            'Invalid export payload: expected an object with "schemaVersion" and "task" keys — pass the verbatim export_task output (JSON text or object)',
        });
      }
      const data = await call<unknown>("POST", "/tasks/import", body);
      return JSON_CONTENT(data);
    },
  );

}
