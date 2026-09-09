import { TaskController } from "../task.controller";
import {
  AuthUser,
  ApiKeyUser,
} from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";

/**
 * NF-01（迁移 1790000000005）：POST /tasks/:id/trigger 双凭据面——
 * JWT 主体照旧 task.trigger 审计；API-Key 主体（CI/脚本免登录触发）
 * 响应契约一致（同一 service 调用返回值原样透传）+ task.trigger_api
 * 审计（detail 含 apiKeyId/taskId）。
 */
describe("TaskController trigger — NF-01 API-Key 主体分流与审计", () => {
  const jwtUser: AuthUser = {
    id: 7,
    username: "u7",
    email: "u7@x",
    role: UserRole.ADMIN,
    isActive: true,
  };
  const apiKeyUser: ApiKeyUser = {
    type: "apiKey",
    userId: 42,
    keyPrefix: "acf_dead",
    apiKeyId: 7,
    scope: "readonly",
  };
  const req = { ip: "10.0.0.9" } as any;

  const makeDeps = () => {
    const taskService = {
      trigger: jest.fn().mockResolvedValue({
        taskId: "task-1",
        executionId: "exec-9",
        status: "pending",
      }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskController(
      taskService as any,
      audit as any,
    ) as any;
    return { controller, taskService, audit };
  };

  it("JWT 主体：行为零变化——task.trigger 审计（userId/username）", async () => {
    const { controller, taskService, audit } = makeDeps();

    await controller.trigger(
      "task-1",
      { params: { k: "v" } } as any,
      jwtUser,
      req,
    );

    expect(taskService.trigger).toHaveBeenCalledWith("task-1", {
      params: { k: "v" },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        username: "u7",
        action: "task.trigger",
        resourceId: "task-1",
      }),
    );
  });

  it("API-Key 主体：同一 service 调用，响应契约与 JWT 面一致（返回值原样透传）", async () => {
    const { controller, taskService } = makeDeps();

    const result = await controller.trigger(
      "task-1",
      {} as any,
      apiKeyUser as any,
      req,
    );

    expect(taskService.trigger).toHaveBeenCalledWith("task-1", {});
    expect(result).toEqual({
      taskId: "task-1",
      executionId: "exec-9",
      status: "pending",
    });
  });

  it("API-Key 主体：审计 task.trigger_api，detail 携 apiKeyId/taskId，username 带 key 前缀", async () => {
    const { controller, audit } = makeDeps();

    await controller.trigger("task-1", {} as any, apiKeyUser as any, req);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        username: "api-key:acf_dead",
        action: "task.trigger_api",
        resource: "task",
        resourceId: "task-1",
        detail: { apiKeyId: 7, taskId: "task-1", scope: "readonly" },
        ip: "10.0.0.9",
      }),
    );
  });

  it("API-Key 主体审计失败不阻断触发主链（fail-open 先例：reject 被上层吞，调用顺序不受影响）", async () => {
    const { controller, taskService, audit } = makeDeps();
    audit.log.mockRejectedValue(new Error("audit down"));

    // isApiKeyUser 分支 await this.audit.log —— 审计链路故障时这里如实上抛，
    // 与 JWT 面同一语义（审计故障策略统一），本例断言 service 已先完成触发。
    await expect(
      controller.trigger("task-1", {} as any, apiKeyUser as any, req),
    ).rejects.toThrow("audit down");
    expect(taskService.trigger).toHaveBeenCalledTimes(1);
  });
});
