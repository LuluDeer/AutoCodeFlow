/**
 * MCP tool registrations for AutoCodeFlow.
 * Each `register*Tools(server, call)` keeps HTTP concerns in the injected
 * `call` function so routes/params/responses can be unit-tested with a mock.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export type ApiCall = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

const JSON_CONTENT = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export function registerTaskTools(server: McpServer, call: ApiCall): void {
  // ---- list_tasks ----------------------------------------------------------
  server.tool(
    'list_tasks',
    'List all tasks defined in AutoCodeFlow. Returns id, name, status, cron, and last execution info.',
    {
      page: z.number().int().min(1).default(1).describe('Page number (default 1)'),
      pageSize: z.number().int().min(1).max(100).default(20).describe('Items per page (default 20)'),
      status: z.string().optional().describe('Filter by task status: active | paused'),
      name: z.string().optional().describe('Filter by task name (fuzzy match, backend ListTasksQueryDto field)'),
    },
    async ({ page, pageSize, status, name }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(status ? { status } : {}),
        ...(name ? { name } : {}),
      });
      const data = await call<unknown>('GET', `/tasks?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_task ------------------------------------------------------------
  server.tool(
    'get_task',
    'Get full details of a specific task by its ID, including script source, cron, timeout, and dependencies.',
    {
      taskId: z.string().describe('Task ID'),
    },
    async ({ taskId }) => {
      const data = await call<unknown>('GET', `/tasks/${taskId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- trigger_task --------------------------------------------------------
  server.tool(
    'trigger_task',
    'Manually trigger a task to run immediately. Returns the execution ID that can be polled with get_execution.',
    {
      taskId: z.string().describe('Task ID to trigger'),
      params: z
        .record(z.unknown())
        .optional()
        .describe('Optional runtime parameters to pass to the task'),
      // NOTE: no executorId parameter here — TriggerTaskDto only accepts
      // `params`, and the backend's global ValidationPipe runs with
      // forbidNonWhitelisted, so a per-trigger pin would be rejected with 400.
      // Executor pinning IS supported by the backend, but as a task-level
      // field (tasks.executorId, set via create/update — see the update_task
      // tool), not a per-run override.
    },
    async ({ taskId, params }) => {
      const data = await call<unknown>('POST', `/tasks/${taskId}/trigger`, {
        ...(params ? { params } : {}),
      });
      return JSON_CONTENT(data);
    },
  );

  // ---- update_task ---------------------------------------------------------
  server.tool(
    'update_task',
    'Update an existing task via PATCH (only the fields you pass are changed). Supports executor pinning: set executorId to pin the task to one executor (fails fast if it is offline), or pass executorId: null to clear the pin. executorId is mutually exclusive with executeMode="broadcast" — the backend rejects that combination with 400.',
    {
      taskId: z.string().describe('Task ID to update'),
      name: z.string().optional().describe('New task name'),
      description: z.string().optional().describe('New task description'),
      status: z.string().optional().describe('Task status: active | paused'),
      triggerType: z.string().optional().describe('Trigger type: cron | fixed_rate | api | manual'),
      cronExpression: z.string().optional().describe('Cron expression (5 fields) for cron triggers'),
      timezone: z.string().optional().describe('IANA timezone for cron schedules, e.g. Asia/Shanghai'),
      fixedRate: z.number().int().min(1).optional().describe('Fixed interval in seconds for fixed_rate triggers'),
      runtime: z.string().optional().describe('Runtime type, e.g. node | python | shell'),
      entrypoint: z.string().optional().describe('Entry point file path relative to the repo root'),
      timeoutSeconds: z.number().int().min(0).optional().describe('Execution timeout in seconds'),
      maxRetry: z.number().int().min(0).max(10).optional().describe('Max retry attempts (0-10)'),
      executeMode: z.string().optional().describe('Dispatch mode: single | broadcast. broadcast fans out to all online executors and cannot be combined with executorId.'),
      executorId: z
        .string()
        .nullable()
        .optional()
        .describe('Pin the task to this executor ID (uuid). Pass null to remove an existing pin. Mutually exclusive with executeMode=broadcast.'),
      executorGroup: z.string().optional().describe('Restrict auto-dispatch to executors in this group'),
      executorTags: z.array(z.string()).optional().describe('Restrict auto-dispatch to executors carrying all these tags'),
      params: z.record(z.unknown()).optional().describe('Default runtime parameters'),
      applicationId: z.string().optional().describe('Associated application ID'),
    },
    async ({ taskId, ...fields }) => {
      // Drop undefined fields so PATCH only touches what the caller supplied;
      // keep explicit nulls (e.g. executorId: null) so a pin can be cleared.
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const data = await call<unknown>('PATCH', `/tasks/${taskId}`, body);
      return JSON_CONTENT(data);
    },
  );

  // ---- list_task_versions --------------------------------------------------
  server.tool(
    'list_task_versions',
    'List the historical configuration versions of a task (newest first). Use with rollback_task_version / compare_task_versions.',
    {
      taskId: z.string().describe('Task ID'),
    },
    async ({ taskId }) => {
      const data = await call<unknown>('GET', `/tasks/${taskId}/versions`);
      return JSON_CONTENT(data);
    },
  );

  // ---- rollback_task_version ----------------------------------------------
  server.tool(
    'rollback_task_version',
    'Roll a task back to a specific historical version snapshot. Returns the updated task.',
    {
      taskId: z.string().describe('Task ID'),
      versionId: z.string().describe('Version ID to roll back to (from list_task_versions)'),
    },
    async ({ taskId, versionId }) => {
      const data = await call<unknown>('POST', `/tasks/${taskId}/versions/${versionId}/rollback`);
      return JSON_CONTENT(data);
    },
  );

  // ---- compare_task_versions ----------------------------------------------
  server.tool(
    'compare_task_versions',
    'Diff two task versions. Returns a map of changed fields with their old and new values.',
    {
      taskId: z.string().describe('Task ID'),
      versionId1: z.string().describe('First version ID'),
      versionId2: z.string().describe('Second version ID'),
    },
    async ({ taskId, versionId1, versionId2 }) => {
      const data = await call<unknown>(
        'GET',
        `/tasks/${taskId}/versions/${versionId1}/compare/${versionId2}`,
      );
      return JSON_CONTENT(data);
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
        .describe('Filter by status: pending | running | success | failed | timeout | killed | cancelled'),
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
      const data = await call<unknown>('GET', `/tasks/executions/all?${params}`);
      return JSON_CONTENT(data);
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
      const data = await call<unknown>('GET', `/tasks/executions/${executionId}`);
      return JSON_CONTENT(data);
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
      const data = await call<unknown>(
        'POST',
        `/tasks/${taskId}/executions/${executionId}/analyze`,
      );
      return JSON_CONTENT(data);
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
      const data = await call<unknown>('GET', `/tasks/${taskId}/stats`);
      return JSON_CONTENT(data);
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
      const data = await call<unknown>(
        'POST',
        `/tasks/${taskId}/suggest-schedule`,
      );
      return JSON_CONTENT(data);
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
      const data = await call<unknown>(
        'GET',
        `/tasks/executions/${executionId}/logs?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- kill_execution ------------------------------------------------------
  server.tool(
    'kill_execution',
    'Force-cancel a running or pending execution by ID. Requires task ID because the underlying route is task-scoped.',
    {
      taskId: z.string().describe('Task ID that owns the execution'),
      executionId: z.string().describe('Execution ID to cancel'),
    },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        'POST',
        `/tasks/${taskId}/executions/${executionId}/kill`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- pause_task -----------------------------------------------------------
  server.tool(
    'pause_task',
    'Pause a task — stops scheduled triggers. In-progress executions are not affected.',
    {
      taskId: z.string().describe('Task ID to pause'),
    },
    async ({ taskId }) => {
      const data = await call<unknown>('POST', `/tasks/${taskId}/pause`);
      return JSON_CONTENT(data);
    },
  );

  // ---- resume_task ----------------------------------------------------------
  server.tool(
    'resume_task',
    'Resume a previously paused task.',
    {
      taskId: z.string().describe('Task ID to resume'),
    },
    async ({ taskId }) => {
      const data = await call<unknown>('POST', `/tasks/${taskId}/resume`);
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------
export function registerApplicationTools(server: McpServer, call: ApiCall): void {
  // ---- list_applications ----------------------------------------------------
  server.tool(
    'list_applications',
    'List all registered applications in AutoCodeFlow.',
    {},
    async () => {
      const data = await call<unknown>('GET', '/applications');
      return JSON_CONTENT(data);
    },
  );

  // ---- get_application ------------------------------------------------------
  server.tool(
    'get_application',
    'Get full details of a registered application by ID, including version, git repo info, and runtime config.',
    {
      applicationId: z.string().describe('Application ID'),
    },
    async ({ applicationId }) => {
      const data = await call<unknown>('GET', `/applications/${applicationId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- create_application ---------------------------------------------------
  server.tool(
    'create_application',
    'Register a new application. Required fields: name (unique, max 100 chars), version (e.g. 1.0.0), runtime (e.g. node/python).',
    {
      name: z.string().max(100).describe('Unique application name'),
      version: z.string().describe('Application version number, e.g. 1.0.0'),
      runtime: z.string().describe('Runtime type, e.g. node or python'),
      description: z.string().optional().describe('Application description (max 500 chars)'),
      gitRepo: z.string().optional().describe('Git repository URL'),
      gitBranch: z.string().optional().describe('Git branch'),
      gitCommit: z.string().optional().describe('Git commit SHA'),
      manifest: z.record(z.unknown()).optional().describe('Application manifest object'),
      env: z.record(z.string()).optional().describe('Environment variables'),
      entrypoint: z.string().optional().describe('Entry point command'),
      packageUrl: z.string().optional().describe('Package download URL'),
    },
    async (args) => {
      const data = await call<unknown>('POST', '/applications', args);
      return JSON_CONTENT(data);
    },
  );

  // ---- update_application ---------------------------------------------------
  server.tool(
    'update_application',
    'Update an existing application. NOTE: the backend UpdateApplicationDto has no `name` field — renaming is not supported.',
    {
      applicationId: z.string().describe('Application ID'),
      description: z.string().optional().describe('Application description'),
      version: z.string().optional().describe('Application version number'),
      runtime: z.string().optional().describe('Runtime type'),
      status: z.string().optional().describe('Application status (ApplicationStatus enum value)'),
      gitRepo: z.string().optional().describe('Git repository URL'),
      gitBranch: z.string().optional().describe('Git branch'),
      gitCommit: z.string().optional().describe('Git commit SHA'),
      manifest: z.record(z.unknown()).optional().describe('Application manifest object'),
      env: z.record(z.string()).optional().describe('Environment variables'),
      entrypoint: z.string().optional().describe('Entry point command'),
      packageUrl: z.string().optional().describe('Package download URL'),
      webhookSecret: z.string().optional().describe('HMAC-SHA256 webhook secret (empty string disables webhook auth)'),
    },
    async ({ applicationId, ...fields }) => {
      // Drop undefined fields — the global ValidationPipe with
      // forbidNonWhitelisted rejects unknown/extra properties, and explicit
      // undefined keys can serialize differently across transports.
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const data = await call<unknown>('PUT', `/applications/${applicationId}`, body);
      return JSON_CONTENT(data);
    },
  );

  // ---- delete_application ---------------------------------------------------
  server.tool(
    'delete_application',
    'Delete an application by ID.',
    {
      applicationId: z.string().describe('Application ID'),
    },
    async ({ applicationId }) => {
      const data = await call<unknown>('DELETE', `/applications/${applicationId}`);
      return JSON_CONTENT(data);
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
      const data = await call<unknown>(
        'POST',
        `/applications/${applicationId}/analyze`,
      );
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------
export function registerDeploymentTools(server: McpServer, call: ApiCall): void {
  // ---- list_deployments ----------------------------------------------------
  server.tool(
    'list_deployments',
    'List application deployments with optional filtering by application ID and pagination.',
    {
      applicationId: z.string().optional().describe('Filter by application ID'),
      page: z.number().int().min(1).default(1).describe('Page number (default 1)'),
      pageSize: z.number().int().min(1).max(100).default(20).describe('Items per page (default 20)'),
    },
    async ({ applicationId, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(applicationId ? { applicationId } : {}),
      });
      const data = await call<unknown>('GET', `/app-deployments?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- deploy_application --------------------------------------------------
  server.tool(
    'deploy_application',
    'Deploy an application to an executor. Leave executorId empty to auto-select the online executor with lowest load. Optionally override run mode, env vars, and start command.',
    {
      applicationId: z.string().describe('Application ID'),
      executorId: z
        .string()
        .optional()
        .describe('Target executor ID (optional — auto-selects the lowest-load online executor)'),
      runMode: z.string().optional().describe('Run mode override (see RunMode enum, e.g. daemon)'),
      env: z.record(z.string()).optional().describe('Environment variable overrides'),
      startCommand: z.string().optional().describe('Startup command override'),
    },
    async ({ applicationId, executorId, runMode, env, startCommand }) => {
      const body = Object.fromEntries(
        Object.entries({ executorId, runMode, env, startCommand }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      const data = await call<unknown>(
        'POST',
        `/app-deployments/applications/${applicationId}/deploy`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- upgrade_deployment --------------------------------------------------
  server.tool(
    'upgrade_deployment',
    'Trigger an overlay upgrade for a running deployment so it pulls the latest application version.',
    {
      deploymentId: z.string().describe('Deployment ID to upgrade'),
    },
    async ({ deploymentId }) => {
      const data = await call<unknown>('POST', `/app-deployments/${deploymentId}/upgrade`);
      return JSON_CONTENT(data);
    },
  );

  // ---- stop_deployment -----------------------------------------------------
  server.tool(
    'stop_deployment',
    'Stop a running application deployment.',
    {
      deploymentId: z.string().describe('Deployment ID to stop'),
    },
    async ({ deploymentId }) => {
      const data = await call<unknown>('POST', `/app-deployments/${deploymentId}/stop`);
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------
export function registerExecutorTools(server: McpServer, call: ApiCall): void {
  // ---- list_executors -------------------------------------------------------
  server.tool(
    'list_executors',
    'List all registered executors and their status (online/offline, last heartbeat, current load).',
    {},
    async () => {
      const data = await call<unknown>('GET', '/executors');
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor ---------------------------------------------------------
  server.tool(
    'get_executor',
    'Get detailed info for a single executor by ID, including config, status, and performance metrics.',
    {
      executorId: z.string().describe('Executor ID'),
    },
    async ({ executorId }) => {
      const data = await call<unknown>('GET', `/executors/${executorId}`);
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
export function registerAuditTools(server: McpServer, call: ApiCall): void {
  // ---- list_audit_logs ------------------------------------------------------
  server.tool(
    'list_audit_logs',
    'Query the audit log with pagination and optional filters. Returns { data, total }. Filters use the backend AuditQueryDto whitelist — any other query field is rejected with 400.',
    {
      page: z.number().int().min(1).default(1).describe('Page number (default 1)'),
      pageSize: z.number().int().min(1).max(100).default(20).describe('Items per page, max 100 (default 20)'),
      action: z.string().optional().describe('Filter by action, fuzzy match (e.g. task.trigger)'),
      resource: z.string().optional().describe('Filter by exact resource type (e.g. task)'),
      userId: z.number().int().optional().describe('Filter by operator user id'),
      username: z.string().optional().describe('Filter by operator username (fuzzy match)'),
      startTime: z.string().optional().describe('Only entries created at/after this ISO 8601 time'),
      endTime: z.string().optional().describe('Only entries created at/before this ISO 8601 time'),
    },
    async ({ page, pageSize, action, resource, userId, username, startTime, endTime }) => {
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
      const data = await call<unknown>('GET', `/audit?${params}`);
      return JSON_CONTENT(data);
    },
  );
}
