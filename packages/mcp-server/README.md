# autocodeflow-mcp-server

MCP (Model Context Protocol) server for AutoCodeFlow. Lets AI agents like Claude Desktop, Cursor, and others manage tasks and executions directly.

## Tools exposed

| Tool | Description |
|------|-------------|
| `list_tasks` | List all tasks with optional filtering |
| `get_task` | Get full task details |
| `update_task` | Update a task via PATCH, including executor pinning (`executorId`) |
| `trigger_task` | Manually run a task, returns execution ID |
| `list_executions` | Recent executions, filterable by task/status |
| `get_execution` | Full execution details including logs and AI analysis |
| `analyze_execution` | Trigger AI root-cause analysis on a failed execution |
| `get_execution_stats` | Success rate, avg duration stats for a task |
| `list_applications` | List registered applications |
| `analyze_application` | AI health analysis across an app's tasks |
| `suggest_schedule` | AI-recommended cron schedule based on history |
| `list_executors` | Executor status and load |

## Setup

```bash
cd packages/mcp-server
npm install
npm run build
```

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "autocodeflow": {
      "command": "node",
      "args": ["/path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "AUTOCODEFLOW_API_URL": "http://localhost:3105",
        "AUTOCODEFLOW_API_TOKEN": "<your-jwt-token>"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTOCODEFLOW_API_URL` | `http://localhost:3105` | Admin API base URL |
| `AUTOCODEFLOW_API_TOKEN` | — | JWT token (required) |
