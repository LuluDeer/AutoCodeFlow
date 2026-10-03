/**
 * A-1（执行器域审计 P1）：broadcast 模式与互斥组互斥——写面拒绝闸。
 *
 * 背景：互斥组挂在应用上（applications.mutexGroupId），执行行创建时经
 * resolveTaskMutexGroupId 快照带下；dispatchBroadcast 派发时全程不调
 * claimExecutorSlotForExecution 占坑闸，"broadcast + 应用挂互斥组"的任务会
 * 静默绕过组内并发约束。调度语义不可调和（广播 = 同刻扇出全部目标，单执行行
 * 的占用标记无法表达 N 目标并发），故在任务写面直接 400 拒绝：
 *   - create：请求体终态判定；
 *   - update：合并后实体态判定（R7/N17 先例）+ 作用域门（NFR-05 先例，
 *     只在本次请求确实编辑了 executeMode / applicationId 时判定，存量历史行
 *     连改 timeout 都被拒会把合法 PATCH 一起挡死）。
 * 装配形态沿用 task.service.spec 的 provider 结构（裁剪到本闸所需面）。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { TaskService } from "../task.service";
import { Task, TaskStatus } from "../entities/task.entity";
import { TaskExecution } from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { ExecutorService } from "../../executor/executor.service";
import { AuditService } from "../../audit/audit.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { Application } from "../../application/entities/application.entity";
import { ExecuteMode } from "../entities/task.entity";

const makeRepo = () => ({
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
});

describe("TaskService — A-1 broadcast × mutex group 写面互斥闸", () => {
  let service: TaskService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let appRepo: { findOne: jest.Mock };

  const appWithMutexGroup = {
    id: "app-1",
    name: "browser-farm",
    mutexGroupId: "mutex-group-1",
  };
  const appWithoutMutexGroup = {
    id: "app-2",
    name: "plain-app",
    mutexGroupId: null,
  };

  beforeEach(async () => {
    taskRepo = makeRepo();
    appRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const dataSource = {
      // A-1 闸经 dataSource.getRepository(Application) 读应用行（与
      // assertCodeSourceConsistent 同款：只 import 实体类，不引入模块环）。
      getRepository: jest.fn((entity: unknown) => {
        expect(entity).toBe(Application);
        return appRepo;
      }),
      transaction: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: makeRepo() },
        { provide: getRepositoryToken(ExecutionLogLine), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SchedulerService,
          useValue: { stop: jest.fn(), scheduleOne: jest.fn() },
        },
        {
          provide: AiService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn() },
        },
        { provide: ExecutorService, useValue: {} },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    service = module.get(TaskService);
  });

  describe("create", () => {
    it("broadcast + 应用挂互斥组 → 400 拒绝且不落库", async () => {
      appRepo.findOne.mockResolvedValue(appWithMutexGroup);
      taskRepo.save.mockResolvedValue({ id: "1" });
      await expect(
        service.create({
          name: "bc",
          triggerType: "api",
          applicationId: "app-1",
          executeMode: ExecuteMode.BROADCAST,
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create({
          name: "bc",
          triggerType: "api",
          applicationId: "app-1",
          executeMode: ExecuteMode.BROADCAST,
        } as any),
      ).rejects.toThrow(/incompatible with a mutex group/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("broadcast + 应用未挂互斥组 → 放行（现状零变化）", async () => {
      appRepo.findOne.mockResolvedValue(appWithoutMutexGroup);
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      const result = await service.create({
        name: "bc",
        triggerType: "api",
        applicationId: "app-2",
        executeMode: ExecuteMode.BROADCAST,
      } as any);
      expect(result.id).toBe("1");
      expect(appRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "app-2" } }),
      );
    });

    it("broadcast 且未绑定应用（无互斥来源）→ 放行且不查应用", async () => {
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      await service.create({
        name: "bc",
        triggerType: "api",
        executeMode: ExecuteMode.BROADCAST,
      } as any);
      expect(appRepo.findOne).not.toHaveBeenCalled();
      expect(taskRepo.save).toHaveBeenCalled();
    });

    it("single 模式 + 应用挂互斥组 → 放行（闸只针对 broadcast）", async () => {
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      await service.create({
        name: "single",
        triggerType: "api",
        applicationId: "app-1",
        executeMode: ExecuteMode.SINGLE,
      } as any);
      expect(appRepo.findOne).not.toHaveBeenCalled();
      expect(taskRepo.save).toHaveBeenCalled();
    });
  });

  describe("update（PATCH 合并态 + 作用域门）", () => {
    it("PATCH 切 broadcast，应用挂互斥组 → 400（合并态判定）", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        applicationId: "app-1",
        executeMode: ExecuteMode.SINGLE,
      });
      appRepo.findOne.mockResolvedValue(appWithMutexGroup);
      await expect(
        service.update("1", { executeMode: "broadcast" } as any),
      ).rejects.toThrow(BadRequestException);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH applicationId 指向挂组的 app，任务已是 broadcast → 400", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        applicationId: "app-2",
        executeMode: ExecuteMode.BROADCAST,
      });
      appRepo.findOne.mockResolvedValue(appWithMutexGroup);
      await expect(
        service.update("1", { applicationId: "app-1" } as any),
      ).rejects.toThrow(BadRequestException);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("作用域门：存量 broadcast+挂组任务 PATCH timeout → 放行（不误伤合法 PATCH）", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "legacy",
        status: TaskStatus.PAUSED,
        applicationId: "app-1",
        executeMode: ExecuteMode.BROADCAST,
      });
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      const result: any = await service.update("1", {
        timeoutSeconds: 120,
      } as any);
      expect(result.timeout).toBe(120);
      expect(appRepo.findOne).not.toHaveBeenCalled();
      expect(taskRepo.save).toHaveBeenCalled();
    });

    it("作用域门：PATCH applicationId 切到未挂组的 app → 放行", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        applicationId: "app-1",
        executeMode: ExecuteMode.BROADCAST,
      });
      appRepo.findOne.mockResolvedValue(appWithoutMutexGroup);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      const result: any = await service.update("1", {
        applicationId: "app-2",
      } as any);
      expect(result.applicationId).toBe("app-2");
      expect(taskRepo.save).toHaveBeenCalled();
    });
  });
});
