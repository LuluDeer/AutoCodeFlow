import { TaskController } from "../task.controller";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";

/**
 * QA-02（coverage 第一阶段）：任务主链路 HTTP 面的控制器行为。
 *
 * 历轮真 bug 均落在「控制器参数解析 → 服务调用 → 审计落痕」三段链上
 * （如 N2 priority 归一化在 enqueue 边界、OBS-03 level 过滤参数归一化、
 * R4-P1 COVER_EARLY 触发面），此前 task.controller 主链路只有 stream-logs
 * 一个专项 spec——本 spec 定向补齐「调用参数逐字传递 + 审计写点 + level
 * 参数归一化」三类断言，全部直调处理器（与 task.controller.stream-logs.spec
 * 同形态），不重复 service 层语义。
 */
describe("TaskController — 主链路端点委托与审计（QA-02）", () => {
  const user: AuthUser = {
    id: 7,
    username: "u7",
    email: "u7@x",
    role: UserRole.ADMIN,
    isActive: true,
  };
  const req = { ip: "10.0.0.9" } as any;

  const makeDeps = () => {
    const taskService = {
      create: jest.fn().mockResolvedValue({ id: "task-1" }),
      findAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findOne: jest.fn().mockResolvedValue({ id: "task-1" }),
      update: jest.fn().mockResolvedValue({ id: "task-1" }),
      remove: jest.fn().mockResolvedValue({ id: "task-1" }),
      trigger: jest.fn().mockResolvedValue({ executionId: "exec-9" }),
      pause: jest.fn().mockResolvedValue({ id: "task-1", status: "paused" }),
      resume: jest.fn().mockResolvedValue({ id: "task-1", status: "active" }),
      getExecutions: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getAllExecutions: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getExecution: jest.fn().mockResolvedValue({ id: "exec-1" }),
      getExecutionReport: jest.fn().mockResolvedValue({ execution: {} }),
      getExecutionLogs: jest
        .fn()
        .mockResolvedValue({ lines: [], totalLines: 0 }),
      getExecutionStats: jest.fn().mockResolvedValue({ successRate: 100 }),
      suggestSchedule: jest
        .fn()
        .mockResolvedValue({ suggestedCron: "* * * * *" }),
      analyzeExecution: jest.fn().mockResolvedValue({ id: "exec-1" }),
      killExecution: jest
        .fn()
        .mockResolvedValue({ id: "exec-1", status: "killed" }),
      rollback: jest.fn().mockResolvedValue({ id: "task-1" }),
      rollbackToVersion: jest.fn().mockResolvedValue({ id: "task-1" }),
      getVersions: jest.fn().mockResolvedValue([]),
      compareVersions: jest.fn().mockResolvedValue({ changes: [] }),
      updateGlue: jest.fn().mockResolvedValue({ id: "task-1" }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskController(taskService as any, audit as any);
    return { controller, taskService, audit };
  };

  it("create delegates the DTO and audits task.create with the resolved id", async () => {
    const { controller, taskService, audit } = makeDeps();
    const dto: any = { name: "n", triggerType: "cron" };

    const result = await controller.create(dto, user, req);

    expect(result).toEqual({ id: "task-1" });
    expect(taskService.create).toHaveBeenCalledWith(dto);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        username: "u7",
        action: "task.create",
        resource: "task",
        resourceId: "task-1",
        ip: "10.0.0.9",
      }),
    );
  });

  it("update delegates the PATCH body and audits task.update", async () => {
    const { controller, taskService, audit } = makeDeps();
    const dto: any = { description: "d" };

    await controller.update("task-1", dto, user, req);

    expect(taskService.update).toHaveBeenCalledWith("task-1", dto);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.update", resourceId: "task-1" }),
    );
  });

  it("trigger passes custom params and audits task.trigger", async () => {
    const { controller, taskService, audit } = makeDeps();
    const dto = { params: { k: "v" } } as any;

    await controller.trigger("task-1", dto, user, req);

    expect(taskService.trigger).toHaveBeenCalledWith("task-1", {
      params: { k: "v" },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.trigger", resourceId: "task-1" }),
    );
  });

  it("pause and resume delegate and audit their own action names", async () => {
    const { controller, taskService, audit } = makeDeps();

    await controller.pause("task-1", user, req);
    expect(taskService.pause).toHaveBeenCalledWith("task-1");
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "task.pause" }),
    );

    await controller.resume("task-1", user, req);
    expect(taskService.resume).toHaveBeenCalledWith("task-1");
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "task.resume" }),
    );
  });

  it("remove audits task.delete", async () => {
    const { controller, taskService, audit } = makeDeps();

    await controller.remove("task-1", user, req);

    expect(taskService.remove).toHaveBeenCalledWith("task-1");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.delete", resourceId: "task-1" }),
    );
  });

  it("rollback audits the git commit detail", async () => {
    const { controller, taskService, audit } = makeDeps();
    const dto = { gitCommit: "abc123" } as any;

    await controller.rollback("task-1", dto, user, req);

    expect(taskService.rollback).toHaveBeenCalledWith("task-1", {
      gitCommit: "abc123",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.rollback",
        detail: { gitCommit: "abc123" },
      }),
    );
  });

  it("rollbackToVersion and version reads delegate with task scoping", async () => {
    const { controller, taskService } = makeDeps();

    await controller.rollbackToVersion("task-1", "v-2", user, req);
    expect(taskService.rollbackToVersion).toHaveBeenCalledWith("task-1", "v-2");

    await controller.getVersions("task-1");
    expect(taskService.getVersions).toHaveBeenCalledWith("task-1");

    await controller.compareVersions("task-1", "v-1", "v-2");
    expect(taskService.compareVersions).toHaveBeenCalledWith(
      "task-1",
      "v-1",
      "v-2",
    );
  });

  it("killExecution verifies task scoping first, then audits with execution resource", async () => {
    const { controller, taskService, audit } = makeDeps();

    await controller.killExecution("task-1", "exec-1", user, req);

    // 任务作用域校验必须先于 kill（防跨任务 execution 操纵）
    expect(taskService.getExecution).toHaveBeenCalledWith("exec-1", "task-1");
    expect(taskService.killExecution).toHaveBeenCalledWith("exec-1");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.killExecution",
        resource: "task_execution",
        resourceId: "exec-1",
      }),
    );
  });

  it("executionLogs parses numeric params and normalizes the level filter", async () => {
    const { controller, taskService } = makeDeps();

    // 无参数 → 默认 fromLine=0 / limit=500 / level=undefined
    await controller.executionLogs("task-1", "exec-1", {} as any);
    expect(taskService.getExecutionLogs).toHaveBeenCalledWith(
      "exec-1",
      0,
      500,
      undefined,
    );

    // 数字解析 + 上限 2000 钳制 + 大小写 level 归一化
    await controller.executionLogs("task-1", "exec-1", {
      fromLine: "40",
      limit: "5000",
      level: "error",
    } as any);
    expect(taskService.getExecutionLogs).toHaveBeenLastCalledWith(
      "exec-1",
      40,
      2000,
      "ERROR",
    );

    // 任务作用域校验先行
    expect(taskService.getExecution).toHaveBeenCalledWith("exec-1", "task-1");
  });

  it("executionLogs passes undefined level for invalid values (no filtering)", async () => {
    const { controller, taskService } = makeDeps();

    await controller.executionLogs("task-1", "exec-1", {
      level: "not-a-level",
    } as any);
    expect(taskService.getExecutionLogs).toHaveBeenCalledWith(
      "exec-1",
      0,
      500,
      undefined,
    );
  });

  it("report and read-only endpoints delegate without audit writes", async () => {
    const { controller, taskService, audit } = makeDeps();

    await controller.execution("task-1", "exec-1");
    expect(taskService.getExecution).toHaveBeenCalledWith("exec-1", "task-1");

    await controller.executionReport("task-1", "exec-1");
    expect(taskService.getExecutionReport).toHaveBeenCalledWith(
      "exec-1",
      "task-1",
    );

    await controller.executions("task-1", { page: 2, pageSize: 10 } as any);
    expect(taskService.getExecutions).toHaveBeenCalledWith("task-1", {
      page: 2,
      pageSize: 10,
    });

    await controller.allExecutions({ status: "failed" } as any);
    expect(taskService.getAllExecutions).toHaveBeenCalledWith({
      status: "failed",
    });

    expect(audit.log).not.toHaveBeenCalled();
  });

  it("stats/schedule/glue endpoints delegate and glue/analyze audit their actions", async () => {
    const { controller, taskService, audit } = makeDeps();

    await controller.getStats("task-1");
    expect(taskService.getExecutionStats).toHaveBeenCalledWith("task-1");

    await controller.suggestSchedule("task-1");
    expect(taskService.suggestSchedule).toHaveBeenCalledWith("task-1");

    await controller.analyzeExecution("task-1", "exec-1", user, req);
    expect(taskService.analyzeExecution).toHaveBeenCalledWith("exec-1");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.analyzeExecution" }),
    );

    await controller.updateGlue(
      "task-1",
      { source: "print(1)", language: "python" },
      user,
      req,
    );
    expect(taskService.updateGlue).toHaveBeenCalledWith(
      "task-1",
      "print(1)",
      "python",
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.updateGlue" }),
    );
  });
});
