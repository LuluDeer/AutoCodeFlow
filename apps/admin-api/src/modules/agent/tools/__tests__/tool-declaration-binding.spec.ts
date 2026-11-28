import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AgentApiClient } from "../agent-api.client";
import { ToolBinderService } from "../tool-binder.service";
import {
  AGENT_TOOL_BY_NAME,
  ALL_AGENT_TOOL_SPECS,
  type AgentToolSpec,
} from "../tool-registry";
import {
  GATE_INVENTORY,
  HARDENED_WRITE_TOOLS,
  auditGateInventory,
  auditToolHardening,
  formatToolHardeningAudit,
  isGateInventoryClean,
  isToolHardeningClean,
  unboundDeclaredTools,
} from "../gate-inventory";
import { AgentBoundaryService } from "../../boundary/agent-boundary.service";
import { AuditService } from "../../../audit/audit.service";
import { ProjectsService } from "../../../project/projects.service";
import { ProjectAccessService } from "../../../project/project-access.service";
import { SchedulerService } from "../../../scheduler/scheduler.service";
import {
  DeploymentApprovalStatus,
  DeploymentTriggerType,
} from "../../../application/entities/app-deployment.entity";

/**
 * 真实进程内对账（假 Service / 假 ModuleRef，真 AgentApiClient + 真 ToolBinderService）：
 * 「LLM 看到的 function schema」与「AgentApiClient 的 handler 表」必须一致。
 *
 * 此前 registry 里有一批工具对模型可见、binder 却没有 register ⇒ 每次调用
 * 都得到「没有绑定执行体」。本 spec 遍历**全部声明工具**，逐个 invoke 钉住
 * 这件事不再发生；同时核对 gate-inventory 的「无 unbound 条目」口径确实
 * 由真实 handler 表支撑，而不是只写在注释里。
 */

function stub(
  methods: readonly string[],
  overrides: Record<string, unknown> = {},
) {
  const out: Record<string, jest.Mock> = {};
  for (const name of methods) {
    out[name] = jest.fn(async () => ({ ok: true }));
  }
  for (const [name, value] of Object.entries(overrides)) {
    out[name] = jest.fn(
      typeof value === "function"
        ? (value as (...a: unknown[]) => unknown)
        : async () => value,
    );
  }
  return out;
}

function harness() {
  const api = new AgentApiClient();

  const tasks = stub(
    [
      "findAll",
      "findOne",
      "getExecutions",
      "getAllExecutions",
      "getExecution",
      "getExecutionLogs",
      "getExecutionStats",
      "getVersions",
      "compareVersions",
      "getExecutionReport",
      "analyzeExecution",
      "suggestSchedule",
      "trigger",
      "killExecution",
      "pause",
      "resume",
      "update",
      "rollbackToVersion",
    ],
    { getExecution: async (id: string) => ({ id, params: { k: "v" } }) },
  );
  const executors = stub(
    ["findAll", "findOne", "getExecutorMetrics", "findByAddress"],
    {
      findAll: async () => [
        {
          id: "exec-1",
          appName: "node-1",
          address: "127.0.0.1:9000",
          status: "online",
          deadLetterCount: 3,
        },
        {
          id: "exec-2",
          appName: "node-2",
          address: "127.0.0.1:9001",
          status: "offline",
          deadLetterCount: null,
        },
      ],
    },
  );
  const applications = stub([
    "findAll",
    "findById",
    "analyzeHealth",
    "create",
    "update",
    "remove",
  ]);
  const deployments = stub(
    ["deploy", "cancelDeployment", "findAll", "stop", "upgrade", "findById"],
    {
      findById: async (id: string) => ({ id, applicationId: "app-1" }),
    },
  );
  const templates = stub(["instantiate"]);
  const mutexGroups = stub(["findAll", "create", "update", "remove"]);
  const sops = stub([
    "list",
    "getSop",
    "getBySlug",
    "draft",
    "publish",
    "assign",
    "replyClarification",
  ]);
  const toolCalls = stub(["findOne"]);
  const steps = stub(["find"]);
  const config = { get: jest.fn(() => undefined) };

  const audit = stub(["findAll"], {
    findAll: async () => ({ data: [], total: 0 }),
  });
  const projects = stub(["findAll"], { findAll: async () => [] });
  const projectAccess = stub(["listMembers", "listRolesForUser"]);
  const scheduler = stub(["getSchedulerMetrics", "getStats"], {
    getSchedulerMetrics: async () => ({
      counters: {
        triggerLatencyCount: 2,
        lastTriggerLatencyMs: 11,
      },
      derived: { avgTriggerLatencyMs: 10, p99TriggerLatencyMs: 20 },
      queue: {
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      },
    }),
    getStats: () => ({ isLeader: true, activeTimers: 1 }),
  });

  const providers = new Map<unknown, unknown>([
    [AuditService, audit],
    [ProjectsService, projects],
    [ProjectAccessService, projectAccess],
    [SchedulerService, scheduler],
  ]);
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      const hit = providers.get(token);
      if (!hit) throw new Error(`provider not registered: ${String(token)}`);
      return hit;
    }),
  };

  const binder = new ToolBinderService(
    api as never,
    tasks as never,
    executors as never,
    applications as never,
    deployments as never,
    templates as never,
    mutexGroups as never,
    sops as never,
    toolCalls as never,
    steps as never,
    config as never,
    moduleRef as never,
  );
  binder.onModuleInit();

  return {
    api,
    binder,
    binderSource: readFileSync(
      join(__dirname, "..", "tool-binder.service.ts"),
      "utf8",
    ),
    tasks,
    executors,
    applications,
    deployments,
    templates,
    mutexGroups,
    sops,
    toolCalls,
    steps,
    audit,
    projects,
    projectAccess,
    scheduler,
    moduleRef,
  };
}

