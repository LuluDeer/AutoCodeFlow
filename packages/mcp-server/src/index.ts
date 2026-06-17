#!/usr/bin/env node
/**
 * AutoCodeFlow MCP Server
 * Exposes AutoCodeFlow task management to AI agents (Claude, Cursor, etc.)
 * via the Model Context Protocol.
 *
 * Usage:
 *   AUTOCODEFLOW_API_URL=http://localhost:3105 \
 *   AUTOCODEFLOW_API_TOKEN=<jwt> \
 *   node dist/index.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fetch from 'node-fetch';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_URL = process.env.AUTOCODEFLOW_API_URL || 'http://localhost:3105';
const API_TOKEN = process.env.AUTOCODEFLOW_API_TOKEN || '';

if (!API_TOKEN) {
  process.stderr.write(
    '[autocodeflow-mcp] WARNING: AUTOCODEFLOW_API_TOKEN is not set.\n',
  );
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'autocodeflow',
  version: '1.0.0',
});

// ---- list_tasks -----------------------------------------------------------
server.tool(
  'list_tasks',
  'List all tasks defined in AutoCodeFlow. Returns id, name, status, cron, and last execution info.',
  {
    page: z.number().int().min(1).default(1).describe('Page number (default 1)'),
    pageSize: z.number().int().min(1).max(100).default(20).describe('Items per page (default 20)'),
    status: z.string().optional().describe('Filter by task status: active | paused | disabled'),
    keyword: z.string().optional().describe('Search by task name or description'),
  },
  async ({ page, pageSize, status, keyword }) => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      ...(status ? { status } : {}),
      ...(keyword ? { keyword } : {}),
    });
    const data = await apiRequest<unknown>('GET', `/tasks?${params}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- get_task -------------------------------------------------------------
server.tool(
  'get_task',
  'Get full details of a specific task by its ID, including script source, cron, timeout, and dependencies.',
  {
    taskId: z.string().describe('Task ID'),
  },
  async ({ taskId }) => {
    const data = await apiRequest<unknown>('GET', `/tasks/${taskId}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- trigger_task ---------------------------------------------------------
server.tool(
  'trigger_task',
  'Manually trigger a task to run immediately. Returns the execution ID that can be polled with get_execution.',
  {
    taskId: z.string().describe('Task ID to trigger'),
    params: z
      .record(z.unknown())
      .optional()
      .describe('Optional runtime parameters to pass to the task'),
    executorId: z.string().optional().describe('Pin to a specific executor (optional)'),
  },
  async ({ taskId, params, executorId }) => {
    const data = await apiRequest<unknown>('POST', `/tasks/${taskId}/trigger`, {
      ...(params ? { params } : {}),
      ...(executorId ? { executorId } : {}),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- list_executions ------------------------------------------------------
server.tool(
  'list_executions',
  'List recent task executions. Optionally filter by taskId and status.',
  {
    taskId: z.string().optional().describe('Filter by task ID'),
    status: z
      .string()
      .optional()
      .describe('Filter by status: pending | running | success | failed | timeout | cancelled'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(10),
  },
  async ({ taskId, status, page, pageSize }) => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      ...(taskId ? { taskId } : {}),
      ...(status ? { status } : {}),
    });
    const data = await apiRequest<unknown>('GET', `/tasks/executions/all?${params}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- get_execution --------------------------------------------------------
server.tool(
  'get_execution',
  'Get the details and logs of a specific execution by ID. Includes status, duration, output, logs, and AI analysis if available.',
  {
    executionId: z.string().describe('Execution ID'),
  },
  async ({ executionId }) => {
    const data = await apiRequest<unknown>('GET', `/tasks/executions/${executionId}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- analyze_execution ----------------------------------------------------
server.tool(
  'analyze_execution',
  'Trigger AI analysis on a failed execution. Returns the AI-generated root cause and fix suggestion.',
  {
    taskId: z.string().describe('Task ID'),
    executionId: z.string().describe('Execution ID (must be a failed/timeout execution)'),
  },
  async ({ taskId, executionId }) => {
    const data = await apiRequest<unknown>(
      'POST',
      `/tasks/${taskId}/executions/${executionId}/analyze`,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- get_execution_stats --------------------------------------------------
server.tool(
  'get_execution_stats',
  'Get execution statistics for a task: success rate, average duration, and last 20 executions.',
  {
    taskId: z.string().describe('Task ID'),
  },
  async ({ taskId }) => {
    const data = await apiRequest<unknown>('GET', `/tasks/${taskId}/stats`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- list_applications ----------------------------------------------------
server.tool(
  'list_applications',
  'List all registered applications in AutoCodeFlow.',
  {},
  async () => {
    const data = await apiRequest<unknown>('GET', '/applications');
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- analyze_application --------------------------------------------------
server.tool(
  'analyze_application',
  'Run AI health analysis on an application. Aggregates recent execution stats across all tasks and returns LLM-generated health assessment and recommendations.',
  {
    applicationId: z.string().describe('Application ID'),
  },
  async ({ applicationId }) => {
    const data = await apiRequest<unknown>(
      'POST',
      `/applications/${applicationId}/analyze`,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- suggest_schedule -----------------------------------------------------
server.tool(
  'suggest_schedule',
  'Ask AI to suggest an optimal cron schedule for a task based on its execution history (success rate, avg duration, failure patterns).',
  {
    taskId: z.string().describe('Task ID'),
  },
  async ({ taskId }) => {
    const data = await apiRequest<unknown>(
      'POST',
      `/tasks/${taskId}/suggest-schedule`,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- get_execution_logs --------------------------------------------------
server.tool(
  'get_execution_logs',
  'Fetch paginated execution logs for a given execution ID. Use fromLine + limit to page through large outputs.',
  {
    executionId: z.string().describe('Execution ID'),
    fromLine: z.number().int().min(0).default(0).describe('Start line (0-based, default 0)'),
    limit: z.number().int().min(1).max(2000).default(500).describe('Lines to return (max 2000, default 500)'),
  },
  async ({ executionId, fromLine, limit }) => {
    const params = new URLSearchParams({
      fromLine: String(fromLine),
      limit: String(limit),
    });
    const data = await apiRequest<unknown>(
      'GET',
      `/tasks/executions/${executionId}/logs?${params}`,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- list_executors -------------------------------------------------------
server.tool(
  'list_executors',
  'List all registered executors and their status (online/offline, last heartbeat, current load).',
  {},
  async () => {
    const data = await apiRequest<unknown>('GET', '/executors');
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[autocodeflow-mcp] Server started. API: ${API_URL}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[autocodeflow-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
