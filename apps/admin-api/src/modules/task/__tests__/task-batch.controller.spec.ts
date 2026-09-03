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
      expect(taskSvc.pause).toHaveBeenCalledWith("t1");
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
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "task.batch_resume" }),
      );
    });
  });

  describe("batchDelete", () => {
    it("deletes all tasks and logs audit", async () => {
      taskSvc.remove.mockResolvedValue(undefined);
      await controller.batchDelete({ taskIds: ["t1"] }, adminUser, mockReq);
      expect(taskSvc.remove).toHaveBeenCalledWith("t1");
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
});
