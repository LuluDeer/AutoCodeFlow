# autocodeflow-mcp-server

MCP (Model Context Protocol) server for AutoCodeFlow. Lets AI agents like Claude Desktop, Cursor, and others manage tasks and executions directly.

## Tools exposed

The server registers **43 tools** (see `src/tools.ts`), grouped below.

### Tasks

| Tool | Description |
|------|-------------|
| `list_tasks` | List all tasks with optional filtering (page / pageSize / status / name) |
| `get_task` | Get full task details (script source, cron, timeout, dependencies) |
| `create_task_from_template` | Create a runnable task from built-in templates (scheduled_backup / health_check / data_sync / log_cleanup / webhook_ping), field-level overrides allowed |
| `update_task` | Update a task via PATCH; supports executor pinning (`executorId`, mutually exclusive with `executeMode="broadcast"`) and clearing the pin with `null` |
| `trigger_task` | Manually run a task, returns execution ID |
| `pause_task` | Pause a task — stops scheduled triggers (in-progress executions unaffected) |
| `resume_task` | Resume a previously paused task |
| `list_task_versions` | List historical configuration versions of a task (newest first) |
| `rollback_task_version` | Roll a task back to a specific historical version snapshot |
| `compare_task_versions` | Diff two task versions, returns changed fields with old/new values |

### Executions

| Tool | Description |
|------|-------------|
| `list_executions` | Recent executions, filterable by task/status |
| `get_execution` | Full execution details including logs and AI analysis |
| `get_execution_logs` | Paginated execution logs (`fromLine` + `limit`) |
| `kill_execution` | Force-cancel a running/pending execution (task-scoped route) |
| `retry_execution` | Re-run a past execution via the manual-trigger path (fresh run, runtime params replayed, overridable) |
| `analyze_execution` | Trigger AI root-cause analysis on a failed execution |
| `get_execution_stats` | Success rate, avg duration stats for a task |
| `get_execution_timeline` | OBS-04 timeline: created → started → finished + failure triage card (reason → suggested first action) |

### Scheduling

| Tool | Description |
|------|-------------|
| `suggest_schedule` | AI-recommended cron schedule based on execution history |

### Applications

| Tool | Description |
|------|-------------|
| `list_applications` | List registered applications |
| `get_application` | Full application details (version, git repo, runtime config) |
| `create_application` | Register a new application (name / version / runtime) |
| `update_application` | Update an application (no `name` field — renaming unsupported) |
| `delete_application` | Delete an application by ID |
| `analyze_application` | AI health analysis across an app's tasks |

### Deployments & approval (DEP-04)

| Tool | Description |
|------|-------------|
| `list_deployments` | List deployments, filterable by application ID |
| `deploy_application` | Deploy an application to an executor (auto-select lowest-load executor when `executorId` empty). With approval enabled the deployment returns `approvalStatus=pending_approval` and is NOT dispatched until a second person approves |
| `deploy_app` | Deploy an application by NAME (resolved via GET /applications); same DEP-04 approval semantics |
| `upgrade_deployment` | Trigger an overlay upgrade for a running deployment (pulls latest application version) |
| `stop_deployment` | Stop a running application deployment |
| `list_pending_approvals` | List deployments awaiting approval (ADMIN only) |
| `approve_deployment` | Approve a pending deployment — dispatches it; approver must differ from requester (ADMIN only) |
| `reject_deployment` | Reject a pending deployment; never dispatched (ADMIN only) |
| `cancel_deployment` | Cancel own pending deployment request (requester-only exit) |

### Executors

| Tool | Description |
|------|-------------|
| `list_executors` | Executor status and load |
| `get_executor` | Single executor detail: config, status, group/tags, resource usage, heartbeat-reported running executions (no 7-day stats — see `get_executor_metrics`) |
| `get_executor_metrics` | 7-day stats (successRate / avgDurationMs) + current (runningTaskCount / cpuUsage / memUsage) |
| `list_dead_letters` | Callback dead-letter backlog per executor |

### System & audit

| Tool | Description |
|------|-------------|
| `get_scheduler_health` | Scheduler health snapshot: leader election, BullMQ queue depths, tick rate, trigger counters, P99 trigger latency |
| `list_audit_logs` | Query the audit log (pagination + AuditQueryDto whitelist filters) |

### Projects & roles

| Tool | Description |
|------|-------------|
| `list_projects` | Projects visible to the current credential, each with `myRole` |
| `get_project_members` | Members (userId + role) of one project |
| `get_my_project_roles` | Caller's project memberships: `{ userId, isAdmin, memberships }` |

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
        "AUTOCODEFLOW_API_TOKEN": "<your-jwt-token>",
        "AUTOCODEFLOW_API_REFRESH_TOKEN": "<optional-refresh-token>"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTOCODEFLOW_API_URL` | `http://localhost:3105` | Admin API base URL |
| `AUTOCODEFLOW_API_TOKEN` | — | JWT token (required). The server exits on startup if this is missing, because every tool call would be rejected. |
| `AUTOCODEFLOW_API_REFRESH_TOKEN` | — | Optional refresh token. When set, a 401 from non-`/auth/*` API calls triggers one in-memory refresh and replays the original request once; rotated refresh tokens are kept only for the process lifetime. |

> All 43 tools share these 3 variables — no tool requires additional environment configuration. Permission-sensitive tools (e.g. `approve_deployment` / `reject_deployment` / `list_pending_approvals`, ADMIN-only) are enforced server-side by the roles in the JWT passed via `AUTOCODEFLOW_API_TOKEN`.
