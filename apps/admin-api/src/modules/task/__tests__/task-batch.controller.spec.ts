import { Test, TestingModule } from "@nestjs/testing";
import { TaskBatchController } from "../task-batch.controller";
import { TaskService } from "../task.service";
import { AuditService } from "../../audit/audit.service";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";

const mockTaskService = () => ({
  trigger: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
  remove: jest.fn(),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const adminUser: AuthUser = {
  id: 1,
  username: "admin",
  role: UserRole.ADMIN,
} as AuthUser;
const mockReq = { ip: "10.0.0.1" } as any;

describe("TaskBatchController", () => {
  let controller: TaskBatchController;
  let taskSvc: ReturnType<typeof mockTaskService>;
  let auditSvc: ReturnType<typeof mockAuditService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TaskBatchController],
      providers: [
        { provide: TaskService, useFactory: mockTaskService },
        { provide: AuditService, useFactory: mockAuditService },
      ],
    }).compile();

    controller = module.get(TaskBatchController);
    taskSvc = module.get(TaskService);
    auditSvc = module.get(AuditService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("batchTrigger", () => {
    it("triggers all tasks and logs audit", async () => {
      taskSvc.trigger.mockResolvedValue({ id: "exec-1" });
      const body = { taskIds: ["t1", "t2"] };

      const result = await controller.batchTrigger(body, adminUser, mockReq);

      expect(taskSvc.trigger).toHaveBeenCalledTimes(2);
      // R-02: user 必须透传 service（漏传时属主/角色判定恒失真）
      expect(taskSvc.trigger).toHaveBeenCalledWith("t1", {}, adminUser);
      expect(result).toHaveLength(2);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "task.batch_trigger",
          detail: { taskIds: ["t1", "t2"] },
        }),
      );
    });

    it("returns error objects for failed tasks without aborting others", async () => {
      taskSvc.trigger
        .mockResolvedValueOnce({ id: "exec-1" })
        .mockRejectedValueOnce(new Error("not found"));

      const result = await controller.batchTrigger(
        { taskIds: ["t1", "t2"] },
        adminUser,
        mockReq,
      );

      expect(result[0]).toEqual({ id: "exec-1" });
      expect(result[1]).toEqual({ id: "t2", error: "not found" });
      // Audit still fires even when some tasks fail
      expect(auditSvc.log).toHaveBeenCalled();
    });
  });

  describe("batchPause", () => {
    it("pauses all tasks and logs audit", async () => {
      taskSvc.pause.mockResolvedValue(undefined);
      await controller.batchPause({ taskIds: ["t1"] }, adminUser, mockReq);
      // R-02: user 必须透传 service
      expect(taskSvc.pause).toHaveBeenCalledWith("t1", adminUser);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.batch_pause" }),
      );
    });

    it("partial failures are captured in results", async () => {
      taskSvc.pause.mockRejectedValue(new Error("locked"));
      const result = await controller.batchPause(
        { taskIds: ["t1"] },
        adminUser,
        mockReq,
      );
      expect(result[0]).toEqual({ id: "t1", error: "locked" });
    });
  });

  describe("batchResume", () => {
    it("resumes all tasks and logs audit", async () => {
      taskSvc.resume.mockResolvedValue(undefined);
      await controller.batchResume(
        { taskIds: ["t1", "t2"] },
        adminUser,
        mockReq,
      );
      expect(taskSvc.resume).toHaveBeenCalledTimes(2);
      // R-02: user 必须透传 service
      expect(taskSvc.resume).toHaveBeenCalledWith("t1", adminUser);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.batch_resume" }),
      );
    });
  });

  describe("batchDelete", () => {
    it("deletes all tasks and logs audit", async () => {
      taskSvc.remove.mockResolvedValue(undefined);
      await controller.batchDelete({ taskIds: ["t1"] }, adminUser, mockReq);
      // R-02: user 必须透传 service——漏传时 assertCanWrite 的 ADMIN/属主
      // 判定双双不成立，批量删除对所有人恒 403
      expect(taskSvc.remove).toHaveBeenCalledWith("t1", adminUser);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.batch_delete" }),
      );
    });

    it("partial failures do not abort remaining deletes", async () => {
      taskSvc.remove
        .mockRejectedValueOnce(new Error("in use"))
        .mockResolvedValueOnce(undefined);

      const result = await controller.batchDelete(
        { taskIds: ["t1", "t2"] },
        adminUser,
        mockReq,
      );
      expect(result[0]).toEqual({ id: "t1", error: "in use" });
      expect(result[1]).toBeUndefined();
    });
  });

  // PK-20（DEEP_REVIEW 0ef3bbe）: 双事实源收敛——/tasks-batch/* 已标记 deprecated，
  // canonical 主路由为 /tasks/batch/*（TaskController 内）。两套实现调用同一
  // TaskService 方法（trigger/pause/resume/remove，user 透传两处一致，见上方
  // R-02 断言）。此处钉住 deprecated 标记不被误删。
  describe("PK-20: /tasks-batch/* 双事实源收敛（deprecated 标记）", () => {
    const SWAGGER_OPERATION_META = "swagger/apiOperation";
    const methods: Array<keyof TaskBatchController> = [
      "batchTrigger",
      "batchPause",
      "batchResume",
      "batchDelete",
    ];

    it("四个批量端点的 @ApiOperation 均标记 deprecated: true", () => {
      for (const m of methods) {
        const meta = Reflect.getMetadata(
          SWAGGER_OPERATION_META,
          (
            TaskBatchController.prototype as unknown as Record<string, unknown>
          )[m],
        ) as { deprecated?: boolean; summary?: string };
        expect(meta).toBeDefined();
        expect(meta!.deprecated).toBe(true);
        expect(meta!.summary).toContain("deprecated");
      }
    });

    it("控制器路由前缀为 tasks-batch（deprecated 家族，勿删路由）", () => {
      const prefix = Reflect.getMetadata(
        "path",
        TaskBatchController,
      ) as string;
      expect(prefix).toBe("tasks-batch");
    });
  });

  // R-27（DEEP_REVIEW 0ef3bbe）: 行为级断言——旧测试只断言「调用了 service」，
  // 把 R-01/R-02 类缺陷（结果被吞、审计漏记 id、跨方法错接）固化。这里钉住
  // 控制器的真实可观察行为：① 结果数组按输入顺序对齐（成功项原样透传 service
  // 返回值，失败项包成 {id,error}）；② 审计 detail.taskIds 为全量输入列表且
  // 透传 req.ip；③ 每个 id 路由到正确的 service 方法（不跨接）。
  describe("R-27: 批量端点行为级断言（非仅委托断言）", () => {
    it("batchTrigger 结果按输入顺序对齐：成功项原样透传、失败项包错误", async () => {
      taskSvc.trigger
        .mockResolvedValueOnce({ id: "exec-A" })
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ id: "exec-C" });

      const result = await controller.batchTrigger(
        { taskIds: ["t1", "t2", "t3"] },
        adminUser,
        mockReq,
      );

      // 顺序对齐 + 成功值原样透传（不被二次包装）+ 失败项错误文本原样带出
      expect(result[0]).toEqual({ id: "exec-A" });
      expect(result[1]).toEqual({ id: "t2", error: "boom" });
      expect(result[2]).toEqual({ id: "exec-C" });
      // R-27: user 主体逐 id 透传（不被丢弃/错接）；trigger 中位为 TriggerTaskDto
      expect(taskSvc.trigger).toHaveBeenNthCalledWith(1, "t1", {}, adminUser);
      expect(taskSvc.trigger).toHaveBeenNthCalledWith(2, "t2", {}, adminUser);
      expect(taskSvc.trigger).toHaveBeenNthCalledWith(3, "t3", {}, adminUser);
    });

    it("batchPause 混合结果：成功项返回 service 真值，失败项包 {id,error}", async () => {
      taskSvc.pause
        .mockResolvedValueOnce({ paused: true })
        .mockRejectedValueOnce(new Error("already paused"));

      const result = await controller.batchPause(
        { taskIds: ["ok", "bad"] },
        adminUser,
        mockReq,
      );

      expect(result[0]).toEqual({ paused: true });
      expect(result[1]).toEqual({ id: "bad", error: "already paused" });
      // 每 id 都命中 pause 方法（不错接到 trigger/resume/remove）
      expect(taskSvc.pause).toHaveBeenCalledWith("ok", adminUser);
      expect(taskSvc.pause).toHaveBeenCalledWith("bad", adminUser);
      expect(taskSvc.trigger).not.toHaveBeenCalled();
      expect(taskSvc.resume).not.toHaveBeenCalled();
      expect(taskSvc.remove).not.toHaveBeenCalled();
    });

    it("batchResume 结果原样透传，且审计记录全量 taskIds + req.ip", async () => {
      taskSvc.resume.mockResolvedValue({ resumed: true });

      await controller.batchResume(
        { taskIds: ["r1", "r2", "r3"] },
        adminUser,
        mockReq,
      );

      // 审计不漏记/截断 id，且 req.ip 透传
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "task.batch_resume",
          detail: { taskIds: ["r1", "r2", "r3"] },
          ip: "10.0.0.1",
          userId: 1,
          username: "admin",
        }),
      );
      // R-27: user 主体逐 id 透传
      expect(taskSvc.resume).toHaveBeenNthCalledWith(1, "r1", adminUser);
      expect(taskSvc.resume).toHaveBeenNthCalledWith(2, "r2", adminUser);
      expect(taskSvc.resume).toHaveBeenNthCalledWith(3, "r3", adminUser);
    });

    it("batchDelete 部分失败时审计仍记录全部 id（含失败项）", async () => {
      taskSvc.remove
        .mockRejectedValueOnce(new Error("in use"))
        .mockResolvedValueOnce(undefined);

      const result = await controller.batchDelete(
        { taskIds: ["d1", "d2"] },
        adminUser,
        mockReq,
      );

      expect(result[0]).toEqual({ id: "d1", error: "in use" });
      expect(result[1]).toBeUndefined();
      // 即使 d1 失败，审计仍记全量 d1+d2（不漏失败 id）
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "task.batch_delete",
          detail: { taskIds: ["d1", "d2"] },
        }),
      );
      // R-27: user 主体逐 id 透传（含失败项）
      expect(taskSvc.remove).toHaveBeenNthCalledWith(1, "d1", adminUser);
      expect(taskSvc.remove).toHaveBeenNthCalledWith(2, "d2", adminUser);
    });
  });
});
