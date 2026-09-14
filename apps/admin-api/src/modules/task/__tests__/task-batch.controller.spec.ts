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
});
