import { ConfigService } from "@nestjs/config";

import { AgentBoundaryService } from "../agent-boundary.service";
import type { AgentSession } from "../../entities/agent-session.entity";

/** 会话桩：kind 决定白名单，scopeJson 决定资源范围。 */
function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "s-1",
    kind: "incident",
    scopeJson: {},
    status: "running",
    ...patch,
  } as unknown as AgentSession;
}

function harness(configValues: Record<string, unknown> = {}) {
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  };
  return {
    svc: new AgentBoundaryService(config as unknown as ConfigService),
    config,
  };
}

describe("AgentBoundaryService · ① 工具存在性 + 会话白名单", () => {
  it("未知工具 → not_in_toolset", () => {
    const { svc } = harness();
    const v = svc.check(session(), "evil_tool", {}, 0);
    expect(v).toMatchObject({ kind: "DENY", reason: "not_in_toolset" });
  });

  it("ops_watch（纯只读白名单）调 write 工具 → not_in_toolset", () => {
    const { svc } = harness();
    const v = svc.check(
      session({ kind: "ops_watch" } as never),
      "trigger_task",
      { taskId: "t-1" },
      0,
    );
    expect(v).toMatchObject({ kind: "DENY", reason: "not_in_toolset" });
  });

  it("incident 不含 update_task——故障处置不改配置", () => {
    const { svc } = harness();
    const v = svc.check(
      session(),
      "update_task",
      { taskId: "t-1", patch: {} },
      0,
    );
    expect(v).toMatchObject({ kind: "DENY", reason: "not_in_toolset" });
  });

  it("未登记的会话类型 → 空集拒绝一切（安全默认）", () => {
    const { svc } = harness();
    const v = svc.check(
      session({ kind: "evil_kind" } as never),
      "get_task",
      { taskId: "t-1" },
      0,
    );
    expect(v).toMatchObject({ kind: "DENY", reason: "not_in_toolset" });
  });

  it("chat 会话白名单为 null（不限工具），闸门仍逐调用判 tier/scope", () => {
    const { svc } = harness();
    const v = svc.check(
      session({ kind: "chat", scopeJson: { unrestricted: true } } as never),
      "get_task",
      { taskId: "t-1" },
      0,
    );
    expect(v).toMatchObject({ kind: "ALLOW" });
  });
});

describe("AgentBoundaryService · ② 硬禁用（连审批机会都没有）", () => {
  it.each(["approve_deployment", "reject_deployment"])(
    "%s 硬禁用——即使 allowDangerous=true 也不给审批",
    (tool) => {
      const { svc } = harness({ "agent.policy.allowDangerous": true });
      const v = svc.check(
        session({ kind: "chat", scopeJson: { unrestricted: true } } as never),
        tool,
        { deploymentId: "d-1" },
        0,
      );
      expect(v).toMatchObject({ kind: "DENY", reason: "hard_disabled" });
    },
  );
});

describe("AgentBoundaryService · ③ 参数校验（不可信输入）", () => {
  it("缺必填 / 空串 / null → invalid_params", () => {
    const { svc } = harness();
    for (const args of [{}, { taskId: "" }, { taskId: null }]) {
      expect(svc.check(session(), "get_task", args, 0)).toMatchObject({
        kind: "DENY",
        reason: "invalid_params",
      });
    }
  });

  it("未知键拒绝（forbidNonWhitelisted 对齐）", () => {
    const { svc } = harness();
    expect(
      svc.check(session(), "get_task", { taskId: "t-1", extra: 1 }, 0),
    ).toMatchObject({ kind: "DENY", reason: "invalid_params" });
  });

  it.each([
    ["shell 元字符 分号", "id; rm -rf /"],
    ["shell 元字符 反引号", "id`whoami`"],
    ["命令替换", "$(whoami)"],
    ["管道", "a|b"],
    ["逻辑或", "a||b"],
    ["换行注入", "a\nrm -rf /"],
    ["路径穿越", "../../etc/passwd"],
    ["敏感绝对路径", "/etc/shadow"],
    ["home 展开", "~/.ssh/id_rsa"],
    ["SSRF 127", "http://127.0.0.1:8080/"],
    ["SSRF localhost", "http://localhost/x"],
    ["SSRF 内网 10", "http://10.0.0.1/"],
    ["SSRF 192", "http://192.168.1.1/"],
    ["SSRF 元数据", "http://169.254.169.254/latest/meta-data"],
    ["SSRF 0.0.0.0", "http://0.0.0.0/"],
  ])("危险模式：%s", (_label, value) => {
    const { svc } = harness();
    const v = svc.check(session(), "get_task", { taskId: value }, 0);
    expect(v).toMatchObject({ kind: "DENY", reason: "invalid_params" });
  });

  it("嵌套对象与数组内的注入同样被扫出", () => {
    const { svc } = harness();
    const nested = svc.check(
      session(),
      "trigger_task",
      { taskId: "t-1", params: { a: { b: { c: "$(id)" } } } },
      0,
    );
    expect(nested).toMatchObject({ kind: "DENY", reason: "invalid_params" });
    const inArray = svc.check(
      session(),
      "trigger_task",
      { taskId: "t-1", params: { list: ["ok", "../escape"] } },
      0,
    );
    expect(inArray).toMatchObject({ kind: "DENY", reason: "invalid_params" });
  });

  it("超长载荷（>100KB）拒绝", () => {
    const { svc } = harness();
    const v = svc.check(
      session(),
      "get_task",
      { taskId: "x".repeat(100_001) },
      0,
    );
    expect(v).toMatchObject({ kind: "DENY", reason: "invalid_params" });
  });

  it("无 schema 属性的工具不因未知键误拒（props 空集跳过白名单检查）", () => {
    const { svc } = harness();
    const v = svc.check(
      session({ kind: "chat", scopeJson: { unrestricted: true } } as never),
      "get_scheduler_health",
      {},
      0,
    );
    expect(v).toMatchObject({ kind: "ALLOW" });
  });
});