const specOf = (name: string): AgentToolSpec => AGENT_TOOL_BY_NAME.get(name)!;

describe("声明面 == 执行面（真实 AgentApiClient + 真 binder）", () => {
  it("所有非 hardDisabled 的声明工具都有 handler；unboundDeclaredTools 为空", () => {
    const { api } = harness();
    const implemented = new Set(api.implementedTools());

    const unbound = unboundDeclaredTools(ALL_AGENT_TOOL_SPECS, implemented);
    expect(unbound).toEqual([]);

    for (const s of ALL_AGENT_TOOL_SPECS) {
      if (s.hardDisabled === true) continue;
      expect({ name: s.name, bound: implemented.has(s.name) }).toEqual({
        name: s.name,
        bound: true,
      });
    }

    // 硬禁用的审批类工具是唯一允许没有 handler 的声明：闸门在 invoke 前拦下
    const hardDisabled = ALL_AGENT_TOOL_SPECS.filter(
      (s) => s.hardDisabled === true,
    ).map((s) => s.name);
    expect(hardDisabled).toEqual(["approve_deployment", "reject_deployment"]);
    for (const name of hardDisabled) expect(implemented.has(name)).toBe(false);
  });

  it("逐个 invoke 全部声明工具：不会再得到「没有绑定执行体」", async () => {
    const { api } = harness();
    const hardDisabled = new Set(
      ALL_AGENT_TOOL_SPECS.filter((s) => s.hardDisabled === true).map(
        (s) => s.name,
      ),
    );

    for (const s of ALL_AGENT_TOOL_SPECS) {
      const res = await api.invoke(s, {}, { sessionId: "sess-1" });
      const unbound = (res.errorMessage ?? "").includes("没有绑定执行体");
      if (hardDisabled.has(s.name)) {
        // 硬禁用工具刻意不绑定 handler，闸门在 invoke 前拦下。
        expect({ name: s.name, unbound }).toEqual({
          name: s.name,
          unbound: true,
        });
        continue;
      }
      if (res.isError) {
        // 假 Service 可能因为空参数报错；那不是装配错误，允许。
        expect({
          name: s.name,
          unbound,
        }).toEqual({ name: s.name, unbound: false });
      } else {
        expect(res.data).not.toBeUndefined();
      }
    }
  });

  it("gate-inventory 的「无 unbound 条目」由真实 handler 表支撑", () => {
    const { api } = harness();
    const audit = auditGateInventory(ALL_AGENT_TOOL_SPECS);
    expect(isGateInventoryClean(audit)).toBe(true);
    expect(GATE_INVENTORY.filter((e) => e.kind === "unbound")).toEqual([]);
    expect(
      unboundDeclaredTools(
        ALL_AGENT_TOOL_SPECS,
        new Set(api.implementedTools()),
      ),
    ).toEqual([]);
  });

  it("错误文案只有工具名 + tier + 装配事实，不带阶段叙事", async () => {
    const { api } = harness();
    const ghost = { ...specOf("update_task"), name: "missing_write_tool" };
    const res = await api.invoke(ghost, {});

    expect(res.isError).toBe(true);
    expect(res.errorMessage).toContain("missing_write_tool");
    expect(res.errorMessage).toContain("tier=write");
    expect(res.errorMessage).toContain("没有绑定执行体");
    expect(res.errorMessage).not.toContain("P3");
    expect(res.errorMessage).not.toContain("只读工具");
    expect(res.errorMessage).not.toContain("尚未实现");
  });
});

