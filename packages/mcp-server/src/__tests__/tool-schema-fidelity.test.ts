/**
 * 工具 schema 保真度（F1，本轮审计）：**声明里没有的键，agent 永远传不进来**。
 *
 * ## 为什么这比"少一个字段"严重
 *
 * MCP SDK 把工具注册时给的原始 shape 归一成 `z.object(shape)` 再 parse，zod 默认
 * **剥掉未声明的键**（strip）。于是：
 *   · `update_application{mutexGroupId}` → 服务端只收到 `PUT … body={}`，而后端
 *     对空 patch 直接跳过写入并返回 200（还落一条 application.update 审计）；
 *   · `create_application{approvalRequired:true}` → 服务端收到 `{name,version,runtime}`，
 *     应用落库时审批门为 false —— 之后每次部署都直接下发，第二人审批被**静默取消**。
 * 两件事在调用方看来都是"成功"。这与「字段名拼错」不同：拼错至少有 400，
 * 剥键是**无声的**，所以必须用「走一遍 SDK 的 parse」来测，而不是直接把 args
 * 塞进 handler（后者会让这个缺陷永远绿——本文件存在的理由）。
 *
 * 反证：从 shape 里删掉任一字段 → 下面的断言立刻红（要么键不在 body 里，
 * 要么变成 NO_UPDATABLE_FIELDS）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface RegisteredTool {
  name: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

import {
  registerTaskTools,
  registerApplicationTools,
  registerMutexTools,
  registerDeploymentTools,
  registerExecutorTools,
  registerObservabilityTools,
  registerAuditTools,
  registerProjectTools,
  registerSopTools,
} from "../tools";

function setup() {
  const tools = new Map<string, RegisteredTool>();
  const call = vi.fn().mockResolvedValue({ ok: true });
  const server = {
    tool: (
      name: string,
      _description: string,
      schema: Record<string, z.ZodTypeAny>,
      fourth: unknown,
      fifth?: ToolHandler,
    ) => {
      tools.set(name, {
        name,
        schema,
        handler: (fifth ?? fourth) as ToolHandler,
      });
    },
  };
  for (const fn of [
    registerTaskTools,
    registerApplicationTools,
    registerMutexTools,
    registerDeploymentTools,
    registerExecutorTools,
    registerObservabilityTools,
    registerAuditTools,
    registerProjectTools,
    registerSopTools,
  ]) {
    fn(server as never, call as never);
  }
  return { tools, call };
}

/**
 * 走一遍 SDK 的解析：`z.object(shape).parse(args)`。
 * 这就是生产里发生的事——未声明的键在这里被剥掉。
 */
async function invoke(
  tools: Map<string, RegisteredTool>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const parsed = z.object(tool.schema).parse(args) as Record<string, unknown>;
  return tool.handler(parsed);
}

const bodyOf = (call: ReturnType<typeof vi.fn>, n = 0) =>
  call.mock.calls[n]?.[2] as Record<string, unknown> | undefined;

let tools: Map<string, RegisteredTool>;
let call: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ({ tools, call } = setup());
  call.mockClear();
  call.mockResolvedValue({ ok: true });
});