describe("AgentBoundaryService · ④ 资源范围（scope 交叉验证）", () => {
  it("resourceKind=none 的工具不做 scope 校验", () => {
    const { svc } = harness();
    const v = svc.check(session(), "list_tasks", {}, 0);
    expect(v).toMatchObject({ kind: "ALLOW" });
  });

  it("scopeJson 缺省（{}）→ 不可操作任何资源", () => {
    const { svc } = harness();
    const v = svc.check(session(), "get_task", { taskId: "t-1" }, 0);
    expect(v).toMatchObject({ kind: "DENY", reason: "out_of_scope" });
  });

  it("显式空列表同样拒绝；unrestricted=true 放行", () => {
    const { svc } = harness();
    const empty = svc.check(
      session({ scopeJson: { tasks: [] } } as never),
      "get_task",
      { taskId: "t-1" },
      0,
    );
    expect(empty).toMatchObject({ kind: "DENY", reason: "out_of_scope" });
    const open = svc.check(
      session({ scopeJson: { unrestricted: true } } as never),
      "get_task",
      { taskId: "t-1" },
      0,
    );
    expect(open).toMatchObject({ kind: "ALLOW" });
  });

  it("授权 app-A 后操作 app-B → out_of_scope；操作 app-A 放行", () => {
    const { svc } = harness();
    const s = session({
      kind: "chat",
      scopeJson: { applications: ["app-A"] },
    } as never);
    expect(
      svc.check(s, "get_application", { applicationId: "app-B" }, 0),
    ).toMatchObject({ kind: "DENY", reason: "out_of_scope" });
    expect(
      svc.check(s, "get_application", { applicationId: "app-A" }, 0),
    ).toMatchObject({ kind: "ALLOW" });
  });
});

describe("AgentBoundaryService · ⑤ 速率与熔断（进程内记账）", () => {
  it("连续失败 ≥3 次熔断；一次成功重置", () => {
    const { svc } = harness();
    const s = session({
      kind: "chat",
      scopeJson: { unrestricted: true },
    } as never);
    svc.recordOutcome("s-1", "get_task", false);
    svc.recordOutcome("s-1", "get_task", false);
    expect(svc.check(s, "get_task", { taskId: "t-1" }, 0)).toMatchObject({
      kind: "ALLOW",
    });
    svc.recordOutcome("s-1", "get_task", false);
    expect(svc.check(s, "get_task", { taskId: "t-1" }, 0)).toMatchObject({
      kind: "DENY",
      reason: "circuit_open",
    });
    svc.recordOutcome("s-1", "get_task", true);
    expect(svc.check(s, "get_task", { taskId: "t-1" }, 0)).toMatchObject({
      kind: "ALLOW",
    });
  });

  it("熔断按 (会话, 工具) 隔离；clearSession 只清本会话", () => {
    const { svc } = harness();
    const s1 = session({
      id: "s-1",
      kind: "chat",
      scopeJson: { unrestricted: true },
    } as never);
    for (let i = 0; i < 3; i++) svc.recordOutcome("s-1", "get_task", false);
    svc.recordOutcome("s-2", "get_task", false);
    const s2 = session({
      id: "s-2",
      kind: "chat",
      scopeJson: { unrestricted: true },
    } as never);
    expect(svc.check(s1, "get_task", { taskId: "t-1" }, 0)).toMatchObject({
      reason: "circuit_open",
    });
    expect(svc.check(s2, "get_task", { taskId: "t-1" }, 0)).toMatchObject({
      kind: "ALLOW",
    });
    svc.clearSession("s-2");
    expect(svc.check(s2, "get_task", { taskId: "t-1" }, 0)).toMatchObject({
      kind: "ALLOW",
    });
  });

  it("同工具调用次数达上限 → rate_limited（配置可调）", () => {
    const { svc } = harness({ "agent.policy.maxCallsPerTool": 2 });
    const s = session({
      kind: "chat",
      scopeJson: { unrestricted: true },
    } as never);
    expect(svc.check(s, "get_task", { taskId: "t-1" }, 1)).toMatchObject({
      kind: "ALLOW",
    });
    expect(svc.check(s, "get_task", { taskId: "t-1" }, 2)).toMatchObject({
      kind: "DENY",
      reason: "rate_limited",
    });
  });

  it("readInt 非法值（NaN/非正数）回退默认——限流不可被配坏", () => {
    const { svc } = harness({ "agent.policy.maxCallsPerTool": "abc" });
    const s = session({
      kind: "chat",
      scopeJson: { unrestricted: true },
    } as never);
    expect(svc.check(s, "get_task", { taskId: "t-1" }, 14)).toMatchObject({
      kind: "ALLOW",
    });
    expect(svc.check(s, "get_task", { taskId: "t-1" }, 15)).toMatchObject({
      kind: "DENY",
      reason: "rate_limited",
    });
    const zero = harness({ "agent.policy.maxCallsPerTool": 0 });
    expect(zero.svc.check(s, "get_task", { taskId: "t-1" }, 14)).toMatchObject({
      kind: "ALLOW",
    });
  });
});

