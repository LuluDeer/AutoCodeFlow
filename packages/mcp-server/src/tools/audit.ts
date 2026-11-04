/**
 * 审计日志工具组（1 个工具）：list_audit_logs。
 *
 * R6「工具清单化」第 1 批从 `tools.ts` **整体搬出**：`server.tool` 调用块逐字节未改
 * （name / description / 入参 schema / 注解都保持原样），只是换了个文件。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  JSON_CONTENT,
} from "./shared";
import type { ApiCall } from "./shared";

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
export function registerAuditTools(server: McpServer, call: ApiCall): void {
  // ---- list_audit_logs ------------------------------------------------------
  server.tool(
    "list_audit_logs",
    "Query the audit log with pagination and optional filters. Returns { data, total }. Filters use the backend AuditQueryDto whitelist — any other query field is rejected with 400.",
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
        .describe("Items per page, max 100 (default 20)"),
      action: z
        .string()
        .optional()
        .describe("Filter by action, fuzzy match (e.g. task.trigger)"),
      resource: z
        .string()
        .optional()
        .describe("Filter by exact resource type (e.g. task)"),
      userId: z
        .number()
        .int()
        .optional()
        .describe("Filter by operator user id"),
      username: z
        .string()
        .optional()
        .describe("Filter by operator username (fuzzy match)"),
      startTime: z
        .string()
        .optional()
        .describe("Only entries created at/after this ISO 8601 time"),
      endTime: z
        .string()
        .optional()
        .describe("Only entries created at/before this ISO 8601 time"),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({
      page,
      pageSize,
      action,
      resource,
      userId,
      username,
      startTime,
      endTime,
    }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(action ? { action } : {}),
        ...(resource ? { resource } : {}),
        ...(userId !== undefined ? { userId: String(userId) } : {}),
        ...(username ? { username } : {}),
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
      });
      const data = await call<unknown>("GET", `/audit?${params}`);
      return JSON_CONTENT(data);
    },
  );
}
