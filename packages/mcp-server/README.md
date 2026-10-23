# autocodeflow-mcp-server

MCP (Model Context Protocol) server for AutoCodeFlow. Lets AI agents like Claude Desktop, Cursor, and others manage tasks and executions directly.

## Tools exposed

The server registers **56 tools** (see `src/tools.ts`), grouped below.

### Tasks

| Tool | Description |
|------|-------------|
| `list_tasks` | List all tasks with optional filtering (page / pageSize / status / name) |
| `get_task` | Get full task details (script source, cron, timeout, dependencies) |
| `list_task_templates` | List task templates usable with `create_task_from_template` (official presets first, custom templates after; each row: id / key / config / isOfficial) |
| `create_task_from_template` | Create a runnable task from a template via the server-side instantiate endpoint — template key (`scheduled_backup` / `health_check` / `data_sync` / `log_cleanup` / `webhook_ping`) or uuid, field-level overrides allowed |
| `export_task` | Export a task definition as a portable JSON payload (`schemaVersion` / `exportedAt` / `task`). Secrets are never included (SEC-02); save the JSON text yourself or pass it verbatim to `import_task` |
| `import_task` | Create a task from an `export_task` payload (JSON text or object). Name conflicts get an `' (imported)'` suffix instead of overwriting; returns `{ taskId, name, warnings }` — the new task starts paused and without secrets |
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
| `get_execution` | Execution details (status, duration, result, params, error info, AI analysis). The 512 KB-capped log payload is stripped — page through logs with `get_execution_logs` |
| `get_execution_logs` | Paginated execution logs (`fromLine` + `limit`, optional `level` filter: ERROR / WARN / INFO / DEBUG — with `level`, `fromLine` pages the filtered sequence) |
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

### SOP & agent sessions

| Tool | Description |
|------|-------------|
| `sop_list` | List SOP definitions (`{ items, total }`, optional status filter) |
| `sop_get` | One SOP by ID: metadata, current version, front-matter and markdown body |
| `sop_assignments_pending` | `sopId` → non-terminal assignments of that SOP; `assignmentId` → full detail incl. the clarification conversation |
| `agent_session_list` | Agent sessions newest first (kind/status filters; `waiting_input` = paused on a human decision) |
| `agent_session_get` | One agent session with its reasoning steps, tool calls and child sessions |
| `sop_clarification_reply` | Answer an escalated clarification (`answered` text reply, or `sop_amended` with amended front-matter/body the executor continues against) |

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
        "AUTOCODEFLOW_API_TOKEN": "acf_<your-api-key>"
      }
    }
  }
}
```

## Where to get the token

`AUTOCODEFLOW_API_TOKEN` accepts **either an API key or a user JWT** — both are
sent as `Authorization: Bearer …`, and the server routes `acf_`-prefixed
credentials to the scoped API-key chain. Pick by how long the MCP server lives.

### Option A — API key (recommended for an always-on MCP server)

1. Sign in to the admin web → **System → Settings → API Keys** → **New API Key**.
2. Choose the scope that covers the tools you need:

   | Scope | What the MCP server can do |
   |---|---|
   | `readonly` | All read tools (`list_tasks`, `get_execution`, `get_execution_stats`, …) |
   | `trigger` | Reads + triggering a single task (`trigger_task`) |
   | `manage` | Reads + every write tool (create/update/pause tasks, deploy apps, …) |

3. Copy the plaintext `acf_…` from the creation dialog — it is shown **once**
   (the server keeps only its SHA-256 hash, so it can never be displayed again;
   create a new key if you lose it) — and put it in `AUTOCODEFLOW_API_TOKEN`.

API keys never expire unless you set a validity, and revoking one takes effect on
the next call. They are a strict subset of a user JWT (credential / user /
system-config endpoints refuse them) — but **none of the 56 MCP tools touch those
endpoints**, so an API key is sufficient here. ADMIN-only tools (e.g.
`approve_deployment`, `list_pending_approvals`) need option B.

### Option B — user JWT (only way to use ADMIN-only tools)

The admin web has no "copy my token" button; the supported way to obtain a JWT
outside the browser is the CLI:

```bash
acf login --url http://localhost:3105 --user <you>   # password + TOTP prompt
acf config show                                      # prints the config file path
```

- `AUTOCODEFLOW_API_TOKEN` = the `token` field of
  `~/.config/acf-cli/config.json` (mode 0600) — a **15-minute** access token;
- `AUTOCODEFLOW_API_REFRESH_TOKEN` = the `refreshToken` field of the same file
  (30 days) — with it the server refreshes once on 401 and replays the request.
  Without it you must restart the MCP server with a fresh access token every
  ~15 minutes.

> API-key users can ignore the refresh variable entirely: `/auth/*` is JWT-only,
> so there is nothing to refresh.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTOCODEFLOW_API_URL` | `http://localhost:3105` | Admin API base URL |
| `AUTOCODEFLOW_API_TOKEN` | — | **Required.** API key (`acf_…`, recommended) or user JWT. The server exits on startup when missing, because every tool call would be rejected. |
| `AUTOCODEFLOW_API_REFRESH_TOKEN` | — | Optional, JWT only. When set, a 401 from non-`/auth/*` API calls triggers one in-memory refresh and replays the original request once; rotated refresh tokens live only for the process lifetime. |

> All 56 tools share these 3 variables — no tool requires additional environment
> configuration. Permission-sensitive tools are enforced server-side: API-key
> scopes for `acf_…` credentials, and roles for a JWT (ADMIN-only tools reject
> API keys with 403 by design).
