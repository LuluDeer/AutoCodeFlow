import { ToolBinderService } from "../tool-binder.service";

/** AgentApiClient 假体：登记 handler 供直接调用，未登记走 invoke 语义。 */
function fakeApi() {
  const handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >();
  return {
    register: jest.fn(
      (
        name: string,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) => {
        handlers.set(name, handler);
      },
    ),
    implementedTools: jest.fn(() => [...handlers.keys()].sort()),
    handlers,
    async call(name: string, args: Record<string, unknown>) {
      const h = handlers.get(name);
      if (!h) throw new Error(`tool ${name} not bound`);
      return h(args);
    },
  };
}

function harness() {
  const tasks = {
    findAll: jest.fn(async () => [{ id: "t-1" }]),
    findOne: jest.fn(async () => ({ id: "t-1" })),
    getExecutions: jest.fn(async () => [{ id: "e-1" }]),
    getAllExecutions: jest.fn(async () => [{ id: "e-2" }]),
    getExecution: jest.fn(async (id: string) => ({ id, params: { k: "v" } })),
    getExecutionLogs: jest.fn(async () => ({ lines: [] })),
    getExecutionStats: jest.fn(async () => ({ successRate: 1 })),
    getVersions: jest.fn(async () => []),
    compareVersions: jest.fn(async () => ({})),
    getExecutionReport: jest.fn(async () => ({})),
    analyzeExecution: jest.fn(async () => ({})),
    suggestSchedule: jest.fn(async () => ({})),
    trigger: jest.fn(async () => ({ executionId: "e-new" })),
    killExecution: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
  };
  const executors = {
    findAll: jest.fn(async () => []),
    findOne: jest.fn(async () => ({})),
    getExecutorMetrics: jest.fn(async () => ({})),
    findByAddress: jest.fn(async (address: string) =>
      address === "known:1" ? { id: "exec-1" } : null,
    ),
  };
  const applications = {
    findAll: jest.fn(async () => []),
    findById: jest.fn(async () => ({})),
    analyzeHealth: jest.fn(async () => ({})),
    create: jest.fn(async () => ({ id: "app-1" })),
  };
  const deployments = { deploy: jest.fn(async () => ({ id: "dep-1" })) };
  const templates = { instantiate: jest.fn(async () => ({ id: "t-new" })) };
  // MUTEX-01：互斥组四工具的执行体依赖
  const mutexGroups = {
    findAll: jest.fn(async () => [
      { id: "g-1", name: "ziniao", maxConcurrentPerDevice: 1, scope: "device" },
    ]),
    create: jest.fn(async () => ({ id: "g-new", name: "sso" })),
    update: jest.fn(async () => ({ id: "g-1", scope: "global" })),
    remove: jest.fn(async () => undefined),
  };
  const sops = {
    list: jest.fn(async () => []),
    getSop: jest.fn(async () => ({ id: "sop-1" })),
    getBySlug: jest.fn(async () => ({ id: "sop-2" })),
    draft: jest.fn(async () => ({ id: "sop-1" })),
    publish: jest.fn(async () => ({ version: "1.0.0" })),
    assign: jest.fn(async () => ({ id: "asg-1" })),
    replyClarification: jest.fn(async () => ({ ok: true })),
  };
  const api = fakeApi();
  const svc = new ToolBinderService(
    api as never,
    tasks as never,
    executors as never,
    applications as never,
    deployments as never,
    templates as never,
    mutexGroups as never,
    sops as never,
  );
  svc.onModuleInit();
  return {
    svc,
    api,
    tasks,
    executors,
    applications,
    mutexGroups,
    deployments,
    templates,
    sops,
  };
}

