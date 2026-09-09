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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiRequest, API_URL, API_TOKEN } from "./api";
import {
  registerTaskTools,
  registerApplicationTools,
  registerDeploymentTools,
  registerExecutorTools,
  registerObservabilityTools,
  registerAuditTools,
} from "./tools";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "autocodeflow",
  version: "1.0.0",
});

registerTaskTools(server, apiRequest);
registerApplicationTools(server, apiRequest);
registerDeploymentTools(server, apiRequest);
registerExecutorTools(server, apiRequest);
registerObservabilityTools(server, apiRequest);
registerAuditTools(server, apiRequest);

// ---------------------------------------------------------------------------
// CLI — argument handling for the bin entry (autocodeflow-mcp)
// ---------------------------------------------------------------------------
/** Server version, kept in sync with package.json (asserted by cli.test.ts). */
export const VERSION = "1.0.1";

export interface CliDecision {
  /** 'run' starts the stdio MCP server; 'exit' prints `output` and exits. */
  action: "run" | "exit";
  /** Text to write to stdout when action === 'exit' (help / version). */
  output: string;
  /** Process exit code when action === 'exit'. */
  exitCode: number;
}

/**
 * Pure argv → decision mapping (no I/O, no process.exit) so it can be
 * unit-tested. Unknown / absent arguments keep the historical behaviour:
 * the server starts regardless of what it is passed.
 */
export function parseCliArgs(argv: string[]): CliDecision {
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    return { action: "exit", exitCode: 0, output: helpText() };
  }
  if (first === "--version" || first === "-v") {
    return { action: "exit", exitCode: 0, output: `${VERSION}\n` };
  }
  return { action: "run", output: "", exitCode: 0 };
}

function helpText(): string {
  return [
    "autocodeflow-mcp — AutoCodeFlow MCP server (Model Context Protocol)",
    "",
    `Version: ${VERSION}`,
    "",
    "Runs as an MCP server over stdio (JSON-RPC on stdin/stdout). Start it",
    "without arguments and register it as an MCP server in your agent client",
    "(Claude Desktop, Cursor, ...) instead of invoking it manually.",
    "",
    "Usage:",
    "  autocodeflow-mcp            Start the MCP server (stdio)",
    "  autocodeflow-mcp --help     Show this help and exit",
    "  autocodeflow-mcp --version  Show version and exit",
    "",
    "Environment variables:",
    "  AUTOCODEFLOW_API_URL     Admin API base URL (default: http://localhost:3105)",
    "  AUTOCODEFLOW_API_TOKEN   JWT bearer token for the Admin API (required)",
    "  AUTOCODEFLOW_API_REFRESH_TOKEN  Optional. Enables 401 self-heal: on access-token expiry the server refreshes once and replays the request (in-memory rotation for the process lifetime)",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  // W-07: the missing-token check lives here (not api.ts module scope) so
  // --help/--version still work; since every tool call would 401 anyway, a
  // missing token is now fatal instead of a warning the user finds at call time.
  if (!API_TOKEN) {
    process.stderr.write(
      "[autocodeflow-mcp] ERROR: AUTOCODEFLOW_API_TOKEN is not set — every tool call would be rejected with 401. " +
        "Get a token from the admin web (or POST /api/auth/login) and export it, then restart.\n",
    );
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[autocodeflow-mcp] Server started. API: ${API_URL}\n`);
}

/**
 * Bin entry: resolve CLI args first (--help / --version exit 0 before any
 * server work), otherwise start the stdio server as before.
 */
export function runCli(argv: string[]): void {
  const decision = parseCliArgs(argv);
  if (decision.action === "exit") {
    process.stdout.write(decision.output);
    process.exit(decision.exitCode);
  }
  main().catch((err) => {
    process.stderr.write(`[autocodeflow-mcp] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// Auto-run only when executed directly (node dist/index.js / ts-node);
// skipped under vitest so the module can be imported for unit tests.
if (
  !process.env.VITEST &&
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  runCli(process.argv.slice(2));
}