describe("新绑定的执行体复用既有 Service", () => {
  it("任务配置写面：update_task / rollback_task_version", async () => {
    const { api, tasks } = harness();

    await api.invoke(specOf("update_task"), {
      taskId: "t-1",
      patch: { description: "hello" },
    });
    expect(tasks.update).toHaveBeenCalledWith(
      "t-1",
      { description: "hello" },
      undefined,
    );

    await api.invoke(specOf("rollback_task_version"), {
      taskId: "t-1",
      versionId: "v-7",
    });
    expect(tasks.rollbackToVersion).toHaveBeenCalledWith(
      "t-1",
      "v-7",
      undefined,
    );

    // 空 patch 是明确参数错误，不是「没实现」
    const bad = await api.invoke(specOf("update_task"), {
      taskId: "t-1",
      patch: {},
    });
    expect(bad.isError).toBe(true);
    expect(bad.errorMessage).toContain("patch 为空");
  });

  it("部署面：list / pending / stop / upgrade 各自走对应 service 方法", async () => {
    const { api, deployments } = harness();

    await api.invoke(specOf("list_deployments"), {
      applicationId: "app-1",
      page: "2",
      pageSize: "5",
    });
    expect(deployments.findAll).toHaveBeenCalledWith("app-1", 2, 5);

    await api.invoke(specOf("list_pending_approvals"), {});
    expect(deployments.findAll).toHaveBeenCalledWith(
      undefined,
      1,
      20,
      DeploymentApprovalStatus.PENDING_APPROVAL,
    );

    await api.invoke(specOf("stop_deployment"), {
      deploymentId: "d-1",
      applicationId: "app-1",
    });
    expect(deployments.findById).toHaveBeenCalledWith("d-1");
    expect(deployments.stop).toHaveBeenCalledWith("d-1");

    await api.invoke(specOf("upgrade_deployment"), {
      deploymentId: "d-1",
      applicationId: "app-1",
    });
    expect(deployments.upgrade).toHaveBeenCalledWith("d-1", {
      operator: "agent",
      triggerType: DeploymentTriggerType.UPGRADE,
    });
  });

  it("反证：deploymentId 与 applicationId 不归属同一应用 ⇒ 拒绝执行", async () => {
    const { api, deployments } = harness();

    for (const name of ["stop_deployment", "upgrade_deployment"]) {
      const res = await api.invoke(specOf(name), {
        deploymentId: "d-1",
        applicationId: "app-foreign",
      });
      expect(res.isError).toBe(true);
      expect(res.errorMessage).toContain("跨 application scope 被拒");
    }
    expect(deployments.stop).not.toHaveBeenCalled();
    expect(deployments.upgrade).not.toHaveBeenCalled();
  });

  it("反证：闸门按 applicationId 做 scope 校验，跨 application 直接 DENY", () => {
    const spec = specOf("stop_deployment");
    expect(spec.resourceKind).toBe("application");
    expect(spec.resourceIdParam).toBe("applicationId");

    const gate = new AgentBoundaryService({ get: () => undefined } as never);
    const session = {
      id: "sess-1",
      kind: "chat",
      scopeJson: { applications: ["app-allowed"] },
    };
    const denied = gate.check(
      session as never,
      "stop_deployment",
      { deploymentId: "d-1", applicationId: "app-foreign" },
      0,
    );
    expect(denied.kind).toBe("DENY");
    expect(denied.kind === "DENY" && denied.reason).toBe("out_of_scope");

    const allowedScope = gate.check(
      session as never,
      "stop_deployment",
      { deploymentId: "d-1", applicationId: "app-allowed" },
      0,
    );
    // scope 通过后才轮到审批，不应再是 out_of_scope
    expect(allowedScope.kind).toBe("NEED_APPROVAL");
  });

  it("应用删除：dangerous + 逐工具审批 + scope；无真实主体必须报错，不伪造 ADMIN", async () => {
    const { api, applications } = harness();
    const spec = specOf("delete_application");

    expect(spec.tier).toBe("dangerous");
    expect(spec.approvalRequired).toBe(true);

    const anonymous = await api.invoke(spec, { applicationId: "app-1" });
    expect(anonymous.isError).toBe(true);
    expect(anonymous.errorMessage).toContain("没有真实用户主体");
    expect(applications.remove).not.toHaveBeenCalled();

    await api.invoke(
      spec,
      { applicationId: "app-1" },
      { actor: { id: 42, role: "admin", username: "alice" } },
    );
    expect(applications.remove).toHaveBeenCalledWith("app-1", {
      id: 42,
      role: expect.anything(),
      username: "alice",
    });
  });

  it("执行器死信 / 调度健康 / 审计 / 项目面均落到既有服务", async () => {
    const { api, executors, scheduler, audit, projects, projectAccess } =
      harness();

    const letters = await api.invoke(specOf("list_dead_letters"), {});
    expect(executors.findAll).toHaveBeenCalled();
    expect(letters.data).toMatchObject({ totalDeadLetters: 3 });

    const health = await api.invoke(specOf("get_scheduler_health"), {});
    expect(scheduler.getSchedulerMetrics).toHaveBeenCalled();
    expect(health.data).toMatchObject({ healthy: true });

    await api.invoke(specOf("list_audit_logs"), {
      action: "task.rollback",
      userId: "7",
    });
    expect(audit.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.rollback", userId: 7 }),
    );

    await api.invoke(specOf("list_projects"), {});
    expect(projects.findAll).toHaveBeenCalled();

    await api.invoke(specOf("get_project_members"), { projectId: "p-1" });
    expect(projectAccess.listMembers).toHaveBeenCalledWith("p-1");
  });

  it("反证：get_my_project_roles 无主体时 isError=true；有主体才真查服务", async () => {
    const { api, projectAccess } = harness();

    const anonymous = await api.invoke(specOf("get_my_project_roles"), {});
    expect(anonymous.isError).toBe(true);
    expect(anonymous.errorMessage).toContain("没有真实用户主体");
    expect(projectAccess.listRolesForUser).not.toHaveBeenCalled();

    const withActor = await api.invoke(
      specOf("get_my_project_roles"),
      {},
      { actor: { id: 9, role: "user" } },
    );
    expect(withActor.isError).toBe(false);
    expect(projectAccess.listRolesForUser).toHaveBeenCalledWith(9);
    expect(withActor.data).toMatchObject({ userId: 9, isAdmin: false });
  });
});