describe("update_application：声明的字段必须真的到达 HTTP body", () => {
  it("mutexGroupId 能穿过 SDK 解析并进入 PUT body（工具描述就是这么教用户的）", async () => {
    await invoke(tools, "update_application", {
      applicationId: "11111111-1111-4111-8111-111111111111",
      mutexGroupId: "22222222-2222-4222-8222-222222222222",
    });
    expect(call.mock.calls[0][0]).toBe("PUT");
    expect(bodyOf(call)).toEqual({
      mutexGroupId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("approvalRequired 关掉也要能传（关掉它 = 恢复直接派发，属安全相关变更）", async () => {
    await invoke(tools, "update_application", {
      applicationId: "11111111-1111-4111-8111-111111111111",
      approvalRequired: false,
    });
    // 关键：false 不是 undefined，必须原样发出去（被 strip 会变成"没改"）
    expect(bodyOf(call)).toEqual({ approvalRequired: false });
  });

  it("mutexGroupId: null 表示退出互斥组（显式 null 不能被当成「没传」丢掉）", async () => {
    await invoke(tools, "update_application", {
      applicationId: "11111111-1111-4111-8111-111111111111",
      mutexGroupId: null,
    });
    expect(bodyOf(call)).toEqual({ mutexGroupId: null });
  });

  it("一个可写字段都没传 → isError + NO_UPDATABLE_FIELDS（不再假成功）", async () => {
    const res = await invoke(tools, "update_application", {
      applicationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe("NO_UPDATABLE_FIELDS");
    // 列出可写字段，agent 能自我纠正而不是反复试
    expect(payload.message).toContain("mutexGroupId");
    expect(call).not.toHaveBeenCalled();
  });
});

describe("update_task：CreateTaskDto 的写面字段不能缺", () => {
  const taskId = "33333333-3333-4333-8333-333333333333";

  it("projectId / alarmChannels / runbook / runtimeVersion / retryDelay 全部到达 PATCH body", async () => {
    await invoke(tools, "update_task", {
      taskId,
      projectId: "44444444-4444-4444-8444-444444444444",
      alarmChannels: ["ops@example.com"],
      runbook: "## 处置\n先看日志",
      runtimeVersion: "3.12",
      retryDelay: 30,
    });
    expect(call.mock.calls[0][0]).toBe("PATCH");
    expect(bodyOf(call)).toEqual({
      projectId: "44444444-4444-4444-8444-444444444444",
      alarmChannels: ["ops@example.com"],
      runbook: "## 处置\n先看日志",
      runtimeVersion: "3.12",
      retryDelay: 30,
    });
  });

  it("codeSource / retryableErrors 同批生效（含显式 null 清除声明）", async () => {
    await invoke(tools, "update_task", {
      taskId,
      codeSource: "application_zip",
      retryableErrors: ["ETIMEDOUT", "429"],
    });
    expect(bodyOf(call)).toEqual({
      codeSource: "application_zip",
      retryableErrors: ["ETIMEDOUT", "429"],
    });

    call.mockClear();
    await invoke(tools, "update_task", { taskId, codeSource: null });
    expect(bodyOf(call)).toEqual({ codeSource: null });
  });

  it("约束与后端 DTO 同口径：runtimeVersion 必须 major.minor、retryDelay 0..86400", async () => {
    await expect(
      invoke(tools, "update_task", { taskId, runtimeVersion: "3" }),
    ).rejects.toThrow();
    await expect(
      invoke(tools, "update_task", { taskId, retryDelay: 86_401 }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("retryableErrors 元素不得含逗号（simple-array 落库会被劈成两条）", async () => {
    await expect(
      invoke(tools, "update_task", { taskId, retryableErrors: ["a,b"] }),
    ).rejects.toThrow();
  });

  it("空 patch → isError + NO_UPDATABLE_FIELDS，不发出 PATCH", async () => {
    const res = await invoke(tools, "update_task", { taskId });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("NO_UPDATABLE_FIELDS");
    expect(call).not.toHaveBeenCalled();
  });
});

describe("create_application：审批门与互斥组在创建时就该可设", () => {
  it("approvalRequired:true 必须发出去（漏了 = 第二人审批被静默取消）", async () => {
    await invoke(tools, "create_application", {
      name: "payments",
      version: "1.0.0",
      runtime: "node",
      approvalRequired: true,
      mutexGroupId: "55555555-5555-4555-8555-555555555555",
    });
    expect(call.mock.calls[0][0]).toBe("POST");
    const body = call.mock.calls[0][2] as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "payments",
      version: "1.0.0",
      runtime: "node",
      approvalRequired: true,
      mutexGroupId: "55555555-5555-4555-8555-555555555555",
    });
  });
});

describe("deploy_application / deploy_app：目标机被静默替换必须说出来（F4）", () => {
  const execA = "66666666-6666-4666-8666-666666666666";
  const execB = "77777777-7777-4777-8777-777777777777";
  const appId = "11111111-1111-4111-8111-111111111111";

  it("后端改投另一台 → executorReassigned=true + 说明实际机器（仍算成功）", async () => {
    call.mockResolvedValueOnce({ id: "d1", status: "running", executorId: execB });
    const res = await invoke(tools, "deploy_application", {
      applicationId: appId,
      executorId: execA,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(res.isError).toBeUndefined();
    expect(payload.executorReassigned).toBe(true);
    expect(payload.requestedExecutorId).toBe(execA);
    expect(payload.actualExecutorId).toBe(execB);
    expect(payload.note).toContain(execB);
    expect(payload.note).toContain("NOT to");
  });

  it("派到指定机器 → 不许多出 reassigned 标记（回归：不误报）", async () => {
    call.mockResolvedValueOnce({ id: "d1", status: "running", executorId: execA });
    const res = await invoke(tools, "deploy_application", {
      applicationId: appId,
      executorId: execA,
    });
    expect(JSON.parse(res.content[0].text).executorReassigned).toBeUndefined();
  });

  it("executorId 不是 uuid → 解析期就拒（不再让后端静默改投）", async () => {
    await expect(
      invoke(tools, "deploy_application", { applicationId: appId, executorId: "MY-LAPTOP" }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("deploy_app 同一条判据（按名字部署时也会改投）", async () => {
    call.mockResolvedValueOnce([{ id: appId, name: "payments" }]);
    call.mockResolvedValueOnce({ id: "d2", status: "running", executorId: execB });
    const res = await invoke(tools, "deploy_app", {
      appName: "payments",
      executorId: execA,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.executorReassigned).toBe(true);
    expect(payload.actualExecutorId).toBe(execB);
  });
});