describe("ToolBinderService · 绑定完备性", () => {
  it("onModuleInit 后只读 + SOP + 写工具全部有执行体", () => {
    const { api } = harness();
    const bound = api.implementedTools();
    for (const name of [
      "get_task",
      "list_executions",
      "get_execution_logs",
      "analyze_execution",
      "sop_get",
      "sop_publish",
      "trigger_task",
      "retry_execution",
      "deploy_application",
      "deploy_app",
    ]) {
      expect(bound).toContain(name);
    }
    // 闸门白名单里的 incident 写工具不再「尚未实现」
    for (const name of [
      "kill_execution",
      "pause_task",
      "resume_task",
      "create_application",
      "create_task_from_template",
    ]) {
      expect(bound).toContain(name);
    }
    // MUTEX-01：互斥组四工具全部有执行体（声明了却未绑定 = 模型调用得
    // 「尚未实现」，白名单形同虚设——P6 那次教训的同类防线）
    for (const name of [
      "list_mutex_groups",
      "create_mutex_group",
      "update_mutex_group",
      "delete_mutex_group",
    ]) {
      expect(bound).toContain(name);
    }
  });

  it("任务组缺省参数（page/pageSize/分页形参）", async () => {
    const { api, tasks } = harness();
    await api.call("list_tasks", { page: "2", pageSize: "5" });
    expect(tasks.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 5 }),
    );
    await api.call("get_execution_logs", { executionId: "e-1" });
    expect(tasks.getExecutionLogs).toHaveBeenCalledWith(
      "e-1",
      expect.objectContaining({ fromLine: 0, limit: 500 }),
    );
  });

  it("list_executions：带 taskId 走任务内查询，否则全量", async () => {
    const { api, tasks } = harness();
    await api.call("list_executions", { taskId: "t-1" });
    expect(tasks.getExecutions).toHaveBeenCalled();
    expect(tasks.getAllExecutions).not.toHaveBeenCalled();
    await api.call("list_executions", {});
    expect(tasks.getAllExecutions).toHaveBeenCalled();
  });
});

describe("ToolBinderService · SOP 组绑定", () => {
  it("sop_get：sopId 优先，无 sopId 走 slug", async () => {
    const { api, sops } = harness();
    await api.call("sop_get", { sopId: "sop-1", slug: "demo" });
    expect(sops.getSop).toHaveBeenCalledWith("sop-1");
    expect(sops.getBySlug).not.toHaveBeenCalled();
    await api.call("sop_get", { slug: "demo" });
    expect(sops.getBySlug).toHaveBeenCalledWith("demo");
  });

  it("sop_assign：executorId 直达；address 解析成功；address 不存在报错；两者皆缺报错", async () => {
    const { api, sops, executors } = harness();
    await api.call("sop_assign", { sopId: "sop-1", executorId: "exec-1" });
    expect(sops.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        executorId: "exec-1",
        assignedBy: "agent:tool-call",
      }),
    );
    await api.call("sop_assign", {
      sopId: "sop-1",
      executorAddress: "known:1",
    });
    expect(executors.findByAddress).toHaveBeenCalledWith("known:1");
    expect(sops.assign).toHaveBeenLastCalledWith(
      expect.objectContaining({ executorId: "exec-1" }),
    );
    await expect(
      api.call("sop_assign", { sopId: "sop-1", executorAddress: "ghost:1" }),
    ).rejects.toThrow(/不存在/);
    await expect(api.call("sop_assign", { sopId: "sop-1" })).rejects.toThrow(
      /必须提供其一/,
    );
  });

  it("sop_draft/sop_publish/sop_reply_clarification 以 agent:tool-call 身份透传", async () => {
    const { api, sops } = harness();
    await api.call("sop_draft", { slug: "demo", title: "Demo" });
    expect(sops.draft).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "demo", createdBy: "agent:tool-call" }),
    );
    await api.call("sop_publish", { sopId: "sop-1", bump: "patch" });
    expect(sops.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        bump: "patch",
        publishedBy: "agent:tool-call",
      }),
    );
    await api.call("sop_reply_clarification", {
      clarificationId: "c-1",
      resolution: "answered",
      answer: "已修订",
    });
    expect(sops.replyClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "answered",
        replyBy: "agent:tool-call",
      }),
    );
  });
});

