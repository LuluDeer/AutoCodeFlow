/**
 * Unit tests for MCP tool registrations: drive the real register*Tools
 * functions with a mock McpServer and a mock apiRequest, then invoke each
 * tool handler and assert method / path / body and response parsing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

import {
  registerTaskTools,
  registerApplicationTools,
  registerDeploymentTools,
  registerExecutorTools,
  registerObservabilityTools,
  registerAuditTools,
  buildExecutionTimeline,
  TASK_TEMPLATES,
} from "../tools";

const registerFns = [
  registerTaskTools,
  registerApplicationTools,
  registerDeploymentTools,
  registerExecutorTools,
  registerObservabilityTools,
  registerAuditTools,
];

function setup(): {
  tools: Map<string, RegisteredTool>;
  call: ReturnType<typeof vi.fn>;
} {
  const registered = new Map<string, RegisteredTool>();
  const call = vi.fn().mockResolvedValue({ ok: true });
  const fakeServer = {
    tool: (
      name: string,
      description: string,
      _schema: Record<string, z.ZodTypeAny>,
      handler: ToolHandler,
    ) => {
      registered.set(name, { name, description, schema: _schema, handler });
    },
  };
  for (const fn of registerFns) fn(fakeServer as never, call as never);
  return { tools: registered, call };
}

let tools: Map<string, RegisteredTool>;
let call: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ({ tools, call } = setup());
  call.mockReset();
  call.mockResolvedValue({ ok: true });
});

const parse = (r: { content: Array<{ text: string }> }) =>
  JSON.parse(r.content[0].text);

// ---------------------------------------------------------------------------
// Full surface sanity
// ---------------------------------------------------------------------------
describe("tool registry surface", () => {
  it("registers the full P1-aligned capability face", () => {
    const expected = [
      // tasks
      "list_tasks",
      "get_task",
      "trigger_task",
      "update_task",
      "list_task_versions",
      "rollback_task_version",
      "compare_task_versions",
      "list_executions",
      "get_execution",
      "analyze_execution",
      "get_execution_stats",
      "suggest_schedule",
      "get_execution_logs",
      "kill_execution",
      "pause_task",
      "resume_task",
      "create_task_from_template",
      // applications
      "list_applications",
      "get_application",
      "create_application",
      "update_application",
      "delete_application",
      "analyze_application",
      // deployments
      "list_deployments",
      "deploy_application",
      "upgrade_deployment",
      "stop_deployment",
      // executors
      "list_executors",
      "get_executor",
      "get_executor_metrics",
      // observability (ECO-03)
      "get_execution_timeline",
      "list_dead_letters",
      "get_scheduler_health",
      // audit
      "list_audit_logs",
    ];
    expect([...tools.keys()].sort()).toEqual(expected.sort());
  });

  it("does not declare an executorId param on trigger_task (TriggerTaskDto only accepts params)", () => {
    expect(tools.get("trigger_task")!.schema).not.toHaveProperty("executorId");
  });

  it("does not declare a keyword param on list_tasks (ListTasksQueryDto only has name)", () => {
    expect(tools.get("list_tasks")!.schema).not.toHaveProperty("keyword");
    expect(tools.get("list_tasks")!.schema).toHaveProperty("name");
  });
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
describe("list_tasks", () => {
  it("GETs /tasks with page/pageSize and optional name/status", async () => {
    await tools
      .get("list_tasks")!
      .handler({ page: 2, pageSize: 10, name: "demo", status: "active" });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    const url = new URL(path, "http://x");
    expect(url.pathname).toBe("/tasks");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(url.searchParams.get("name")).toBe("demo");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.has("keyword")).toBe(false);
  });

  it("omits unset filters", async () => {
    await tools.get("list_tasks")!.handler({ page: 1, pageSize: 20 });
    const [, path] = call.mock.calls[0];
    expect(path).toBe("/tasks?page=1&pageSize=20");
  });
});

describe("get_task / trigger_task", () => {
  it("get_task GETs /tasks/:id", async () => {
    await tools.get("get_task")!.handler({ taskId: "t1" });
    expect(call).toHaveBeenCalledWith("GET", "/tasks/t1");
  });

  it("trigger_task POSTs /tasks/:id/trigger with params only (no executorId)", async () => {
    await tools
      .get("trigger_task")!
      .handler({ taskId: "t1", params: { a: 1 } });
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t1/trigger", {
      params: { a: 1 },
    });
  });

  it("trigger_task omits the body when params is absent", async () => {
    await tools.get("trigger_task")!.handler({ taskId: "t1" });
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t1/trigger", {});
  });
});

// R7 (N20): MCP 之前无任何设置 pinning 的路径；update_task 经 PATCH 透传
// executorId，补齐能力并纠正"后端不支持 pinning"的过时注释。
describe("update_task", () => {
  it("declares an executorId param (unlike trigger_task)", () => {
    expect(tools.get("update_task")!.schema).toHaveProperty("executorId");
  });

  it("PATCHes /tasks/:id with executorId to pin a task", async () => {
    await tools.get("update_task")!.handler({
      taskId: "t1",
      executorId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(call).toHaveBeenCalledWith("PATCH", "/tasks/t1", {
      executorId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("keeps an explicit executorId:null so the pin can be cleared", async () => {
    await tools.get("update_task")!.handler({ taskId: "t1", executorId: null });
    expect(call).toHaveBeenCalledWith("PATCH", "/tasks/t1", {
      executorId: null,
    });
  });

  it("drops undefined fields so PATCH only touches what was supplied", async () => {
    await tools.get("update_task")!.handler({ taskId: "t1", name: "renamed" });
    const [, , body] = call.mock.calls[0];
    expect(body).toEqual({ name: "renamed" });
    expect("executorId" in (body as object)).toBe(false);
    expect("executeMode" in (body as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task versions / rollback / compare (new P1 tools)
// ---------------------------------------------------------------------------
describe("list_task_versions", () => {
  it("GETs /tasks/:id/versions", async () => {
    await tools.get("list_task_versions")!.handler({ taskId: "t1" });
    expect(call).toHaveBeenCalledWith("GET", "/tasks/t1/versions");
  });
});

describe("rollback_task_version", () => {
  it("POSTs /tasks/:id/versions/:versionId/rollback", async () => {
    await tools
      .get("rollback_task_version")!
      .handler({ taskId: "t1", versionId: "v9" });
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t1/versions/v9/rollback");
  });
});

describe("compare_task_versions", () => {
  it("GETs /tasks/:id/versions/:v1/compare/:v2", async () => {
    await tools
      .get("compare_task_versions")!
      .handler({ taskId: "t1", versionId1: "a", versionId2: "b" });
    expect(call).toHaveBeenCalledWith("GET", "/tasks/t1/versions/a/compare/b");
  });
});

// ---------------------------------------------------------------------------
// executions (existing tools, route regression guard)
// ---------------------------------------------------------------------------
describe("execution tools", () => {
  it("list_executions GETs /tasks/executions/all with filters", async () => {
    await tools
      .get("list_executions")!
      .handler({ taskId: "t1", status: "failed", page: 1, pageSize: 10 });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe(
      "/tasks/executions/all?page=1&pageSize=10&taskId=t1&status=failed",
    );
  });

  it("get_execution GETs /tasks/executions/:id", async () => {
    await tools.get("get_execution")!.handler({ executionId: "e1" });
    expect(call).toHaveBeenCalledWith("GET", "/tasks/executions/e1");
  });

  it("get_execution_logs GETs /tasks/executions/:id/logs with fromLine/limit", async () => {
    await tools
      .get("get_execution_logs")!
      .handler({ executionId: "e1", fromLine: 5, limit: 100 });
    expect(call).toHaveBeenCalledWith(
      "GET",
      "/tasks/executions/e1/logs?fromLine=5&limit=100",
    );
  });

  it("kill_execution POSTs the task-scoped kill route", async () => {
    await tools
      .get("kill_execution")!
      .handler({ taskId: "t1", executionId: "e1" });
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t1/executions/e1/kill");
  });

  it("pause/resume POST their dedicated routes", async () => {
    await tools.get("pause_task")!.handler({ taskId: "t1" });
    await tools.get("resume_task")!.handler({ taskId: "t2" });
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t1/pause");
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t2/resume");
  });
});

// ---------------------------------------------------------------------------
// applications CRUD (new P1 tools)
// ---------------------------------------------------------------------------
describe("create_application", () => {
  it("POSTs all provided fields to /applications", async () => {
    await tools.get("create_application")!.handler({
      name: "demo",
      version: "1.0.0",
      runtime: "node",
      description: "d",
      env: { K: "V" },
      manifest: { a: 1 },
    });
    expect(call).toHaveBeenCalledWith("POST", "/applications", {
      name: "demo",
      version: "1.0.0",
      runtime: "node",
      description: "d",
      env: { K: "V" },
      manifest: { a: 1 },
    });
  });
});

describe("update_application", () => {
  it("PUTs the patch to /applications/:id", async () => {
    await tools
      .get("update_application")!
      .handler({ applicationId: "a1", version: "2.0.0", status: "INACTIVE" });
    expect(call).toHaveBeenCalledWith("PUT", "/applications/a1", {
      version: "2.0.0",
      status: "INACTIVE",
    });
  });

  it("drops undefined fields (forbidNonWhitelisted rejects unknown properties)", async () => {
    await tools.get("update_application")!.handler({
      applicationId: "a1",
      version: "2.0.0",
      description: undefined,
    });
    expect(call).toHaveBeenCalledWith("PUT", "/applications/a1", {
      version: "2.0.0",
    });
  });

  it("the schema exposes no name field (UpdateApplicationDto has no name)", () => {
    expect(tools.get("update_application")!.schema).not.toHaveProperty("name");
    expect(tools.get("create_application")!.schema).toHaveProperty("name");
  });
});

describe("delete_application", () => {
  it("DELETEs /applications/:id", async () => {
    await tools.get("delete_application")!.handler({ applicationId: "a1" });
    expect(call).toHaveBeenCalledWith("DELETE", "/applications/a1");
  });
});

describe("application read/analyze tools", () => {
  it("list/get/analyze hit their routes", async () => {
    await tools.get("list_applications")!.handler({});
    await tools.get("get_application")!.handler({ applicationId: "a1" });
    await tools.get("analyze_application")!.handler({ applicationId: "a1" });
    expect(call).toHaveBeenNthCalledWith(1, "GET", "/applications");
    expect(call).toHaveBeenNthCalledWith(2, "GET", "/applications/a1");
    expect(call).toHaveBeenNthCalledWith(3, "POST", "/applications/a1/analyze");
  });
});

// ---------------------------------------------------------------------------
// deployments (new P1 upgrade/stop tools)
// ---------------------------------------------------------------------------
describe("upgrade_deployment", () => {
  it("POSTs /app-deployments/:id/upgrade", async () => {
    await tools.get("upgrade_deployment")!.handler({ deploymentId: "d1" });
    expect(call).toHaveBeenCalledWith("POST", "/app-deployments/d1/upgrade");
  });
});

describe("stop_deployment", () => {
  it("POSTs /app-deployments/:id/stop", async () => {
    await tools.get("stop_deployment")!.handler({ deploymentId: "d1" });
    expect(call).toHaveBeenCalledWith("POST", "/app-deployments/d1/stop");
  });
});

describe("deploy_application", () => {
  it("POSTs /app-deployments/applications/:id/deploy with only the provided fields", async () => {
    await tools.get("deploy_application")!.handler({
      applicationId: "a1",
      executorId: "e1",
      runMode: "daemon",
    });
    expect(call).toHaveBeenCalledWith(
      "POST",
      "/app-deployments/applications/a1/deploy",
      {
        executorId: "e1",
        runMode: "daemon",
      },
    );
  });
});

describe("list_deployments", () => {
  it("GETs /app-deployments with applicationId filter", async () => {
    await tools
      .get("list_deployments")!
      .handler({ applicationId: "a1", page: 1, pageSize: 20 });
    expect(call).toHaveBeenCalledWith(
      "GET",
      "/app-deployments?page=1&pageSize=20&applicationId=a1",
    );
  });
});

// ---------------------------------------------------------------------------
// executors (new P1 get_executor tool)
// ---------------------------------------------------------------------------
describe("get_executor", () => {
  it("GETs /executors/:id", async () => {
    await tools.get("get_executor")!.handler({ executorId: "e1" });
    expect(call).toHaveBeenCalledWith("GET", "/executors/e1");
  });

  it("list_executors GETs /executors", async () => {
    await tools.get("list_executors")!.handler({});
    expect(call).toHaveBeenCalledWith("GET", "/executors");
  });

  // U12: get_executor only hits GET /executors/:id — the 7-day performance
  // metrics live on /executors/:id/metrics and are exposed as their own tool.
  it("get_executor description no longer promises performance metrics", () => {
    expect(tools.get("get_executor")!.description).not.toMatch(
      /performance metrics/,
    );
  });

  it("get_executor_metrics GETs /executors/:id/metrics and passes the body through", async () => {
    const metrics = {
      executor: { id: "e1", address: "x:1", status: "online" },
      sevenDayStats: {
        totalExecutions: 10,
        successful: 9,
        failed: 1,
        successRate: 90,
        averageDurationMs: 120,
      },
      current: { runningTaskCount: 1, cpuUsage: 10, memUsage: 20 },
    };
    call.mockResolvedValueOnce(metrics);
    const r = await tools
      .get("get_executor_metrics")!
      .handler({ executorId: "e1" });
    expect(call).toHaveBeenCalledWith("GET", "/executors/e1/metrics");
    expect(parse(r)).toEqual(metrics);
  });
});

// ---------------------------------------------------------------------------
// audit (new P1 tool)
// ---------------------------------------------------------------------------
describe("list_audit_logs", () => {
  it("GETs /audit with the AuditQueryDto whitelist params", async () => {
    await tools.get("list_audit_logs")!.handler({
      page: 2,
      pageSize: 50,
      action: "task.trigger",
      resource: "task",
      userId: 3,
      username: "admin",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-02-01T00:00:00Z",
    });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    const url = new URL(path, "http://x");
    expect(url.pathname).toBe("/audit");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("50");
    expect(url.searchParams.get("action")).toBe("task.trigger");
    expect(url.searchParams.get("resource")).toBe("task");
    expect(url.searchParams.get("userId")).toBe("3");
    expect(url.searchParams.get("username")).toBe("admin");
    expect(url.searchParams.get("startTime")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("endTime")).toBe("2026-02-01T00:00:00Z");
  });

  it("omits filters that were not provided", async () => {
    await tools.get("list_audit_logs")!.handler({ page: 1, pageSize: 20 });
    const [, path] = call.mock.calls[0];
    expect(path).toBe("/audit?page=1&pageSize=20");
  });
});

// ---------------------------------------------------------------------------
// ECO-03: observability + template tools
// ---------------------------------------------------------------------------
describe("get_execution_timeline", () => {
  it("GETs the compat alias route and maps the row onto an OBS-04 timeline", async () => {
    call.mockResolvedValueOnce({
      id: "e1",
      taskId: "t1",
      taskName: "demo",
      status: "failed",
      triggerType: "cron",
      retryCount: 1,
      failureReason: "git_fetch_failed",
      errorMessage: "fatal: could not read from remote repository",
      exitCode: 128,
      createdAt: "2026-09-07T01:00:00.000Z",
      startTime: "2026-09-07T01:00:02.000Z",
      endTime: "2026-09-07T01:00:10.000Z",
      duration: 8,
      aiAnalysis: "check network",
      executorAddress: "host:3002",
    });
    const r = await tools
      .get("get_execution_timeline")!
      .handler({ executionId: "e1" });
    expect(call).toHaveBeenCalledWith("GET", "/tasks/executions/e1");
    const out = parse(r);
    expect(out.executionId).toBe("e1");
    expect(out.timeline.map((x: any) => x.phase)).toEqual([
      "created",
      "started",
      "finished",
    ]);
    expect(out.timeline[1].detail).toBe("executor=host:3002");
    expect(out.failure.reason).toBe("git_fetch_failed");
    expect(out.failure.suggestion).toMatch(/EXECUTOR_ALLOW_PRIVATE_NETWORK/);
    expect(out.aiAnalysis).toBe("check network");
  });

  it("omits the failure card on success and falls back for unknown reasons", async () => {
    call.mockResolvedValueOnce({
      id: "e2",
      status: "success",
      createdAt: "2026-09-07T02:00:00Z",
    });
    const out = parse(
      await tools.get("get_execution_timeline")!.handler({ executionId: "e2" }),
    );
    expect(out.failure).toBeUndefined();
    call.mockResolvedValueOnce({
      id: "e3",
      status: "failed",
      failureReason: "some_new_reason",
    });
    const out2 = parse(
      await tools.get("get_execution_timeline")!.handler({ executionId: "e3" }),
    );
    expect(out2.failure.suggestion).toContain("analyze_execution");
  });
});

describe("buildExecutionTimeline (pure mapper)", () => {
  it("handles missing timestamps without throwing", () => {
    const t = buildExecutionTimeline({
      id: "x",
      status: "pending",
      createdAt: "2026-09-07T00:00:00Z",
    });
    expect(t.timeline[1].at).toBeNull();
    expect(t.failure).toBeUndefined();
  });
});

describe("list_dead_letters", () => {
  it("aggregates deadLetterCount from GET /executors and sorts desc", async () => {
    call.mockResolvedValueOnce({
      data: [
        {
          id: "a",
          name: "A",
          address: "x:1",
          status: "online",
          deadLetterCount: 3,
        },
        {
          id: "b",
          name: "B",
          address: "x:2",
          status: "online",
          deadLetterCount: 9,
        },
        {
          id: "c",
          name: "C",
          address: "x:3",
          status: "offline",
          deadLetterCount: null,
        },
      ],
    });
    const out = parse(await tools.get("list_dead_letters")!.handler({}));
    expect(call).toHaveBeenCalledWith("GET", "/executors");
    expect(out.totalDeadLetters).toBe(12);
    expect(out.executors[0].executorId).toBe("b");
    expect(out.executors[0].deadLetterCount).toBe(9);
    expect(out.executors[2].deadLetterCount).toBeNull();
  });

  it("accepts a bare array envelope (older deployments) and counts missing as 0", async () => {
    call.mockResolvedValueOnce([{ id: "a", deadLetterCount: 2 }]);
    const out = parse(await tools.get("list_dead_letters")!.handler({}));
    expect(out.totalDeadLetters).toBe(2);
  });
});

describe("get_scheduler_health", () => {
  it("reshapes GET /metrics/scheduler into leader/queue/latency sections", async () => {
    call.mockResolvedValueOnce({
      counters: {
        triggerLatencyCount: 10,
        lastTriggerLatencyMs: 40,
        ticks: 100,
      },
      derived: { avgTriggerLatencyMs: 20, p99TriggerLatencyMs: 50 },
      queue: { waiting: 1, active: 2, delayed: 0, failed: 0, completed: 50 },
      scheduler: { isLeader: true, healthy: true, activeTimers: 3 },
      instance: { pid: 1, hostname: "h" },
    });
    const out = parse(await tools.get("get_scheduler_health")!.handler({}));
    expect(call).toHaveBeenCalledWith("GET", "/metrics/scheduler");
    expect(out.healthy).toBe(true);
    expect(out.leader.isLeader).toBe(true);
    expect(out.queue.failed).toBe(0);
    expect(out.triggerLatency.p99Ms).toBe(50);
  });

  it("flags unhealthy when the failed queue depth is large and still works with a null queue (Redis down)", async () => {
    call.mockResolvedValueOnce({
      counters: {},
      derived: {},
      queue: {
        waiting: null,
        active: null,
        delayed: null,
        failed: 500,
        completed: null,
      },
    });
    const out = parse(await tools.get("get_scheduler_health")!.handler({}));
    expect(out.healthy).toBe(false);
    call.mockResolvedValueOnce({
      counters: {},
      derived: {},
      queue: {
        waiting: null,
        active: null,
        delayed: null,
        failed: null,
        completed: null,
      },
    });
    const out2 = parse(await tools.get("get_scheduler_health")!.handler({}));
    expect(out2.healthy).toBe(true);
  });
});

describe("create_task_from_template", () => {
  it("POSTs /tasks with template config + description default + name", async () => {
    await tools
      .get("create_task_from_template")!
      .handler({ template: "scheduled_backup", name: "nightly-db" });
    expect(call).toHaveBeenCalledWith("POST", "/tasks", {
      triggerType: "cron",
      cronExpression: "0 2 * * *",
      runtime: "shell",
      entrypoint: "backup.sh",
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: "discard",
      description: TASK_TEMPLATES.scheduled_backup.description,
      name: "nightly-db",
    });
  });

  it("applies overrides last and allows an explicit description", async () => {
    await tools.get("create_task_from_template")!.handler({
      template: "health_check",
      name: "probe-api",
      description: "probe /healthz",
      overrides: { fixedRate: 30, params: { url: "http://x" } },
    });
    const [, , body] = call.mock.calls[0];
    expect(body.fixedRate).toBe(30);
    expect(body.params).toEqual({ url: "http://x" });
    expect(body.timeoutSeconds).toBe(30);
    expect(body.description).toBe("probe /healthz");
    expect(body.name).toBe("probe-api");
  });

  it("returns the available template keys on an unknown template (no HTTP call)", async () => {
    const out = parse(
      await tools
        .get("create_task_from_template")!
        .handler({ template: "nope", name: "x" }),
    );
    expect(call).not.toHaveBeenCalled();
    expect(out.error).toMatch(/Unknown template/);
    expect(out.available).toContain("data_sync");
  });
});

// ---------------------------------------------------------------------------
// Handler output shape
// ---------------------------------------------------------------------------
describe("tool handler output", () => {
  it("returns JSON text content with the apiRequest result", async () => {
    call.mockResolvedValueOnce({ list: [{ id: "t1" }], total: 1 });
    const result = await tools
      .get("list_tasks")!
      .handler({ page: 1, pageSize: 20 });
    expect(result.content[0].type).toBe("text");
    expect(parse(result)).toEqual({ list: [{ id: "t1" }], total: 1 });
  });
});
