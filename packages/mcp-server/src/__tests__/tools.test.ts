/**
 * Unit tests for MCP tool registrations: drive the real register*Tools
 * functions with a mock McpServer and a mock apiRequest, then invoke each
 * tool handler and assert method / path / body and response parsing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  /** 用法错误（handler 内部判定）现在与抛错路径同形：isError:true。 */
  isError?: boolean;
}>;

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
  registerProjectTools,
  registerSopTools,
  SOP_PENDING_STATUSES,
  buildExecutionTimeline,
  ANALYZE_TIMEOUT_MS,
} from "../tools";

const registerFns = [
  registerTaskTools,
  registerApplicationTools,
  registerDeploymentTools,
  registerExecutorTools,
  registerObservabilityTools,
  registerAuditTools,
  registerProjectTools,
  registerSopTools,
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
      "retry_execution",
      "pause_task",
      "resume_task",
      // E-1: task definition export/import
      "export_task",
      "import_task",
      // CORE-03: server-side task templates
      "list_task_templates",
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
      "deploy_app",
      "upgrade_deployment",
      "stop_deployment",
      // deployments — DEP-04 approval workflow
      "list_pending_approvals",
      "approve_deployment",
      "reject_deployment",
      "cancel_deployment",
      // executors
      "list_executors",
      "get_executor",
      "get_executor_metrics",
      // observability (ECO-03)
      "get_execution_timeline",
      "list_dead_letters",
      "get_scheduler_health",
      // AUTH-02-B（R18）: projects read-only trio
      "list_projects",
      "get_project_members",
      "get_my_project_roles",
      // audit
      "list_audit_logs",
      // SOP / agent sessions (P5/P6 admin-side minimal loop)
      "sop_list",
      "sop_get",
      "sop_assignments_pending",
      "agent_session_list",
      "agent_session_get",
      "sop_clarification_reply",
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

  // 描述是 agent 的选型/传参依据——每个注册工具必须有非空描述（最低保障）。
  it("every tool declares a non-empty description", () => {
    for (const t of tools.values()) {
      expect(t.description.trim().length, t.name).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 错误响应形状（UX 轮）：用法错误与 HTTP 抛错同形——isError:true + JSON 负载
// ---------------------------------------------------------------------------
describe("error response shape (isError on usage errors)", () => {
  it("create_task_from_template marks an unknown template as an error, keeps the available keys and points at list_task_templates", async () => {
    call.mockResolvedValueOnce([
      { id: "tpl-1", key: "scheduled_backup" },
      { id: "tpl-2", key: "data_sync" },
    ]);
    const r = await tools
      .get("create_task_from_template")!
      .handler({ template: "nope", name: "x" });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/Unknown template/);
    expect(parse(r).error).toMatch(/list_task_templates/);
    expect(parse(r).available).toContain("data_sync");
    expect(call).toHaveBeenCalledTimes(1); // only the GET /task-templates lookup
  });

  it("deploy_app marks an unknown application name as an error but keeps the available list", async () => {
    call.mockResolvedValueOnce([{ id: "a2", name: "other" }]);
    const r = await tools.get("deploy_app")!.handler({ appName: "nope" });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/Application "nope" not found/);
    expect(parse(r).available).toEqual(["other"]);
    expect(call).toHaveBeenCalledTimes(1); // only the GET /applications lookup
  });

  it("sop_assignments_pending marks the missing-both-ids usage error", async () => {
    const r = await tools.get("sop_assignments_pending")!.handler({});
    expect(r.isError).toBe(true);
    expect(parse(r).error).toContain("sopId");
    expect(call).not.toHaveBeenCalled();
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

  // 大输出治理（对齐 admin-api PERF-03）：compat alias 原样回传实体行，
  // logs 列单条上限 512_000 字符——工具层如实剥离并说明去向。
  it("get_execution strips the 512KB-capped logs column and points at get_execution_logs", async () => {
    call.mockResolvedValueOnce({
      id: "e1",
      status: "failed",
      aiAnalysis: "check network",
      params: { url: "http://x" },
      logs: "x".repeat(600_000),
    });
    const out = parse(
      await tools.get("get_execution")!.handler({ executionId: "e1" }),
    );
    expect(out.logs).toBeUndefined();
    expect(out.logsStripped).toBe(true);
    expect(out.note).toMatch(/get_execution_logs/);
    // 其余字段原样保留——剥离只针对 logs 一列。
    expect(out.status).toBe("failed");
    expect(out.aiAnalysis).toBe("check network");
    expect(out.params).toEqual({ url: "http://x" });
  });

  it("get_execution passes the payload through unchanged when there is no logs column", async () => {
    call.mockResolvedValueOnce({ id: "e2", status: "pending" });
    const out = parse(
      await tools.get("get_execution")!.handler({ executionId: "e2" }),
    );
    expect(out).toEqual({ id: "e2", status: "pending" });
  });

  it("list_executions pagination matches the shared list_* shape (default 20, max 100)", () => {
    type ZodLike = { parse: (v: unknown) => unknown };
    const s = tools.get("list_executions")!.schema as Record<string, ZodLike>;
    expect(s.page.parse(undefined)).toBe(1);
    expect(s.pageSize.parse(undefined)).toBe(20);
    expect(() => s.pageSize.parse(100)).not.toThrow();
    expect(() => s.pageSize.parse(101)).toThrow();
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

  // OBS-03: level 过滤透传（服务端 SQL 层等值下推；不传时行为不变）
  it("get_execution_logs passes the level filter through when provided", async () => {
    await tools
      .get("get_execution_logs")!
      .handler({ executionId: "e1", fromLine: 0, limit: 500, level: "ERROR" });
    expect(call).toHaveBeenCalledWith(
      "GET",
      "/tasks/executions/e1/logs?fromLine=0&limit=500&level=ERROR",
    );
  });

  it("get_execution_logs omits the level param when absent (legacy physical-line paging)", async () => {
    await tools
      .get("get_execution_logs")!
      .handler({ executionId: "e2", fromLine: 3, limit: 50 });
    expect(call).toHaveBeenCalledWith(
      "GET",
      "/tasks/executions/e2/logs?fromLine=3&limit=50",
    );
  });

  it("get_execution_logs level is a strict uppercase enum (no client-side normalization)", () => {
    type ZodLike = { parse: (v: unknown) => unknown };
    const s = tools.get("get_execution_logs")!.schema as Record<
      string,
      ZodLike
    >;
    for (const ok of ["ERROR", "WARN", "INFO", "DEBUG"]) {
      expect(() => s.level.parse(ok), ok).not.toThrow();
    }
    expect(() => s.level.parse(undefined)).not.toThrow();
    // 服务端写入时才做 WARNING→WARN 归一化；查询参数是严格大写枚举，
    // 小写/别名/未知值必须在 MCP 入站校验层即拒（防脏值下发）。
    for (const bad of ["error", "warning", "TRACE", ""]) {
      expect(() => s.level.parse(bad), bad).toThrow();
    }
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
    expect(call).toHaveBeenNthCalledWith(
      3,
      "POST",
      "/applications/a1/analyze",
      undefined,
      ANALYZE_TIMEOUT_MS,
    );
  });
});

// NETOPT-6④：analyze/suggest 类端点的服务端预算是同步 AI 的 60s×2，默认
// REQUEST_TIMEOUT_MS=30s 结构性小于它——客户端必须在调用点带 120s per-call
// 覆盖，否则 AI 跑满预算成功返回时 MCP 侧早已超时。
describe("analyze/suggest per-call timeout budget", () => {
  it("analyze_execution / suggest_schedule / analyze_application pass the 120s budget", async () => {
    await tools.get("analyze_execution")!.handler({
      taskId: "t1",
      executionId: "e1",
    });
    await tools.get("suggest_schedule")!.handler({ taskId: "t1" });
    await tools.get("analyze_application")!.handler({ applicationId: "a1" });
    expect(call).toHaveBeenNthCalledWith(
      1,
      "POST",
      "/tasks/t1/executions/e1/analyze",
      undefined,
      ANALYZE_TIMEOUT_MS,
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/tasks/t1/suggest-schedule",
      undefined,
      ANALYZE_TIMEOUT_MS,
    );
    expect(call).toHaveBeenNthCalledWith(
      3,
      "POST",
      "/applications/a1/analyze",
      undefined,
      ANALYZE_TIMEOUT_MS,
    );
  });

  it("keeps the default 30s budget on non-AI endpoints", async () => {
    await tools.get("trigger_task")!.handler({ taskId: "t1" });
    await tools.get("get_execution_stats")!.handler({ taskId: "t1" });
    // 非 AI 端点不得携带第 4 参（超时覆盖）——结构性预算只在 analyze/suggest
    // 类调用上放宽。
    expect(call).toHaveBeenNthCalledWith(
      1,
      "POST",
      "/tasks/t1/trigger",
      {},
    );
    expect(call).toHaveBeenNthCalledWith(2, "GET", "/tasks/t1/stats");
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

// ---------------------------------------------------------------------------
// deployments — DEP-04 approval workflow
// ---------------------------------------------------------------------------
describe("list_pending_approvals", () => {
  it("GETs /app-deployments/approvals/pending with page/pageSize and optional applicationId", async () => {
    await tools
      .get("list_pending_approvals")!
      .handler({ page: 1, pageSize: 20 });
    expect(call).toHaveBeenNthCalledWith(
      1,
      "GET",
      "/app-deployments/approvals/pending?page=1&pageSize=20",
    );
    await tools
      .get("list_pending_approvals")!
      .handler({ page: 2, pageSize: 5, applicationId: "a1" });
    expect(call).toHaveBeenNthCalledWith(
      2,
      "GET",
      "/app-deployments/approvals/pending?page=2&pageSize=5&applicationId=a1",
    );
  });
});

describe("approve_deployment", () => {
  it("POSTs /app-deployments/:id/approval/approve (no body when reason omitted)", async () => {
    await tools.get("approve_deployment")!.handler({ deploymentId: "d1" });
    expect(call).toHaveBeenCalledWith(
      "POST",
      "/app-deployments/d1/approval/approve",
      undefined,
    );
  });
  it("sends the reason in the body when provided", async () => {
    await tools
      .get("approve_deployment")!
      .handler({ deploymentId: "d1", reason: "ok" });
    expect(call).toHaveBeenCalledWith(
      "POST",
      "/app-deployments/d1/approval/approve",
      { reason: "ok" },
    );
  });
});

describe("reject_deployment", () => {
  it("POSTs /app-deployments/:id/approval/reject with the reason", async () => {
    await tools
      .get("reject_deployment")!
      .handler({ deploymentId: "d1", reason: "no" });
    expect(call).toHaveBeenCalledWith(
      "POST",
      "/app-deployments/d1/approval/reject",
      { reason: "no" },
    );
  });
});

describe("cancel_deployment", () => {
  it("POSTs /app-deployments/:id/approval/cancel (no body)", async () => {
    await tools.get("cancel_deployment")!.handler({ deploymentId: "d1" });
    expect(call).toHaveBeenCalledWith(
      "POST",
      "/app-deployments/d1/approval/cancel",
    );
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

  // NF-06 (DEP-04): approval-gated applications come back frozen — the tool
  // must surface pending_approval as an explicit non-dispatched state.
  it("flags dispatched:false with a next-step note on approvalStatus=pending_approval", async () => {
    call.mockResolvedValueOnce({
      id: "d9",
      status: "pending",
      approvalStatus: "pending_approval",
      approvalMeta: { requestedBy: 1 },
    });
    const out = parse(
      await tools
        .get("deploy_application")!
        .handler({ applicationId: "a1" }),
    );
    expect(out.dispatched).toBe(false);
    expect(out.approvalStatus).toBe("pending_approval");
    expect(out.note).toContain("/app-deployments/d9/approval/approve");
  });

  it("returns the plain deployment payload when approvalStatus is absent or not pending", async () => {
    call.mockResolvedValueOnce({ id: "d1", status: "pending", approvalStatus: null });
    const out = parse(
      await tools.get("deploy_application")!.handler({ applicationId: "a1" }),
    );
    expect(out).toEqual({ id: "d1", status: "pending", approvalStatus: null });
    call.mockResolvedValueOnce({ id: "d2", approvalStatus: "approved" });
    const out2 = parse(
      await tools.get("deploy_application")!.handler({ applicationId: "a1" }),
    );
    expect(out2.dispatched).toBeUndefined();
  });

  it("lets upstream errors bubble (409 conflict / 403 non-admin keep the apiRequest message)", async () => {
    call.mockRejectedValueOnce(
      new Error(
        "API error (409): Application demo already has an in-progress deployment",
      ),
    );
    await expect(
      tools.get("deploy_application")!.handler({ applicationId: "a1" }),
    ).rejects.toThrow(/API error \(409\): Application demo already has/);
    call.mockRejectedValueOnce(
      new Error(
        "Forbidden (403): Forbidden resource — your account is not allowed to perform this operation (some endpoints require the ADMIN role)",
      ),
    );
    await expect(
      tools.get("deploy_application")!.handler({ applicationId: "a1" }),
    ).rejects.toThrow(/Forbidden \(403\)/);
  });
});

// ---------------------------------------------------------------------------
// NF-06: deploy_app (deploy by application NAME)
// ---------------------------------------------------------------------------
describe("deploy_app", () => {
  it("resolves the name via GET /applications then POSTs the deploy route", async () => {
    // first call: GET /applications
    call.mockResolvedValueOnce([
      { id: "a1", name: "demo", version: "1.0.0" },
      { id: "a2", name: "other", version: "2.0.0" },
    ]);
    call.mockResolvedValueOnce({ id: "d1", status: "pending" });
    const out = parse(
      await tools.get("deploy_app")!.handler({ appName: "demo" }),
    );
    expect(call).toHaveBeenNthCalledWith(1, "GET", "/applications");
    expect(call).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/app-deployments/applications/a1/deploy",
      {},
    );
    expect(out.id).toBe("d1");
  });

  it("does not call the deploy route when the name is unknown", async () => {
    call.mockResolvedValueOnce([{ id: "a2", name: "other" }]);
    const out = parse(
      await tools.get("deploy_app")!.handler({ appName: "nope" }),
    );
    expect(call).toHaveBeenCalledTimes(1); // only the GET /applications lookup
    expect(out.error).toMatch(/Application "nope" not found/);
    expect(out.available).toEqual(["other"]);
  });

  it("accepts the { list } envelope for the application lookup", async () => {
    call.mockResolvedValueOnce({ list: [{ id: "a1", name: "demo" }] });
    call.mockResolvedValueOnce({ id: "d2", status: "pending" });
    await tools.get("deploy_app")!.handler({
      appName: "demo",
      executorId: "e1",
      env: { K: "V" },
    });
    expect(call).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/app-deployments/applications/a1/deploy",
      { executorId: "e1", env: { K: "V" } },
    );
  });

  it("surfaces pending_approval (dispatched:false) and upstream errors", async () => {
    call.mockResolvedValueOnce([{ id: "a1", name: "demo" }]);
    call.mockResolvedValueOnce({
      id: "d3",
      approvalStatus: "pending_approval",
    });
    const out = parse(
      await tools.get("deploy_app")!.handler({ appName: "demo" }),
    );
    expect(out.dispatched).toBe(false);
    expect(out.note).toContain("/approval/approve");

    call.mockRejectedValueOnce(
      new Error("Forbidden (403): Forbidden resource"),
    );
    await expect(
      tools.get("deploy_app")!.handler({ appName: "demo" }),
    ).rejects.toThrow(/Forbidden \(403\)/);
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
          appName: "A",
          address: "x:1",
          status: "online",
          deadLetterCount: 3,
        },
        {
          id: "b",
          appName: "B",
          address: "x:2",
          status: "online",
          deadLetterCount: 9,
        },
        {
          id: "c",
          appName: "C",
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

  it("PK-18: reads the executor appName field (entity has no name) into the output name", async () => {
    // 回归钉：GET /executors 返回行透传实体字段，只有 appName 没有
    // name——旧代码读 r["name"] 恒为 undefined，工具输出 name 永远为空。
    call.mockResolvedValueOnce({
      data: [{ id: "a", appName: "edge-runner", deadLetterCount: 1 }],
    });
    const out = parse(await tools.get("list_dead_letters")!.handler({}));
    expect(out.executors[0].name).toBe("edge-runner");
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

  it("flags unhealthy when the failed queue depth is large and treats a null queue (Redis down) as unhealthy", async () => {
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
    // PK-05: Redis 不可达 → 队列指标全 null，不得默认健康——
    // healthy=false + degraded 说明字段（此前测试固化了 healthy=true 的错误行为）
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
    expect(out2.healthy).toBe(false);
    expect(out2.degraded).toMatch(/queue metrics unavailable/i);
    expect(out2.degraded).toMatch(/Redis/i);
  });

  it("stays healthy with small failed depth and flags large-but-numeric depth (PK-05 normal bands)", async () => {
    call.mockResolvedValueOnce({
      counters: {},
      derived: {},
      queue: { waiting: 1, active: 1, delayed: 0, failed: 50, completed: 10 },
    });
    const out = parse(await tools.get("get_scheduler_health")!.handler({}));
    expect(out.healthy).toBe(true);
    expect(out.degraded).toBeUndefined();

    call.mockResolvedValueOnce({
      counters: {},
      derived: {},
      queue: { waiting: 1, active: 1, delayed: 0, failed: 150, completed: 10 },
    });
    const outHigh = parse(await tools.get("get_scheduler_health")!.handler({}));
    expect(outHigh.healthy).toBe(false);
    expect(outHigh.degraded).toBeUndefined();
  });
});

// NF-06: retry_execution — the API has no native retry endpoint, so the tool
// replays the original execution's params through the manual trigger route.
describe("retry_execution", () => {
  it("fetches the original execution and POSTs /tasks/:id/trigger with the replayed params", async () => {
    call.mockResolvedValueOnce({
      id: "e1",
      taskId: "t1",
      status: "failed",
      params: { url: "http://x" },
    });
    call.mockResolvedValueOnce({ id: "e9", taskId: "t1", status: "pending" });
    const out = parse(
      await tools
        .get("retry_execution")!
        .handler({ taskId: "t1", executionId: "e1" }),
    );
    expect(call).toHaveBeenNthCalledWith(1, "GET", "/tasks/executions/e1");
    expect(call).toHaveBeenNthCalledWith(2, "POST", "/tasks/t1/trigger", {
      params: { url: "http://x" },
    });
    expect(out.retriedFrom).toBe("e1");
    expect(out.id).toBe("e9");
  });

  it("explicit params override the replay and omit the params body when the original had none", async () => {
    call.mockResolvedValueOnce({ id: "e2", taskId: "t1", status: "timeout", params: null });
    call.mockResolvedValueOnce({ id: "e10", status: "pending" });
    await tools
      .get("retry_execution")!
      .handler({ taskId: "t1", executionId: "e2" });
    expect(call).toHaveBeenNthCalledWith(2, "POST", "/tasks/t1/trigger", {});

    await tools
      .get("retry_execution")!
      .handler({ taskId: "t1", executionId: "e2", params: { a: 1 } });
    // explicit params skips the GET lookup entirely
    expect(call).toHaveBeenLastCalledWith("POST", "/tasks/t1/trigger", {
      params: { a: 1 },
    });
  });

  it("surfaces upstream 404 verbatim (execution not found)", async () => {
    call.mockRejectedValueOnce(
      new Error("API error (404): Execution record not found"),
    );
    await expect(
      tools.get("retry_execution")!.handler({ taskId: "t1", executionId: "nope" }),
    ).rejects.toThrow(/API error \(404\): Execution record not found/);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("update_task error passthrough (NF-06)", () => {
  it("bubbles 400/403/404 messages from the api layer unchanged", async () => {
    call.mockRejectedValueOnce(
      new Error(
        "Bad request (400): property executorId should be a valid UUID",
      ),
    );
    await expect(
      tools.get("update_task")!.handler({ taskId: "t1", executorId: "not-a-uuid" }),
    ).rejects.toThrow(/Bad request \(400\): property executorId should be a valid UUID/);
    call.mockRejectedValueOnce(
      new Error(
        "Forbidden (403): Forbidden resource — your account is not allowed to perform this operation (some endpoints require the ADMIN role)",
      ),
    );
    await expect(
      tools.get("update_task")!.handler({ taskId: "t1", name: "x" }),
    ).rejects.toThrow(/Forbidden \(403\)/);
    call.mockRejectedValueOnce(new Error("API error (404): Task not found"));
    await expect(
      tools.get("update_task")!.handler({ taskId: "missing", name: "x" }),
    ).rejects.toThrow(/API error \(404\): Task not found/);
  });
});

describe("pause_task / resume_task (NF-06)", () => {
  it("POSTs their dedicated routes and passes the task through", async () => {
    call.mockResolvedValueOnce({ id: "t1", status: "paused" });
    const paused = parse(
      await tools.get("pause_task")!.handler({ taskId: "t1" }),
    );
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t1/pause");
    expect(paused.status).toBe("paused");
    call.mockResolvedValueOnce({ id: "t1", status: "active" });
    const resumed = parse(
      await tools.get("resume_task")!.handler({ taskId: "t1" }),
    );
    expect(call).toHaveBeenCalledWith("POST", "/tasks/t1/resume");
    expect(resumed.status).toBe("active");
  });

  it("bubbles the already-paused 400 and missing-task 404 verbatim", async () => {
    call.mockRejectedValueOnce(
      new Error("API error (400): Task is already paused"),
    );
    await expect(
      tools.get("pause_task")!.handler({ taskId: "t1" }),
    ).rejects.toThrow(/API error \(400\): Task is already paused/);
    call.mockRejectedValueOnce(new Error("API error (404): Task not found"));
    await expect(
      tools.get("resume_task")!.handler({ taskId: "missing" }),
    ).rejects.toThrow(/API error \(404\): Task not found/);
  });
});

describe("trigger_task error passthrough (NF-06)", () => {
  it("bubbles the 404 task-not-found message", async () => {
    call.mockRejectedValueOnce(new Error("API error (404): Task not found"));
    await expect(
      tools.get("trigger_task")!.handler({ taskId: "missing" }),
    ).rejects.toThrow(/API error \(404\): Task not found/);
  });
});

// ---------------------------------------------------------------------------
// E-1: task definition export/import
// ---------------------------------------------------------------------------
describe("export_task", () => {
  it("GETs /tasks/:id/export and returns the payload verbatim (round-trippable into import_task)", async () => {
    const payload = {
      schemaVersion: "1",
      exportedAt: "2026-10-05T00:00:00.000Z",
      task: {
        name: "Nightly sync",
        triggerType: "cron",
        cronExpression: "0 2 * * *",
        runtime: "python",
      },
    };
    call.mockResolvedValueOnce(payload);
    const out = parse(await tools.get("export_task")!.handler({ taskId: "t1" }));
    expect(call).toHaveBeenCalledWith("GET", "/tasks/t1/export");
    // 导出物必须逐字透传：POST /tasks/import 开 forbidNonWhitelisted，
    // 工具面若在此加包装键（note/hint 等）会让回灌 import 直接 400。
    expect(out).toEqual(payload);
    expect(Object.keys(out)).toEqual(["schemaVersion", "exportedAt", "task"]);
  });

  it("bubbles the 404 task-not-found message verbatim", async () => {
    call.mockRejectedValueOnce(new Error("API error (404): Task not found"));
    await expect(
      tools.get("export_task")!.handler({ taskId: "missing" }),
    ).rejects.toThrow(/API error \(404\): Task not found/);
  });
});

describe("import_task", () => {
  const PAYLOAD = {
    schemaVersion: "1",
    exportedAt: "2026-10-05T00:00:00.000Z",
    task: { name: "Nightly sync", triggerType: "cron", runtime: "python" },
  };
  const RESULT = {
    taskId: "t-new",
    name: "Nightly sync (imported)",
    warnings: [
      "Task secrets are never part of the export/import payload (SEC-02 red line) — the imported task has NO secrets configured; reconfigure them via PATCH /tasks/:id before running it.",
    ],
  };

  it("accepts the export_task JSON text verbatim, POSTs the parsed payload and passes taskId/warnings through", async () => {
    call.mockResolvedValueOnce(RESULT);
    const out = parse(
      await tools
        .get("import_task")!
        .handler({ payload: JSON.stringify(PAYLOAD) }),
    );
    expect(call).toHaveBeenCalledWith("POST", "/tasks/import", PAYLOAD);
    expect(out.taskId).toBe("t-new");
    expect(out.name).toBe("Nightly sync (imported)");
    expect(out.warnings).toHaveLength(1);
  });

  it("accepts the equivalent structured object as-is (no re-keying)", async () => {
    call.mockResolvedValueOnce(RESULT);
    await tools.get("import_task")!.handler({ payload: PAYLOAD });
    expect(call).toHaveBeenCalledWith("POST", "/tasks/import", PAYLOAD);
  });

  it("marks a non-JSON string as a usage error without a network call", async () => {
    const r = await tools
      .get("import_task")!
      .handler({ payload: "{not json" });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/not valid JSON/);
    expect(call).not.toHaveBeenCalled();
  });

  it("marks a payload missing the schemaVersion/task keys as a usage error without a network call", async () => {
    // 裸 task 对象是最常见的误用（直接把 POST /tasks 的 body 当导入物传回）。
    const r = await tools
      .get("import_task")!
      .handler({ payload: { task: { name: "x" } } });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/schemaVersion/);
    expect(call).not.toHaveBeenCalled();

    const r2 = await tools
      .get("import_task")!
      .handler({ payload: { schemaVersion: "1" } });
    expect(r2.isError).toBe(true);
    expect(parse(r2).error).toMatch(/task/);
    expect(call).not.toHaveBeenCalled();
  });

  it("bubbles upstream 400/409 messages verbatim (invalid payload / all name candidates conflict)", async () => {
    call.mockRejectedValueOnce(
      new Error("API error (400): property task.name must not be empty"),
    );
    await expect(
      tools
        .get("import_task")!
        .handler({ payload: JSON.stringify({ schemaVersion: "1", task: {} }) }),
    ).rejects.toThrow(/API error \(400\)/);
    call.mockRejectedValueOnce(
      new Error("API error (409): all name candidates conflict"),
    );
    await expect(
      tools.get("import_task")!.handler({ payload: PAYLOAD }),
    ).rejects.toThrow(/API error \(409\)/);
  });
});

// ---------------------------------------------------------------------------
// CORE-03: server-side task templates
// ---------------------------------------------------------------------------
describe("list_task_templates", () => {
  it("GETs /task-templates and passes the list through", async () => {
    const rows = [
      {
        id: "550e8400-e29b-41d4-a716-446655440010",
        key: "scheduled_backup",
        name: "定时备份",
        config: { triggerType: "cron" },
        isOfficial: true,
      },
    ];
    call.mockResolvedValueOnce(rows);
    const out = parse(await tools.get("list_task_templates")!.handler({}));
    expect(call).toHaveBeenCalledWith("GET", "/task-templates");
    expect(out).toEqual(rows);
  });
});

describe("create_task_from_template (CORE-03 server-side instantiate)", () => {
  const OFFICIAL_ROW = {
    id: "550e8400-e29b-41d4-a716-446655440010",
    key: "scheduled_backup",
    name: "定时备份",
    description: "周期性备份任务：Cron 定时触发（默认每天 02:00）。",
    config: {
      triggerType: "cron",
      cronExpression: "0 2 * * *",
      runtime: "shell",
      entrypoint: "backup.sh",
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: "discard",
    },
    isOfficial: true,
  };

  it("resolves the template key via GET /task-templates and POSTs :id/instantiate with name + template description default", async () => {
    call.mockResolvedValueOnce([OFFICIAL_ROW]);
    call.mockResolvedValueOnce({
      id: "t9",
      name: "nightly-db",
      status: "paused",
      triggerType: "cron",
      runtime: "shell",
    });
    const out = parse(
      await tools
        .get("create_task_from_template")!
        .handler({ template: "scheduled_backup", name: "nightly-db" }),
    );
    expect(call).toHaveBeenNthCalledWith(1, "GET", "/task-templates");
    expect(call).toHaveBeenNthCalledWith(
      2,
      "POST",
      `/task-templates/${OFFICIAL_ROW.id}/instantiate`,
      // 模板 config 不再由客户端展开（config 是服务端默认值）；
      // description 缺省沿用模板 blurb，name 兜底必带。
      { description: OFFICIAL_ROW.description, name: "nightly-db" },
    );
    expect(out).toEqual({
      id: "t9",
      name: "nightly-db",
      status: "paused",
      triggerType: "cron",
      runtime: "shell",
    });
  });

  it("accepts a template uuid as well as a key", async () => {
    call.mockResolvedValueOnce([OFFICIAL_ROW]);
    call.mockResolvedValueOnce({ id: "t10", name: "by-uuid" });
    await tools
      .get("create_task_from_template")!
      .handler({ template: OFFICIAL_ROW.id, name: "by-uuid" });
    expect(call).toHaveBeenNthCalledWith(
      2,
      "POST",
      `/task-templates/${OFFICIAL_ROW.id}/instantiate`,
      { description: OFFICIAL_ROW.description, name: "by-uuid" },
    );
  });

  it("applies overrides on top of the template defaults and keeps name > overrides > explicit description > template blurb precedence", async () => {
    call.mockResolvedValueOnce([OFFICIAL_ROW]);
    call.mockResolvedValueOnce({ id: "t11", name: "weekly-backup" });
    await tools
      .get("create_task_from_template")!
      .handler({
        template: "scheduled_backup",
        name: "weekly-backup",
        description: "weekly variant",
        overrides: {
          cronExpression: "0 4 * * 1",
          description: "override wins",
          params: { db: "primary" },
        },
      });
    expect(call).toHaveBeenNthCalledWith(
      2,
      "POST",
      `/task-templates/${OFFICIAL_ROW.id}/instantiate`,
      {
        // 显式 description 压过模板 blurb，但 overrides.description 最后落
        // （与旧本地展开工具的优先级一致）；其余 override 原样透传。
        description: "override wins",
        cronExpression: "0 4 * * 1",
        params: { db: "primary" },
        name: "weekly-backup",
      },
    );
  });

  it("omits the description key when the template has none and the caller passes none", async () => {
    call.mockResolvedValueOnce([{ id: "tpl-2", key: "data_sync", description: null }]);
    call.mockResolvedValueOnce({ id: "t12", name: "sync" });
    await tools
      .get("create_task_from_template")!
      .handler({ template: "data_sync", name: "sync" });
    const [, , body] = call.mock.calls[1];
    expect("description" in (body as object)).toBe(false);
    expect(body).toEqual({ name: "sync" });
  });

  it("returns the available keys with a list_task_templates hint on an unknown template (no instantiate call)", async () => {
    call.mockResolvedValueOnce([
      { id: "tpl-1", key: "scheduled_backup" },
      { id: "tpl-2", key: "webhook_ping" },
    ]);
    const out = parse(
      await tools
        .get("create_task_from_template")!
        .handler({ template: "nope", name: "x" }),
    );
    expect(call).toHaveBeenCalledTimes(1); // only the GET /task-templates lookup
    expect(out.error).toMatch(/Unknown template "nope"/);
    expect(out.error).toMatch(/list_task_templates/);
    expect(out.available).toEqual(["scheduled_backup", "webhook_ping"]);
  });

  it("bubbles a GET /task-templates failure verbatim (older admin-api without CORE-03)", async () => {
    call.mockRejectedValueOnce(new Error("API error (404): Cannot GET /task-templates"));
    await expect(
      tools
        .get("create_task_from_template")!
        .handler({ template: "scheduled_backup", name: "x" }),
    ).rejects.toThrow(/API error \(404\)/);
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


// ────────────────────────────────────────────────────────────
// AUTH-02-B（R18）: project tools — read-only trio
// ────────────────────────────────────────────────────────────
describe("project tools (read-only)", () => {
  it("list_projects hits GET /projects and returns the filtered view", async () => {
    call.mockResolvedValueOnce([
      { id: "p-default", name: "Default", myRole: null },
      { id: "p1", name: "Alpha", myRole: "editor" },
    ]);
    await tools.get("list_projects")!.handler({});
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/projects");
  });

  it("get_project_members hits GET /projects/:id/members", async () => {
    await tools.get("get_project_members")!.handler({ projectId: "p1" });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/projects/p1/members");
  });

  it("get_my_project_roles hits GET /projects/me/roles", async () => {
    call.mockResolvedValueOnce({
      userId: 7,
      isAdmin: false,
      memberships: [{ projectId: "p1", role: "viewer" }],
    });
    await tools.get("get_my_project_roles")!.handler({});
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/projects/me/roles");
  });
});

// ---------------------------------------------------------------------------
// SOP / agent sessions (P5/P6 admin-side minimal loop)
// ---------------------------------------------------------------------------
describe("sop_list", () => {
  it("GETs /sop with page/pageSize and optional status", async () => {
    await tools.get("sop_list")!.handler({
      status: "published",
      page: 2,
      pageSize: 10,
    });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/sop?page=2&pageSize=10&status=published");
  });

  it("omits the status filter when absent", async () => {
    await tools.get("sop_list")!.handler({ page: 1, pageSize: 20 });
    expect(call.mock.calls[0][1]).toBe("/sop?page=1&pageSize=20");
  });
});

describe("sop_get", () => {
  it("GETs /sop/:id", async () => {
    await tools.get("sop_get")!.handler({
      sopId: "550e8400-e29b-41d4-a716-446655440000",
    });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/sop/550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("sop_assignments_pending", () => {
  const SOP_ID = "550e8400-e29b-41d4-a716-446655440001";
  const ASG_ID = "550e8400-e29b-41d4-a716-446655440002";

  it("lists a SOP's assignments filtered to non-terminal statuses", async () => {
    call.mockResolvedValueOnce([
      { id: "a1", status: "assigned" },
      { id: "a2", status: "in_progress" },
      { id: "a3", status: "blocked" },
      { id: "a4", status: "stalled" },
      { id: "a5", status: "completed" },
      { id: "a6", status: "failed" },
      { id: "a7", status: "cancelled" },
    ]);
    const out = await tools.get("sop_assignments_pending")!.handler({
      sopId: SOP_ID,
    });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe(`/sop/${SOP_ID}/assignments`);
    const payload = parse(out);
    expect(payload.sopId).toBe(SOP_ID);
    expect(payload.pendingCount).toBe(4);
    expect(payload.items.map((r: { id: string }) => r.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
  });

  it("SOP_PENDING_STATUSES excludes every terminal status", () => {
    const terminals = ["completed", "failed", "cancelled"];
    for (const t of terminals) {
      expect(SOP_PENDING_STATUSES).not.toContain(t);
    }
  });

  it("assignmentId form fetches the full detail (with clarifications)", async () => {
    call.mockResolvedValueOnce({ assignment: { id: ASG_ID }, clarifications: [] });
    const out = await tools.get("sop_assignments_pending")!.handler({
      assignmentId: ASG_ID,
    });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe(`/sop/assignments/${ASG_ID}`);
    expect(parse(out).assignment.id).toBe(ASG_ID);
  });

  it("without either id returns a usage error and makes no HTTP call", async () => {
    const out = await tools.get("sop_assignments_pending")!.handler({});
    expect(call).not.toHaveBeenCalled();
    expect(parse(out).error).toContain("sopId");
  });
});

describe("agent_session_list / agent_session_get", () => {
  it("agent_session_list GETs /agent/sessions with kind/status filters", async () => {
    await tools.get("agent_session_list")!.handler({
      kind: "incident",
      status: "waiting_input",
      page: 1,
      pageSize: 20,
    });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/agent/sessions?page=1&pageSize=20&kind=incident&status=waiting_input");
  });

  it("agent_session_list omits filters that were not provided", async () => {
    await tools.get("agent_session_list")!.handler({ page: 1, pageSize: 20 });
    expect(call.mock.calls[0][1]).toBe("/agent/sessions?page=1&pageSize=20");
  });

  it("agent_session_get GETs /agent/sessions/:id", async () => {
    await tools.get("agent_session_get")!.handler({
      sessionId: "550e8400-e29b-41d4-a716-446655440003",
    });
    const [method, path] = call.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe("/agent/sessions/550e8400-e29b-41d4-a716-446655440003");
  });
});

describe("sop_clarification_reply", () => {
  const ASG_ID = "550e8400-e29b-41d4-a716-446655440002";
  const CLR_ID = "550e8400-e29b-41d4-a716-446655440004";

  it("POSTs the reply route with resolution/answer and drops unset amendment fields", async () => {
    const out = await tools.get("sop_clarification_reply")!.handler({
      assignmentId: ASG_ID,
      clarificationId: CLR_ID,
      resolution: "answered",
      answer: "在页面右上角",
    });
    const [method, path, body] = call.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe(
      `/sop/assignments/${ASG_ID}/clarifications/${CLR_ID}/reply`,
    );
    expect(body).toEqual({ resolution: "answered", answer: "在页面右上角" });
    expect(parse(out)).toEqual({ ok: true });
  });

  it("sop_amended carries the amended SOP fields when provided", async () => {
    await tools.get("sop_clarification_reply")!.handler({
      assignmentId: ASG_ID,
      clarificationId: CLR_ID,
      resolution: "sop_amended",
      answer: "改为按新版执行",
      amendedFrontMatterYaml: "capabilities: [gui]",
      amendedBodyMarkdown: "# Revised",
      changelog: "add gui",
    });
    const [, , body] = call.mock.calls[0];
    expect(body).toEqual({
      resolution: "sop_amended",
      answer: "改为按新版执行",
      amendedFrontMatterYaml: "capabilities: [gui]",
      amendedBodyMarkdown: "# Revised",
      changelog: "add gui",
    });
  });
});

// ────────────────────────────────────────────────────────────
// D1-P2-2: path-interpolated id params must be UUID-validated at the input
// schema layer (path-traversal guard). The fake-server harness stores the zod
// shape without running it, so we drive .parse() directly against each id field.
// ────────────────────────────────────────────────────────────
describe("D1-P2-2 path id UUID validation", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
  const malformed = [
    "../../etc",
    "t1",
    "..%2Fadmin",
    "abc/def",
    "550e8400-e29b-41d4-a716-446655440000/extra",
  ];

  // [tool name, field name] pairs whose id is interpolated into a URL path.
  const pathIdFields: Array<[string, string]> = [
    ["get_task", "taskId"],
    ["trigger_task", "taskId"],
    ["update_task", "taskId"],
    ["list_task_versions", "taskId"],
    ["rollback_task_version", "taskId"],
    ["rollback_task_version", "versionId"],
    ["compare_task_versions", "taskId"],
    ["get_execution", "executionId"],
    ["analyze_execution", "executionId"],
    ["get_execution_logs", "executionId"],
    ["kill_execution", "taskId"],
    ["retry_execution", "executionId"],
    ["get_execution_stats", "taskId"],
    ["pause_task", "taskId"],
    ["resume_task", "taskId"],
    ["get_application", "applicationId"],
    ["update_application", "applicationId"],
    ["delete_application", "applicationId"],
    ["analyze_application", "applicationId"],
    ["deploy_application", "applicationId"],
    ["upgrade_deployment", "deploymentId"],
    ["stop_deployment", "deploymentId"],
    ["approve_deployment", "deploymentId"],
    ["reject_deployment", "deploymentId"],
    ["cancel_deployment", "deploymentId"],
    ["get_executor", "executorId"],
    ["get_executor_metrics", "executorId"],
    ["get_execution_timeline", "executionId"],
    ["get_project_members", "projectId"],
    ["sop_get", "sopId"],
    ["sop_assignments_pending", "sopId"],
    ["sop_assignments_pending", "assignmentId"],
    ["agent_session_get", "sessionId"],
    ["sop_clarification_reply", "assignmentId"],
    ["sop_clarification_reply", "clarificationId"],
  ];

  type ZodLike = { parse: (v: unknown) => unknown };
  const fieldSchema = (tool: string, field: string): ZodLike =>
    (tools.get(tool)!.schema as Record<string, ZodLike>)[field];

  it("accepts a well-formed UUID on every path id field", () => {
    for (const [tool, field] of pathIdFields) {
      expect(() => fieldSchema(tool, field).parse(VALID_UUID), `${tool}.${field}`).not.toThrow();
    }
  });

  it("rejects path-traversal / non-UUID values before they reach the network", () => {
    for (const [tool, field] of pathIdFields) {
      for (const bad of malformed) {
        expect(
          () => fieldSchema(tool, field).parse(bad),
          `${tool}.${field} rejects ${JSON.stringify(bad)}`,
        ).toThrow();
      }
    }
  });

  it("still accepts an absent optional id filter", () => {
    const taskIdFilter = (tools.get("list_executions")!.schema as Record<string, ZodLike>).taskId;
    expect(() => taskIdFilter.parse(undefined)).not.toThrow();
    expect(() => taskIdFilter.parse(VALID_UUID)).not.toThrow();
  });
});