describe("写工具硬化完整性判据（回归即红）", () => {
  it("当前实现通过：5 个写工具均 approvalRequired + 非 none scope + 真 service 调用", () => {
    const { api, binderSource } = harness();
    const audit = auditToolHardening(
      ALL_AGENT_TOOL_SPECS,
      new Set(api.implementedTools()),
      binderSource,
    );
    expect(formatToolHardeningAudit(audit)).toBe("");
    expect(isToolHardeningClean(audit)).toBe(true);
    expect(HARDENED_WRITE_TOOLS).toHaveLength(5);
  });

  it("反证：删 approvalRequired / 改 resourceKind=none / 伪造 ADMIN / 硬编码成功都会红", () => {
    const { api, binderSource } = harness();
    const implemented = new Set(api.implementedTools());

    const noApproval = ALL_AGENT_TOOL_SPECS.map((s) =>
      s.name === "delete_application"
        ? { ...s, approvalRequired: undefined }
        : s,
    ) as typeof ALL_AGENT_TOOL_SPECS;
    expect(
      auditToolHardening(noApproval, implemented, binderSource).missingApproval,
    ).toContain("delete_application");

    const unscoped = ALL_AGENT_TOOL_SPECS.map((s) =>
      s.name === "stop_deployment"
        ? { ...s, resourceKind: "none" as const }
        : s,
    ) as typeof ALL_AGENT_TOOL_SPECS;
    expect(
      auditToolHardening(unscoped, implemented, binderSource).unscoped,
    ).toContain("stop_deployment");

    const forged = binderSource.replace(
      'id: actor.id,\n        role: actor.role === "admin" ? UserRole.ADMIN : UserRole.USER,',
      "id: 0,\n        role: UserRole.ADMIN,",
    );
    expect(forged).not.toBe(binderSource);
    expect(
      auditToolHardening(ALL_AGENT_TOOL_SPECS, implemented, forged).forgedActor,
    ).toContain("delete_application");

    const noService = binderSource.replace(
      "return this.deployments.stop(deploymentId);",
      "return { ok: true };",
    );
    expect(noService).not.toBe(binderSource);
    expect(
      auditToolHardening(ALL_AGENT_TOOL_SPECS, implemented, noService)
        .noServiceCall,
    ).toContain("stop_deployment");

    const fabricated = binderSource.replace(
      /memberships: await access\.listRolesForUser\(actor\.id\),/,
      "memberships: [],",
    );
    expect(fabricated).not.toBe(binderSource);
    expect(
      auditToolHardening(ALL_AGENT_TOOL_SPECS, implemented, fabricated)
        .fabricatedSuccess,
    ).toContain("get_my_project_roles");
  });
});
