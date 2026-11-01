import {
  AGENT_DEPLOY_APPROVAL_REQUIRED_KEY,
  ToolBinderService,
} from "../tool-binder.service";

type Any = Record<string, any>;

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
    async call(
      name: string,
      args: Record<string, unknown>,
      ctx?: { sessionId?: string },
    ) {
      const h = handlers.get(name);
      if (!h) throw new Error(`tool ${name} not bound`);
      return (
        h as (a: Record<string, unknown>, c?: unknown) => Promise<unknown>
      )(args, ctx);
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
    // 2026-11-02 update_application 绑定：真实服务方法就是这一个
    update: jest.fn(async () => ({ id: "app-1" })),
  };
  const deployments = {
    deploy: jest.fn(async () => ({ id: "dep-1" })),
    // 2026-11-02 cancel_deployment 绑定：DEP-04 的「撤回待审批」出口
    cancelDeployment: jest.fn(async () => ({ id: "dep-1" })),
  };
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
  // P4 get_tool_call_result 的存储面
  const toolCalls = { findOne: jest.fn(async () => null) };
  const steps = { find: jest.fn(async () => []) };
  const api = fakeApi();
  const config = { get: jest.fn((_k: string) => undefined) };
  const svc = new ToolBinderService(
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
    toolCalls,
    steps,
    config,
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
      // 2026-11-02 出清的两条 unbound：注册表声明了却没人绑 ⇒ 模型调用
      // 永远得到「尚未实现」。它们现在必须出现在已实现集合里。
      "update_application",
      "cancel_deployment",
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

  it("list_tasks 输出紧凑投影（避免大实体被 2000 字符截断）", async () => {
    const { api, tasks } = harness();
    (tasks.findAll as jest.Mock).mockResolvedValueOnce({
      list: [
        {
          id: "t-1",
          name: "demo",
          status: "active",
          triggerType: "cron",
          cronExpression: "0 * * * *",
          glueSource: "x".repeat(5000),
          params: { secret: "should-not-reach-the-model" },
        },
      ],
      items: [{}],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    const res = (await api.call("list_tasks", {})) as Any;
    expect(res).toEqual({
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      tasks: [
        {
          id: "t-1",
          name: "demo",
          status: "active",
          triggerType: "cron",
          cronExpression: "0 * * * *",
        },
      ],
    });
    expect(JSON.stringify(res)).not.toContain("glueSource");
    expect(JSON.stringify(res)).not.toContain("should-not-reach-the-model");
  });

  it("list_executions 输出紧凑投影（去掉 logs/aiAnalysis 等大字段）", async () => {
    const { api, tasks } = harness();
    (tasks.getExecutions as jest.Mock).mockResolvedValueOnce({
      list: [
        {
          id: "e-1",
          taskId: "t-1",
          status: "failed",
          failureReason: "script_error",
          errorMessage: "boom",
          logs: "x".repeat(5000),
          aiAnalysis: "long analysis",
        },
      ],
      items: [{}],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    const res = (await api.call("list_executions", { taskId: "t-1" })) as Any;
    expect(res).toMatchObject({
      total: 1,
      executions: [
        {
          id: "e-1",
          taskId: "t-1",
          status: "failed",
          failureReason: "script_error",
          errorMessage: "boom",
        },
      ],
    });
    expect(JSON.stringify(res)).not.toContain("long analysis");
    expect(JSON.stringify(res)).not.toContain("x".repeat(100));
  });

  it("list_executors 输出紧凑投影（去掉 interpreters/runningExecutionIds）", async () => {
    const { api, executors } = harness();
    (executors.findAll as jest.Mock).mockResolvedValueOnce([
      {
        id: "ex-1",
        address: "10.0.0.5:8002",
        appName: "executor-node-1",
        status: "online",
        maxConcurrentTasks: 10,
        interpreters: [{ path: "/usr/bin/python3" }],
        runningExecutionIds: ["e-1", "e-2"],
      },
    ]);

    const res = (await api.call("list_executors", {})) as Any;
    expect(res).toEqual({
      executors: [
        {
          id: "ex-1",
          address: "10.0.0.5:8002",
          appName: "executor-node-1",
          status: "online",
          maxConcurrentTasks: 10,
        },
      ],
    });
    expect(JSON.stringify(res)).not.toContain("interpreters");
    expect(JSON.stringify(res)).not.toContain("runningExecutionIds");
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
    // TOOLS-03：schema 用 template/name/description（此前执行体读 templateId，
    // 真实调用恒 findOne("") → NOT_FOUND，且必填的 name 被静默丢弃）
    await api.call("create_task_from_template", { template: "tpl-1" });
    expect(templates.instantiate).toHaveBeenCalledWith("tpl-1", {});
    await api.call("create_task_from_template", {
      template: "tpl-2",
      name: "备份任务",
      description: "每晚",
      overrides: { timeoutSec: 60, name: "覆盖名" },
    });
    expect(templates.instantiate).toHaveBeenLastCalledWith("tpl-2", {
      name: "覆盖名",
      description: "每晚",
      timeoutSec: 60,
    });
  });

  it("TOOLS-03：create_application 透传 schema 必填的 version/runtime", async () => {
    const { api, applications } = harness();
    await api.call("create_application", {
      name: "demo",
      version: "1.0.0",
      runtime: "node",
      description: "d",
    });
    expect(applications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "1.0.0",
        runtime: "node",
        description: "d",
      }),
      null,
    );
  });

  it("deploy_application/deploy_app 共用方案 C：deploy 透传可选字段 + 强制审批意图", async () => {
    const { api, deployments } = harness();
    await api.call("deploy_application", {
      applicationId: "app-1",
      executorId: "exec-1",
      runMode: "pull",
      env: { A: "1" },
    });
    expect(deployments.deploy).toHaveBeenCalledWith(
      "app-1",
      {
        executorId: "exec-1",
        runMode: "pull",
        env: { A: "1" },
      },
      // 审批痕迹的提交者：Agent 不是具名用户（id=null = 不可判定 ⇒ 第二人
      // 规则按「放行并 warn」处理），name 让待办里显示「提交者：agent」。
      { id: null, name: "agent" },
      // trigger 刻意不传（DeploymentTriggerType 无「agent」取值，把机器动作
      // 标成「manual」是误导）。
      undefined,
      // fail-closed 前置：默认要审批。
      { forceApproval: true },
    );
    await api.call("deploy_app", { applicationId: "app-2" });
    expect(deployments.deploy).toHaveBeenLastCalledWith(
      "app-2",
      {},
      { id: null, name: "agent" },
      undefined,
      { forceApproval: true },
    );
  });
});

/**
 * 2026-11-02：`update_application` / `cancel_deployment` 从「注册表里有、binder
 * 里没有 ⇒ 调用永远得到『尚未实现』」修成「真的能执行，但必须先有人点头」。
 *
 * 本 describe 钉的是**执行体**这一半（真实服务方法被调用、参数逐字对得上）：
 *   · 审批那一半（未批不执行 / 批准后执行）在 `tool-executor.service.spec.ts`
 *     用真实闸门 + 真实注册表钉；
 *   · 「未批不执行」之所以只能钉在闸门侧：本文件的 handler **没有**任何策略
 *     分支，门只可能在 `agent-boundary.service.ts`；因此注册表那条
 *     `approvalRequired: true` 是唯一入口条件，删掉它 `gate-inventory.spec.ts`
 *     的出清断言会红（② 那一半不会静默消失）。
 */
describe("ToolBinderService · update_application / cancel_deployment（2026-11-02 绑定）", () => {
  const APP_ID = "11111111-1111-4111-8111-111111111111";
  const DEP_ID = "22222222-2222-4222-8222-222222222222";

  it("update_application：真调 ApplicationService.update，applicationId/patch 逐字透传", async () => {
    const { api, applications } = harness();
    const patch = {
      description: "d",
      status: "active",
      env: { A: "1" },
      mutexGroupId: null,
    };
    await api.call("update_application", { applicationId: APP_ID, patch });
    expect(applications.update).toHaveBeenCalledWith(
      APP_ID,
      patch,
      // Agent 不是具名用户：user=null + systemBypass 是既有机器面语义
      // （属主守卫对 null 恒拒 ⇒ 传 null 不 bypass 就是「绑定了但永远 403」）。
      null,
      { systemBypass: true },
    );
  });

  it("update_application：空 patch / 改名 / 未知字段 / 形状错误 ⇒ 400 VALIDATION_FAILED（不是「尚未实现」）", async () => {
    const { api, applications } = harness();
    const cases: unknown[] = [
      {}, // 空 patch：service 会「成功但什么都没改」，模型会误读成已生效
      { name: "renamed" }, // 注册表描述：renaming is not supported
      { nope: 1 }, // 未知键：直调 service 会被 TypeORM 当列名（500）
      { webhookSecret: "s" }, // 纯凭据：审批预览打码 ⇒ 审批人看不见内容
      { description: 42 }, // 形状错误
      { env: "A=1" }, // env 必须是对象
      { status: "deleted" }, // 枚举外的状态
      [], // 不是对象
      "oops",
      null,
    ];
    for (const patch of cases) {
      const err = (await api
        .call("update_application", { applicationId: APP_ID, patch })
        .catch((e: unknown) => e)) as {
        errorCode?: string;
        getStatus?: () => number;
        message?: string;
      };
      expect({ patch, errorCode: err.errorCode }).toEqual({
        patch,
        errorCode: "VALIDATION_FAILED",
      });
      expect(err.getStatus?.()).toBe(400);
      // 关键：不是「尚未实现」——模型该看到「参数不对」，而不是「工具坏了」
      expect(err.message ?? "").not.toContain("尚未实现");
    }
    // 零副作用：没有一条非法 patch 走到 service
    expect(applications.update).not.toHaveBeenCalled();
  });

  it("cancel_deployment：真调 AppDeploymentService.cancelDeployment，actor 与 deployApp 同形", async () => {
    const { api, deployments } = harness();
    await api.call("cancel_deployment", { deploymentId: DEP_ID });
    expect(deployments.cancelDeployment).toHaveBeenCalledWith(DEP_ID, {
      // 与 deployApp 的审批痕迹同形：id=null = 无具名主体，
      // name 让审批待办/事件流显示「agent」。
      id: null,
      name: "agent",
    });
  });

  it("回归锁：新增绑定不改变 deploy_app 的既有行为（参数逐字节不变）", async () => {
    const { api, deployments } = harness();
    await api.call("deploy_app", { applicationId: "app-9" });
    expect(deployments.deploy).toHaveBeenCalledTimes(1);
    expect(deployments.deploy).toHaveBeenCalledWith(
      "app-9",
      {},
      { id: null, name: "agent" },
      undefined,
      { forceApproval: true },
    );
    // 新增的两条不碰部署执行体（各走各的 service 方法）
    expect(deployments.cancelDeployment).not.toHaveBeenCalled();
  });
});

/**
 * Agent 侧部署的 **fail-closed 前置**（2026-11-01 实施轮）。
 *
 * ## 缺口事实
 * DEP-04 的 `approvalRequired` 是**按应用**的开关且**默认 false**
 * （`application.entity.ts:60`）⇒ 方案 C 把门全交给 DEP-04，就等于
 * 「从未开过审批的应用 ⇒ Agent 部署零门」（机器替人部署生产应用，无人点头）。
 * 这两条工具在 `gate-inventory.ts` 里以 `kind: "known-gap"` 登记。
 *
 * ## 本轮判据
 * Agent 触发的部署**一律**要求人工审批（不再依赖「应用恰好开了开关」）；
 * 应用**已开**开关时走的仍是**同一条** DEP-04 路径（既有 pending_approval
 * 语义逐字节不变）。
 *
 * ## 逃生门
 * `AGENT_DEPLOY_APPROVAL_REQUIRED=false` ⇒ 回退方案 C 旧行为。默认**开**
 * （要审批）——「没配」不等于「放开」。
 */
describe("ToolBinderService · Agent 部署 fail-closed 前置（方案 C 收紧）", () => {
  it("默认（未配置逃生门）：Agent 部署带 forceApproval=true ⇒ 走 DEP-04 冻结路径", async () => {
    const { api, deployments } = harness();
    // 配置里没有该键 ⇒ 缺省 ⇒ 安全侧（要审批）
    await api.call("deploy_application", { applicationId: "app-1" });
    expect(deployments.deploy).toHaveBeenCalledWith(
      "app-1",
      {},
      { id: null, name: "agent" },
      undefined,
      { forceApproval: true },
    );
  });

  it("deploy_app 别名同样带 forceApproval=true（共用同一个执行体）", async () => {
    const { api, deployments } = harness();
    await api.call("deploy_app", { applicationId: "app-2" });
    expect(deployments.deploy).toHaveBeenLastCalledWith(
      "app-2",
      {},
      { id: null, name: "agent" },
      undefined,
      { forceApproval: true },
    );
  });

  it("逃生门显式 false ⇒ 回退方案 C 旧行为（forceApproval=false）", async () => {
    const { api, deployments, config } = harness();
    config.get.mockImplementation((k: string) =>
      k === AGENT_DEPLOY_APPROVAL_REQUIRED_KEY ? "false" : undefined,
    );
    await api.call("deploy_application", { applicationId: "app-1" });
    expect(deployments.deploy).toHaveBeenLastCalledWith(
      "app-1",
      {},
      { id: null, name: "agent" },
      undefined,
      { forceApproval: false },
    );
  });

  it("逃生门值不可读时按安全侧处理（forceApproval=true，不放行）", async () => {
    const { api, deployments, config } = harness();
    // 非法值：宁可要审批，也不要因为「配置写坏了」而静默放开。
    config.get.mockImplementation((k: string) =>
      k === AGENT_DEPLOY_APPROVAL_REQUIRED_KEY ? "yes-please" : undefined,
    );
    await api.call("deploy_application", { applicationId: "app-1" });
    expect(deployments.deploy).toHaveBeenLastCalledWith(
      "app-1",
      {},
      { id: null, name: "agent" },
      undefined,
      { forceApproval: true },
    );
  });

  it("逃生门读得到 false/0 两种写法都放行", async () => {
    for (const raw of ["false", "0", false]) {
      const { api, deployments, config } = harness();
      config.get.mockImplementation((k: string) =>
        k === AGENT_DEPLOY_APPROVAL_REQUIRED_KEY ? raw : undefined,
      );
      await api.call("deploy_application", { applicationId: "app-1" });
      expect(deployments.deploy).toHaveBeenLastCalledWith(
        "app-1",
        {},
        { id: null, name: "agent" },
        undefined,
        { forceApproval: false },
      );
    }
  });

  it("逃生门读得到 true/1 两种写法都要审批", async () => {
    for (const raw of ["true", "1", true]) {
      const { api, deployments, config } = harness();
      config.get.mockImplementation((k: string) =>
        k === AGENT_DEPLOY_APPROVAL_REQUIRED_KEY ? raw : undefined,
      );
      await api.call("deploy_application", { applicationId: "app-1" });
      expect(deployments.deploy).toHaveBeenLastCalledWith(
        "app-1",
        {},
        { id: null, name: "agent" },
        undefined,
        { forceApproval: true },
      );
    }
  });

  it("ConfigService 缺席（既有单测装配）⇒ 仍按安全侧要审批（不得静默放开）", async () => {
    // ToolBinderService 的 config 是 @Optional；缺席时 this.config 为 undefined。
    // 判据读不到 ⇒ 安全侧（要审批），不是「没门」。
    const { api, deployments } = harness();
    const svc = new ToolBinderService(
      api as never,
      {} as never,
      {} as never,
      {} as never,
      deployments as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    svc.onModuleInit();
    await api.call("deploy_application", { applicationId: "app-1" });
    expect(deployments.deploy).toHaveBeenLastCalledWith(
      "app-1",
      {},
      { id: null, name: "agent" },
      undefined,
      { forceApproval: true },
    );
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

describe("ToolBinderService · get_tool_call_result（P4 回读）", () => {
  it("按会话隔离查询并返回存储的完整结果", async () => {
    const { api, toolCalls } = harness();
    toolCalls.findOne.mockResolvedValueOnce({
      toolName: "trigger_task",
      status: "ok",
      resultTruncated: true,
      resultJson: {
        truncated: true,
        sha256: "x",
        preview: "…",
        full: "FULL-TEXT",
      },
    });

    const res = (await api.call(
      "get_tool_call_result",
      { toolCallId: "call-1" },
      { sessionId: "s-1" },
    )) as Record<string, unknown>;

    expect(res).toMatchObject({
      found: true,
      toolName: "trigger_task",
      status: "ok",
      full: "FULL-TEXT",
    });
    expect(toolCalls.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: "s-1", toolCallId: "call-1" },
      }),
    );
  });

  it("只有预览时明确说明（不假装完整）", async () => {
    const { api, toolCalls } = harness();
    toolCalls.findOne.mockResolvedValueOnce({
      toolName: "get_execution",
      status: "ok",
      resultTruncated: true,
      resultJson: { truncated: true, sha256: "abc", preview: "head…tail" },
    });
    const res = (await api.call(
      "get_tool_call_result",
      { toolCallId: "call-2" },
      { sessionId: "s-1" },
    )) as Record<string, unknown>;
    expect(res.found).toBe(true);
    expect(res.full).toBeUndefined();
    expect(String(res.note)).toContain("only a truncated preview");
  });

  it("跨会话不可读：查询条件必须带 sessionId，缺失会话上下文直接拒绝", async () => {
    const { api, toolCalls } = harness();
    const res = (await api.call("get_tool_call_result", {
      toolCallId: "call-x",
    })) as Record<string, unknown>;
    expect(res.found).toBe(false);
    expect(toolCalls.findOne).not.toHaveBeenCalled();
  });

  it("本会话没有该 id → found:false（不泄漏存在性）", async () => {
    const { api } = harness();
    const res = (await api.call(
      "get_tool_call_result",
      { toolCallId: "nope" },
      { sessionId: "s-1" },
    )) as Record<string, unknown>;
    expect(res.found).toBe(false);
  });
});

describe("ToolBinderService · get_session_steps（G5 只读时间线）", () => {
  it("按 seq 升序返回本会话步骤，长内容截断、工具名紧凑", async () => {
    const { api, steps } = harness();
    steps.find.mockResolvedValueOnce([
      {
        seq: 3,
        role: "assistant",
        content: "x".repeat(400),
        toolCallsJson: null,
        createdAt: "t3",
      },
      {
        seq: 2,
        role: "tool",
        content: "ok",
        toolCallsJson: null,
        createdAt: "t2",
      },
      {
        seq: 1,
        role: "assistant",
        content: "hi",
        toolCallsJson: [
          { id: "c1", function: { name: "get_task", arguments: "{}" } },
        ],
        createdAt: "t1",
      },
    ]);

    const res = (await api.call(
      "get_session_steps",
      { limit: 5 },
      { sessionId: "s-1" },
    )) as {
      count: number;
      steps: Array<{
        seq: number;
        content: string | null;
        toolCalls: string[] | null;
      }>;
    };

    expect(res.count).toBe(3);
    expect(res.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(res.steps[2].content?.length).toBe(300);
    expect(res.steps[0].toolCalls).toEqual(["get_task"]);
    expect(steps.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: "s-1" },
        order: { seq: "DESC" },
        take: 5,
      }),
    );
  });

  it("beforeSeq 分页：条件写 seq < beforeSeq；默认 limit=10", async () => {
    const { api, steps } = harness();
    steps.find.mockResolvedValueOnce([]);
    await api.call(
      "get_session_steps",
      { beforeSeq: 20 },
      { sessionId: "s-2" },
    );
    expect(steps.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: "s-2", seq: expect.anything() },
        take: 10,
      }),
    );
  });

  it("缺会话上下文 → 拒绝（不跨会话读取）", async () => {
    const { api, steps } = harness();
    const res = (await api.call("get_session_steps", {})) as {
      found?: boolean;
    };
    expect(res.found).toBe(false);
    expect(steps.find).not.toHaveBeenCalled();
  });
});
