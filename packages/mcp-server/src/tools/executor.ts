/**
 * 执行器清单工具组（3 个工具）：list_executors / get_executor / get_executor_metrics。
 *
 * R6「工具清单化」第 1 批从 `tools.ts` **整体搬出**：`server.tool` 调用块逐字节未改
 * （name / description / 入参 schema / 注解都保持原样），只是换了个文件。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  JSON_CONTENT,
  UUID_PATH_ID,
} from "./shared";
import type { ApiCall } from "./shared";

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------
export function registerExecutorTools(server: McpServer, call: ApiCall): void {
  // ---- list_executors -------------------------------------------------------
  server.tool(
    "list_executors",
    "List all registered executors and their status (online/offline, last heartbeat, current load).",
    {}, { readOnlyHint: true, idempotentHint: true },
    async () => {
      const data = await call<unknown>("GET", "/executors");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor ---------------------------------------------------------
  server.tool(
    "get_executor",
    // U12: the old description promised "performance metrics" but this only
    // hits GET /executors/:id (entity fields: config, status, resource
    // usage, heartbeat-reported running executions). Metrics live on
    // GET /executors/:id/metrics — exposed as get_executor_metrics below.
    "Get detailed info for a single executor by ID: config, status, group/tags, CPU & memory usage, task counters, and the execution ids it reported running on its last heartbeat. Does NOT include 7-day statistics — use get_executor_metrics for those.",
    {
      executorId: UUID_PATH_ID.describe("Executor ID"),
    }, { readOnlyHint: true },
    async ({ executorId }) => {
      const data = await call<unknown>("GET", `/executors/${executorId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor_metrics -------------------------------------------------
  server.tool(
    "get_executor_metrics",
    // FEAT-04: 响应还带 history——最近 24h 的 executor_metrics_history 采样,
    // 聚合为 15 分钟 AVG 桶（≤96 个点,升序;每点 {timestamp, cpuUsage,
    // memUsage, runningTaskCount},无上报值的桶 cpu/mem 为 null）。
    "Get performance metrics for a single executor: { executor, sevenDayStats (totalExecutions/successful/failed/successRate/averageDurationMs over the last 7 days), current (runningTaskCount/cpuUsage/memUsage), history (last 24h of resource samples in 15-minute average buckets, <=96 ascending points; empty when no samples) }. Backed by GET /executors/:id/metrics.",
    {
      executorId: UUID_PATH_ID.describe("Executor ID"),
    }, { readOnlyHint: true },
    async ({ executorId }) => {
      const data = await call<unknown>(
        "GET",
        `/executors/${executorId}/metrics`,
      );
      return JSON_CONTENT(data);
    },
  );
}