describe("AgentBoundaryService · ⑥ 分级审批（最后一道，可批准）", () => {
  const chatSession = () =>
    session({
      id: "s-1",
      kind: "chat",
      scopeJson: { unrestricted: true },
    } as never);

  it("read 工具默认放行", () => {
    const { svc } = harness();
    expect(
      svc.check(chatSession(), "get_task", { taskId: "t-1" }, 0),
    ).toMatchObject({
      kind: "ALLOW",
    });
  });

  it("dangerous 未启用 → needs_approval（不给执行，也不给 NEED_APPROVAL）", () => {
    const { svc } = harness();
    const v = svc.check(
      chatSession(),
      "delete_application",
      { applicationId: "app-1" },
      0,
    );
    expect(v).toMatchObject({ kind: "DENY", reason: "needs_approval" });
  });

  it("dangerous 启用后仍需审批；审批策略关掉时才 ALLOW", () => {
    const { svc } = harness({
      "agent.policy.allowDangerous": true,
      "agent.policy.dangerousRequiresApproval": true,
    });
    expect(
      svc.check(
        chatSession(),
        "delete_application",
        { applicationId: "app-1" },
        0,
      ),
    ).toMatchObject({ kind: "NEED_APPROVAL" });
    const lax = harness({
      "agent.policy.allowDangerous": true,
      "agent.policy.dangerousRequiresApproval": false,
    });
    expect(
      lax.svc.check(
        chatSession(),
        "delete_application",
        { applicationId: "app-1" },
        0,
      ),
    ).toMatchObject({ kind: "ALLOW" });
  });

  it("逐工具审批闸（update_task/sop_publish）：不随全局写策略放宽而放宽", () => {
    const { svc } = harness({
      "agent.policy.writeRequiresApproval": false,
    });
    const chat = session({
      id: "s-1",
      kind: "chat",
      scopeJson: { unrestricted: true },
    } as never);
    expect(
      svc.check(chat, "update_task", { taskId: "t-1", patch: {} }, 0),
    ).toMatchObject({
      kind: "NEED_APPROVAL",
    });
    expect(svc.check(chat, "sop_publish", { sopId: "sop-1" }, 0)).toMatchObject(
      {
        kind: "NEED_APPROVAL",
      },
    );
  });

  it("write + writeRequiresApproval=true → NEED_APPROVAL；false → ALLOW", () => {
    const strict = harness({ "agent.policy.writeRequiresApproval": true });
    expect(
      strict.svc.check(chatSession(), "trigger_task", { taskId: "t-1" }, 0),
    ).toMatchObject({ kind: "NEED_APPROVAL" });
    const lax = harness({ "agent.policy.writeRequiresApproval": false });
    expect(
      lax.svc.check(chatSession(), "trigger_task", { taskId: "t-1" }, 0),
    ).toMatchObject({ kind: "ALLOW" });
  });

  it("resolveApprovalPolicy：字符串布尔解析（'1'/'0'/垃圾回退）", () => {
    const on = harness({ "agent.policy.writeRequiresApproval": "1" });
    expect(on.svc.resolveApprovalPolicy().writeRequiresApproval).toBe(true);
    const off = harness({ "agent.policy.writeRequiresApproval": "FALSE" });
    expect(off.svc.resolveApprovalPolicy().writeRequiresApproval).toBe(false);
    const junk = harness({ "agent.policy.writeRequiresApproval": "maybe" });
    expect(junk.svc.resolveApprovalPolicy().writeRequiresApproval).toBe(false);
    const blank = harness({ "agent.policy.writeRequiresApproval": "" });
    expect(blank.svc.resolveApprovalPolicy().writeRequiresApproval).toBe(false);
  });
});
