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
import { apiRequest, API_URL } from './api';
import {
  registerTaskTools,
  registerApplicationTools,
  registerDeploymentTools,
  registerExecutorTools,
  registerAuditTools,
} from './tools';

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'autocodeflow',
  version: '1.0.0',
});

registerTaskTools(server, apiRequest);
registerApplicationTools(server, apiRequest);
registerDeploymentTools(server, apiRequest);
registerExecutorTools(server, apiRequest);
registerAuditTools(server, apiRequest);

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