describe("ToolBinderService · 写工具绑定（P6）", () => {
  it("trigger_task：带 triggerType=agent 与可选 params", async () => {
    const { api, tasks } = harness();
    await api.call("trigger_task", { taskId: "t-1", params: { a: 1 } });
    expect(tasks.trigger).toHaveBeenCalledWith(
      "t-1",
      { params: { a: 1 } },
      undefined,
      "agent",
    );
    await api.call("trigger_task", { taskId: "t-1" });
    expect(tasks.trigger).toHaveBeenLastCalledWith(
      "t-1",
      {},
      undefined,
      "agent",
    );
  });

  it("retry_execution：优先显式 params，否则回放原执行 params", async () => {
    const { api, tasks } = harness();
    await api.call("retry_execution", { taskId: "t-1", executionId: "e-1" });
    expect(tasks.getExecution).toHaveBeenCalledWith("e-1");
    expect(tasks.trigger).toHaveBeenLastCalledWith(
      "t-1",
      { params: { k: "v" } },
      undefined,
      "agent",
    );
    await api.call("retry_execution", {
      taskId: "t-1",
      executionId: "e-1",
      params: { z: 9 },
    });
    expect(tasks.trigger).toHaveBeenLastCalledWith(
      "t-1",
      { params: { z: 9 } },
      undefined,
      "agent",
    );
  });

  it("kill/pause/resume 透传；create_task_from_template 带 overrides 兜底空对象", async () => {
    const { api, tasks, templates } = harness();
    await api.call("kill_execution", { executionId: "e-1" });
    expect(tasks.killExecution).toHaveBeenCalledWith("e-1");
    await api.call("pause_task", { taskId: "t-1" });
    expect(tasks.pause).toHaveBeenCalledWith("t-1");
    await api.call("resume_task", { taskId: "t-1" });
    expect(tasks.resume).toHaveBeenCalledWith("t-1");
    await api.call("create_task_from_template", { templateId: "tpl-1" });
    expect(templates.instantiate).toHaveBeenCalledWith("tpl-1", {});
  });

  it("deploy_application/deploy_app 共用方案 C：deploy 透传可选字段", async () => {
    const { api, deployments } = harness();
    await api.call("deploy_application", {
      applicationId: "app-1",
      executorId: "exec-1",
      runMode: "pull",
      env: { A: "1" },
    });
    expect(deployments.deploy).toHaveBeenCalledWith("app-1", {
      executorId: "exec-1",
      runMode: "pull",
      env: { A: "1" },
    });
    await api.call("deploy_app", { applicationId: "app-2" });
    expect(deployments.deploy).toHaveBeenLastCalledWith("app-2", {});
  });
});

/**
 * MUTEX-01：互斥组四工具执行体（MUTEX-CLI/MCP 同步轮）。
 *
 * 与 CLI 侧同口径的三处容易退化的行为：① create 只发显式给出的字段
 * （forbidNonWhitelisted 下不发 undefined）；② update 空 patch 必须**报错**
 * 而不是静默成功（服务端语义是「成功但什么都没改」，模型会误读为已生效）；
 * ③ delete 的 force 布尔要如实透传（true 才解除 409 保护）。
 */
describe("ToolBinderService · MUTEX-01 互斥组", () => {
  it("list_mutex_groups：直通 findAll", async () => {
    const { api, mutexGroups } = harness();
    const out = await api.call("list_mutex_groups", {});
    expect(mutexGroups.findAll).toHaveBeenCalledWith();
    expect(out).toEqual([
      { id: "g-1", name: "ziniao", maxConcurrentPerDevice: 1, scope: "device" },
    ]);
  });

  it("create_mutex_group：只发显式字段（未给的键不出现）", async () => {
    const { api, mutexGroups } = harness();
    await api.call("create_mutex_group", { name: "sso" });
    expect(mutexGroups.create).toHaveBeenCalledWith({ name: "sso" });
  });

  it("create_mutex_group：可选项齐全时透传（含 scope/maxConcurrentPerDevice）", async () => {
    const { api, mutexGroups } = harness();
    await api.call("create_mutex_group", {
      name: "sso",
      scope: "global",
      maxConcurrentPerDevice: 2,
      description: "单点登录顶号",
    });
    expect(mutexGroups.create).toHaveBeenCalledWith({
      name: "sso",
      scope: "global",
      maxConcurrentPerDevice: 2,
      description: "单点登录顶号",
    });
  });

  it("update_mutex_group：空 patch 报错（不静默成功）", async () => {
    const { api, mutexGroups } = harness();
    await expect(
      api.call("update_mutex_group", { groupId: "g-1" }),
    ).rejects.toThrow(/至少需要一个可改字段/);
    expect(mutexGroups.update).not.toHaveBeenCalled();
  });

  it("update_mutex_group：只把给出的字段放进 patch", async () => {
    const { api, mutexGroups } = harness();
    await api.call("update_mutex_group", { groupId: "g-1", scope: "global" });
    expect(mutexGroups.update).toHaveBeenCalledWith("g-1", { scope: "global" });
  });

  it("delete_mutex_group：force 缺省为 false（不解除 409 保护）", async () => {
    const { api, mutexGroups } = harness();
    await api.call("delete_mutex_group", { groupId: "g-1" });
    expect(mutexGroups.remove).toHaveBeenCalledWith("g-1", false);
  });

  it("delete_mutex_group：force=true 透传", async () => {
    const { api, mutexGroups } = harness();
    await api.call("delete_mutex_group", { groupId: "g-1", force: true });
    expect(mutexGroups.remove).toHaveBeenCalledWith("g-1", true);
  });
});
