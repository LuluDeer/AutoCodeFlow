import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, QueryFailedError } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { TaskService } from "../task.service";
import { MAX_DEPENDENCY_EXECUTION_SCAN } from "../task.service";
import {
  Task,
  TaskStatus,
  normalizeTaskPriority,
} from "../entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { ConfigService } from "@nestjs/config";
import { ExecutorService } from "../../executor/executor.service";
import { NotificationService } from "../../notification/notification.service";
import { AuditService } from "../../audit/audit.service";
// ARCH-21: 事件总线 mock——handleCallback 终态事件（execution.completed/
// execution.failed）的发布断言打在此桩上；NotificationService 断言已随
// notifyCallbackFailure 迁至 listener 等价 spec（execution-events.listener.spec）。
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { DOMAIN_EVENTS } from "../../../common/events/domain-events";
// SEC-02: secrets 加密服务（测试默认降级明文；加密/脱敏专项断言另有 spec）
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
// OBS-04（001 在途）：TaskService 新增注入的读侧实体（本 spec 仅注册空仓 provider）
import { ExecutionReport } from "../../metrics/entities/execution-report.entity";
// 可观测性补齐轮：运行时计数器模块级快照（埋点断言入口）
import {
  getRuntimeCountersSnapshot,
  getRuntimeGaugesSnapshot,
  resetRuntimeGauges,
  resetRuntimeMetrics,
} from "../../metrics/runtime-metrics-entry";

jest.mock("axios");

/** 读取运行时计数（模块级单调快照；afterEach 重置保证用例隔离） */
const runtimeCount = (
  name: string,
  labels: Record<string, string> = {},
): number =>
  getRuntimeCountersSnapshot()
    .get(name as never)
    ?.get(JSON.stringify(labels)) ?? 0;

const makeRepo = (overrides: Record<string, jest.Mock> = {}) => {
  const repo: Record<string, jest.Mock> = {
    create: jest.fn((d) => d),
    save: jest.fn((e) => Promise.resolve(e)),
    findOne: jest.fn(),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  repo.createQueryBuilder = jest.fn(() => {
    let patch: Record<string, unknown> | null = null;
    // Snapshot the most recent findOne result at QB creation time so the
    // conditional update only sees the entity this QB is targeting — not
    // whatever findOne call happens to be last across the test.
    const target = repo.findOne.mock.results.length
      ? repo.findOne.mock.results[repo.findOne.mock.results.length - 1].value
      : null;
    const qb: Record<string, jest.Mock> = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      // handleCallback / killExecution 的终态 UPDATE 现携带 RETURNING，
      // 需可链式；execute 下方回填 raw 以模拟 PG 的 RETURNING 行。
      returning: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
      update: jest.fn().mockReturnThis(),
      set: jest.fn((p: Record<string, unknown>) => {
        patch = p;
        return qb;
      }),
      // Mimic a conditional UPDATE: apply the patch onto the snapshot entity
      // captured above so tests can assert on it, and report affected=0 when
      // the entity was not found or already terminal. Mirrors the production
      // `killExecution` / `handleCallback` semantic where the UPDATE is
      // guarded by `status IN (PENDING, RUNNING)`.
      execute: jest.fn().mockImplementation(async () => {
        const entity = await target;
        if (!entity) return { affected: 0 };
        const status = (entity as { status?: string }).status;
        const TERMINAL = [
          "success",
          "failed",
          "timeout",
          "cancelled",
          "killed",
        ];
        if (status && TERMINAL.includes(status)) {
          return { affected: 0 };
        }
        if (patch) Object.assign(entity, patch);
        // 模拟 UPDATE ... RETURNING ["id","executorAddress"]：回填被更新行的
        // id / executorAddress（取自当前实体快照），供释放槽位/日志回填读取。
        return {
          affected: 1,
          raw: [
            {
              id: (entity as { id?: string }).id,
              executorAddress:
                (entity as { executorAddress?: string | null })
                  .executorAddress ?? null,
            },
          ],
        };
      }),
    };
    return qb;
  });
  return { ...repo, ...overrides };
};

describe("TaskService (__tests__)", () => {
  let service: TaskService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let taskQueue: { add: jest.Mock };
  let dataSource: { transaction: jest.Mock; createQueryBuilder: jest.Mock };
  let releaseSlotExecute: jest.Mock;
  let schedulerService: {
    stop: jest.Mock;
    scheduleOne: jest.Mock;
    getStats: jest.Mock;
  };
  // ARCH-21: 终态事件发布断言入口（DomainEventBus 桩）。
  let eventBus: {
    emit: jest.Mock;
    on: jest.Mock;
    off: jest.Mock;
    listenerCount: jest.Mock;
  };
  // P2: kill 通知实现收敛至 ExecutorService.notifyExecutorKill，TaskService
  // 侧只保留委托（空地址跳过 + 异常兜底），用例断言委托调用。
  let executorServiceMock: {
    getExecutorUrl: jest.Mock;
    getSharedToken: jest.Mock;
    notifyExecutorKill: jest.Mock;
    // CORE-04: kill_retry re-enqueue
    scheduleRetryAfterRecovery: jest.Mock;
    hasRetryBudget: jest.Mock;
  };

  beforeEach(async () => {
    // 可观测性补齐轮：运行时计数是模块级进程内计数，跨用例显式重置
    resetRuntimeMetrics();
    taskRepo = makeRepo();
    execRepo = makeRepo();
    logLineRepo = makeRepo();
    versionRepo = makeRepo();
    taskQueue = { add: jest.fn().mockResolvedValue({}) };
    releaseSlotExecute = jest.fn().mockResolvedValue({ affected: 1 });
    dataSource = {
      // R4-P2: storeLogLines now runs delete+insert inside ONE DB transaction.
      // Default the mock executes the callback with a manager delegating to
      // the logLineRepo mocks so existing per-call assertions keep working;
      // tests that need rollback semantics override transaction entirely.
      transaction: jest.fn(async (fn: any) =>
        fn({
          delete: jest.fn(async (_target: unknown, criteria: unknown) =>
            logLineRepo.delete(criteria as any),
          ),
          save: jest.fn(async (_target: unknown, rows: unknown) =>
            logLineRepo.save(rows as any),
          ),
        }),
      ),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: releaseSlotExecute,
      })),
    };
    schedulerService = {
      stop: jest.fn(),
      scheduleOne: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({}),
    };

    const aiService = {
      analyzeFailure: jest.fn().mockResolvedValue(""),
      chat: jest.fn().mockResolvedValue(""),
    };

    eventBus = {
      emit: jest.fn().mockReturnValue(true),
      on: jest.fn(),
      off: jest.fn(),
      listenerCount: jest.fn().mockReturnValue(0),
    };
    executorServiceMock = {
      getExecutorUrl: jest
        .fn()
        .mockImplementation(
          (_addr: string, p: string) => `http://executor:3001/${p}`,
        ),
      // 日志回填 token 现走 DB 优先的 getSharedToken（与 dispatch/push 一致）
      getSharedToken: jest.fn().mockResolvedValue(""),
      notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
      // CORE-04: kill_retry 经 scheduleRetryAfterRecovery re-enqueue
      scheduleRetryAfterRecovery: jest.fn().mockResolvedValue(undefined),
      hasRetryBudget: jest.fn().mockReturnValue(true),
    };

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        { provide: DataSource, useValue: dataSource },
        { provide: SchedulerService, useValue: schedulerService },
        { provide: AiService, useValue: aiService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        { provide: ExecutorService, useValue: executorServiceMock },
        // ARCH-21: TaskService 不再注入 NotificationService/AuditService
        // （notifyCallbackFailure 已迁 listener）；改为事件总线桩，终态
        // 事件断言打在此处。
        { provide: DomainEventBus, useValue: eventBus },
        // SEC-02: 默认降级明文（key 空）——既有用例语义零变化
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
        // OBS-04（001 在途）：TaskService 新增 ExecutionReport 注入——本 spec
        // 补空仓 provider 兜底（002/CORE-02 提交时工作区共存，147 例用例
        // 因缺 provider 整套红；此 provider 为结构性兜底，不改变任何断言）。
        { provide: getRepositoryToken(ExecutionReport), useValue: {} },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  describe("create", () => {
    it("creates and saves a task with no dependencies", async () => {
      const dto = { name: "test-task" } as any;
      taskRepo.save.mockResolvedValue({ id: "1", ...dto });
      const result = await service.create(dto);
      expect(taskRepo.create).toHaveBeenCalledWith(dto);
      expect(taskRepo.save).toHaveBeenCalled();
      expect(result).toHaveProperty("id", "1");
    });

    it("maps timeoutSeconds to legacy timeout on create", async () => {
      const dto = {
        name: "test-task",
        timeoutSeconds: 120,
        timezone: "Asia/Shanghai",
      } as any;
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      taskRepo.create.mockImplementation((t: any) => t);
      await service.create(dto);
      expect(taskRepo.create).toHaveBeenCalledWith({
        name: "test-task",
        timeout: 120,
        timezone: "Asia/Shanghai",
      });
    });

    it("throws on circular self-dependency", async () => {
      const dto = {
        id: "task-a",
        name: "cycle",
        dependencies: { dep1: "task-a" },
      } as any;
      await expect(service.create(dto)).rejects.toThrow("Circular dependency");
    });

    // W-21: requirements normalization — trim specs, reject option-like and
    // blank entries at create so they 400 instead of burning a queued exec.
    describe("create requirements normalization (W-21)", () => {
      it("trims each requirement spec", async () => {
        taskRepo.create.mockImplementation((t: any) => t);
        taskRepo.save.mockImplementation((t: any) =>
          Promise.resolve({ id: "1", ...t }),
        );
        await service.create({
          name: "t",
          requirements: ["  requests>=2.31  ", " rich==13.7.1 "],
        } as any);
        expect(taskRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            requirements: ["requests>=2.31", "rich==13.7.1"],
          }),
        );
      });

      it("rejects an option-like spec (leading dash)", async () => {
        await expect(
          service.create({
            name: "t",
            requirements: ["--index-url", "http://evil"],
          } as any),
        ).rejects.toThrow(/options are not allowed/);
      });

      it("rejects a blank requirement entry", async () => {
        await expect(
          service.create({ name: "t", requirements: ["  "] } as any),
        ).rejects.toThrow(/non-empty/);
      });
    });

    // R6: 客户端自带已存在 id 时返回 409，而非 PG 主键冲突裸 500
    describe("create with client-supplied id (R6)", () => {
      const UUID = "550e8400-e29b-41d4-a716-446655440000";

      it("throws ConflictException when the id already exists (pre-check)", async () => {
        taskRepo.findOne.mockResolvedValue({ id: UUID, name: "existing" });
        await expect(
          service.create({ id: UUID, name: "t", triggerType: "api" } as any),
        ).rejects.toThrow(ConflictException);
        expect(taskRepo.save).not.toHaveBeenCalled();
      });

      it("pre-check looks up including soft-deleted rows (PK still taken)", async () => {
        taskRepo.findOne.mockResolvedValue(null);
        taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
        await service.create({
          id: UUID,
          name: "t",
          triggerType: "api",
        } as any);
        expect(taskRepo.findOne).toHaveBeenCalledWith({
          where: { id: UUID },
          withDeleted: true,
        });
      });

      it("maps a PG 23505 unique violation from save to ConflictException (TOCTOU)", async () => {
        taskRepo.findOne.mockResolvedValue(null);
        const driverErr = Object.assign(new Error("duplicate key value"), {
          code: "23505",
        });
        taskRepo.save.mockRejectedValue(
          new QueryFailedError("INSERT INTO tasks ...", [], driverErr),
        );
        await expect(
          service.create({ id: UUID, name: "t", triggerType: "api" } as any),
        ).rejects.toThrow(ConflictException);
      });

      it("re-throws non-23505 driver errors unchanged", async () => {
        taskRepo.findOne.mockResolvedValue(null);
        const driverErr = Object.assign(new Error("invalid input syntax"), {
          code: "22P02",
        });
        taskRepo.save.mockRejectedValue(
          new QueryFailedError("INSERT INTO tasks ...", [], driverErr),
        );
        await expect(
          service.create({ id: UUID, name: "t", triggerType: "api" } as any),
        ).rejects.toThrow(QueryFailedError);
      });

      it("creates normally when the id is free", async () => {
        taskRepo.findOne.mockResolvedValue(null);
        taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
        const result: any = await service.create({
          id: UUID,
          name: "t",
          triggerType: "api",
        } as any);
        expect(result.id).toBe(UUID);
        expect(taskRepo.save).toHaveBeenCalled();
      });
    });
  });

  // R6: executor pinning 与 broadcast 互斥——写入边界（create/update 共用
  // normalizeTaskDto）直接 400，不允许产生"既固定又广播"的歧义任务。
  describe("executorId / broadcast mutual exclusion (R6)", () => {
    const PIN_UUID = "550e8400-e29b-41d4-a716-446655440000";

    it("rejects create with executorId + executeMode=broadcast", async () => {
      await expect(
        service.create({
          name: "t",
          triggerType: "api",
          executorId: PIN_UUID,
          executeMode: "broadcast",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("rejects update with executorId + executeMode=broadcast", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
      });
      await expect(
        service.update("1", {
          executorId: PIN_UUID,
          executeMode: "broadcast",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    // R7 (N17): PATCH 合并路径的两条绕过——请求体只带一个键时，互斥的另一半
    // 来自已有实体，normalizeTaskDto 看不到，必须在合并后的实体态兜底。
    it("rejects PATCH adding executorId onto a broadcast task (merged-state)", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        executeMode: "broadcast",
      });
      await expect(
        service.update("1", { executorId: PIN_UUID } as any),
      ).rejects.toThrow(BadRequestException);
      // 消息与 create 路径一致，避免前端/调用方按文案分支时出现两套。
      await expect(
        service.update("1", { executorId: PIN_UUID } as any),
      ).rejects.toThrow(/mutually exclusive/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("rejects PATCH switching a pinned task to broadcast (merged-state)", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        executorId: PIN_UUID,
        executeMode: "single",
      });
      await expect(
        service.update("1", { executeMode: "broadcast" } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.update("1", { executeMode: "broadcast" } as any),
      ).rejects.toThrow(/mutually exclusive/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("accepts PATCH clearing executorId on a broadcast task", async () => {
      // 回归：合并后 executorId 被显式清空（null）时不得误报，broadcast 合法。
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        executorId: PIN_UUID,
        executeMode: "broadcast",
      });
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      const result: any = await service.update("1", {
        executorId: null,
      } as any);
      expect(result.executorId).toBeNull();
      expect(taskRepo.save).toHaveBeenCalled();
    });

    it("accepts executorId with executeMode=single", async () => {
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      const result: any = await service.create({
        name: "t",
        triggerType: "api",
        executorId: PIN_UUID,
        executeMode: "single",
      } as any);
      expect(result.executorId).toBe(PIN_UUID);
    });
  });

  describe("findOne", () => {
    it("returns task when found", async () => {
      const task = { id: "1", name: "test" };
      taskRepo.findOne.mockResolvedValue(task);
      await expect(service.findOne("1")).resolves.toEqual(task);
    });

    it("throws NotFoundException when not found", async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findAll", () => {
    it("returns paginated list", async () => {
      const tasks = [{ id: "1" }, { id: "2" }];
      taskRepo.findAndCount.mockResolvedValue([tasks, 2]);
      const result = await service.findAll({ page: 1, pageSize: 10 });
      expect(result).toHaveProperty("total", 2);
      expect(result.list).toHaveLength(2);
      expect(result.items).toBe(result.list);
    });

    it("passes name ILike filter when name param is provided", async () => {
      taskRepo.findAndCount.mockResolvedValue([
        [{ id: "1", name: "my-job" }],
        1,
      ]);
      await service.findAll({ page: 1, pageSize: 10, name: "job" } as any);
      const callArgs = taskRepo.findAndCount.mock.calls[0][0];
      expect(callArgs.where.name).toEqual(
        expect.objectContaining({ _value: "%job%" }),
      );
    });

    it("passes runtime filter when runtime param is provided", async () => {
      taskRepo.findAndCount.mockResolvedValue([[{ id: "1" }], 1]);
      await service.findAll({
        page: 1,
        pageSize: 10,
        runtime: "python",
      } as any);
      const callArgs = taskRepo.findAndCount.mock.calls[0][0];
      expect(callArgs.where.runtime).toBe("python");
    });

    it("excludes DELETED tasks by default", async () => {
      taskRepo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAll({ page: 1, pageSize: 10 });
      const callArgs = taskRepo.findAndCount.mock.calls[0][0];
      // where.status should be a Not() wrapper, not a plain string
      expect(typeof callArgs.where.status).toBe("object");
    });
  });

  describe("update", () => {
    it("saves updated task and re-schedules active tasks", async () => {
      const task = { id: "1", name: "old", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({
        ...task,
        name: "new",
        status: TaskStatus.ACTIVE,
      });
      await service.update("1", { name: "new" } as any);
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(schedulerService.scheduleOne).toHaveBeenCalled();
    });

    it("stops scheduling for non-active tasks after update", async () => {
      const task = { id: "1", name: "old", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.PAUSED });
      await service.update("1", {} as any);
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
    });

    it("maps timeoutSeconds to timeout on update", async () => {
      const task = {
        id: "1",
        name: "old",
        status: TaskStatus.ACTIVE,
        timeout: 30,
      };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await service.update("1", { timeoutSeconds: 180 } as any);
      expect(taskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 180 }),
      );
      expect(taskRepo.save.mock.calls[0][0]).not.toHaveProperty(
        "timeoutSeconds",
      );
    });

    it("persists DTO configuration fields, snapshots them, then reloads an active schedule", async () => {
      const task = {
        id: "1",
        name: "old",
        status: TaskStatus.ACTIVE,
        timeout: 30,
        glueSource: "old-source",
      };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));

      await service.update("1", {
        name: "new",
        timeoutSeconds: 180,
        glueSource: "new-source",
      } as any);

      expect(taskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "new",
          timeout: 180,
          glueSource: "new-source",
        }),
      );
      expect(versionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "1",
          snapshot: expect.objectContaining({
            name: "new",
            timeout: 180,
            glueSource: "new-source",
          }),
        }),
      );
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(schedulerService.scheduleOne).toHaveBeenCalledWith(task);
    });
  });

  describe("updateGlue", () => {
    it("updates glueSource and saves", async () => {
      const task = { id: "1", glueSource: "old", glueLanguage: "js" };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await service.updateGlue("1", "new-source", "python");
      expect(task.glueSource).toBe("new-source");
      expect(task.glueLanguage).toBe("python");
      expect(taskRepo.save).toHaveBeenCalled();
    });

    it("skips language update when language is not provided", async () => {
      const task = { id: "1", glueSource: "old", glueLanguage: "js" };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await service.updateGlue("1", "new-source");
      expect(task.glueLanguage).toBe("js");
    });

    it("only changes GLUE fields, snapshots them, and does not reload scheduling", async () => {
      const task = {
        id: "1",
        name: "unchanged",
        status: TaskStatus.ACTIVE,
        glueSource: "old",
        glueLanguage: "js",
        timeout: 30,
      };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));

      await (service.updateGlue as any)("1", "new-source", "python", {
        name: "ignored",
        timeout: 180,
      });

      expect(task).toEqual(
        expect.objectContaining({
          name: "unchanged",
          timeout: 30,
          glueSource: "new-source",
          glueLanguage: "python",
        }),
      );
      expect(versionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "1",
          snapshot: expect.objectContaining({
            glueSource: "new-source",
            glueLanguage: "python",
          }),
        }),
      );
      expect(schedulerService.stop).not.toHaveBeenCalled();
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
    });
  });

  describe("pause", () => {
    it("marks task as paused and stops scheduler", async () => {
      const task = { id: "1", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.PAUSED });
      const result = await service.pause("1");
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(result.status).toBe(TaskStatus.PAUSED);
    });

    it("throws if task is already paused", async () => {
      const task = { id: "1", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(task);
      await expect(service.pause("1")).rejects.toThrow(BadRequestException);
      expect(schedulerService.stop).not.toHaveBeenCalled();
    });
  });

  describe("resume", () => {
    it("marks task as active and re-schedules", async () => {
      const task = { id: "1", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.ACTIVE });
      const result = await service.resume("1");
      expect(schedulerService.scheduleOne).toHaveBeenCalled();
      expect(result.status).toBe(TaskStatus.ACTIVE);
    });

    it("throws if task is not paused", async () => {
      const task = { id: "1", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      await expect(service.resume("1")).rejects.toThrow(BadRequestException);
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("soft-deletes task and stops scheduler", async () => {
      const task = { id: "1", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.DELETED });
      const result = await service.remove("1");
      expect(schedulerService.stop).toHaveBeenCalledWith("1");
      expect(result).toEqual({ deleted: true });
    });

    it("writes the TypeORM soft-delete column on removal (DB-001)", async () => {
      const task = { id: "1", status: TaskStatus.ACTIVE };
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockResolvedValue({ ...task, status: TaskStatus.DELETED });
      await service.remove("1");
      // status='deleted'（业务标记）与 deletedAt（@DeleteDateColumn）并存：
      // raw query 依赖 status，TypeORM find 依赖 deletedAt
      expect(taskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: TaskStatus.DELETED }),
      );
      expect(taskRepo.softDelete).toHaveBeenCalledWith("1");
    });
  });

  describe("trigger", () => {
    it("creates execution record and enqueues job", async () => {
      const task = {
        id: "1",
        name: "test",
        params: {},
        maxRetry: 3,
        retryDelay: 5,
        currentVersion: "v1",
        status: TaskStatus.ACTIVE,
      };
      const exec = { id: "exec-1", status: ExecutionStatus.PENDING };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          create: jest.fn().mockReturnValue(exec),
          save: jest.fn().mockResolvedValue(exec),
        }),
      );
      const result = await service.trigger("1", {});
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "exec-1" },
        // N2: enqueue options now always carry a normalized numeric priority
        // CORE-02: delay 带 ±20% 抖动——断言落在 [4000, 6000] 区间
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: expect.any(Number),
          },
          priority: 2,
        },
      );
      const opts = taskQueue.add.mock.calls[0][2];
      expect(opts.backoff.delay).toBeGreaterThanOrEqual(4_000);
      expect(opts.backoff.delay).toBeLessThanOrEqual(6_000);
      expect(Number.isInteger(opts.backoff.delay)).toBe(true);
      expect(result).toEqual(exec);
    });

    it("uses dto.params when provided", async () => {
      const task = {
        id: "1",
        name: "test",
        params: {},
        maxRetry: 3,
        retryDelay: 15,
        currentVersion: "v1",
        status: TaskStatus.ACTIVE,
      };
      const exec = {
        id: "exec-2",
        status: ExecutionStatus.PENDING,
        params: { override: true },
      };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          create: jest.fn().mockReturnValue(exec),
          save: jest.fn().mockResolvedValue(exec),
        }),
      );
      await service.trigger("1", { params: { override: true } });
      expect(taskQueue.add).toHaveBeenCalled();
    });

    it("N2: normalizes a hydrated PG string priority before queue.add", async () => {
      // Real-world shape from round-5 e2e: TypeORM hydrates the PG enum as
      // the string label 'normal'; BullMQ rejects non-integer priorities.
      const task = {
        id: "1",
        name: "test",
        params: {},
        maxRetry: 3,
        retryDelay: 5,
        priority: "normal",
        currentVersion: "v1",
        status: TaskStatus.ACTIVE,
      };
      const exec = { id: "exec-1", status: ExecutionStatus.PENDING };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          create: jest.fn().mockReturnValue(exec),
          save: jest.fn().mockResolvedValue(exec),
        }),
      );

      await service.trigger("1", {});

      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "exec-1" },
        expect.objectContaining({ priority: 2 }),
      );
      expect(
        typeof (taskQueue.add.mock.calls[0][2] as { priority: number })
          .priority,
      ).toBe("number");
    });
  });

  describe("normalizeTaskPriority (N2)", () => {
    it("maps PG string labels case-insensitively to the numeric enum", () => {
      expect(normalizeTaskPriority("low")).toBe(1);
      expect(normalizeTaskPriority("normal")).toBe(2);
      expect(normalizeTaskPriority("NORMAL")).toBe(2);
      expect(normalizeTaskPriority("High")).toBe(3);
      expect(normalizeTaskPriority("critical")).toBe(4);
    });

    it("maps numeric and integer-string shapes to the numeric enum", () => {
      expect(normalizeTaskPriority(1)).toBe(1);
      expect(normalizeTaskPriority(4)).toBe(4);
      expect(normalizeTaskPriority("3")).toBe(3);
    });

    it("falls back to NORMAL(2) for unknown/missing/invalid values", () => {
      expect(normalizeTaskPriority(undefined)).toBe(2);
      expect(normalizeTaskPriority(null)).toBe(2);
      expect(normalizeTaskPriority(0)).toBe(2);
      expect(normalizeTaskPriority(99)).toBe(2);
      expect(normalizeTaskPriority("urgent")).toBe(2);
      expect(normalizeTaskPriority("")).toBe(2);
      expect(normalizeTaskPriority(true)).toBe(2);
      expect(Number.isInteger(normalizeTaskPriority("bogus"))).toBe(true);
    });
  });

  describe("getExecution", () => {
    it("returns execution when found", async () => {
      const exec = { id: "exec-1", status: ExecutionStatus.SUCCESS };
      execRepo.findOne.mockResolvedValue(exec);
      await expect(service.getExecution("exec-1")).resolves.toEqual(exec);
    });

    it("throws NotFoundException when not found", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(service.getExecution("missing")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("constrains a task-scoped lookup by execution and task IDs", async () => {
      const exec = {
        id: "exec-1",
        taskId: "task-1",
        status: ExecutionStatus.SUCCESS,
      };
      execRepo.findOne.mockResolvedValue(exec);

      await expect(service.getExecution("exec-1", "task-1")).resolves.toEqual(
        exec,
      );
      expect(execRepo.findOne).toHaveBeenCalledWith({
        where: { id: "exec-1", taskId: "task-1" },
      });
    });

    it("returns NotFoundException when an execution belongs to another task", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(
        service.getExecution("exec-1", "other-task"),
      ).rejects.toThrow(NotFoundException);
      expect(execRepo.findOne).toHaveBeenCalledWith({
        where: { id: "exec-1", taskId: "other-task" },
      });
    });
  });

  describe("getAllExecutions", () => {
    it("returns paginated executions without filters", async () => {
      const execs = [
        { id: "e1", taskId: "t1", taskName: "Task One" },
        { id: "e2", taskId: "t1", taskName: "Task One" },
      ];
      const qbMock = {
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([execs, 2]),
        getRawAndEntities: jest.fn(),
        getCount: jest.fn(),
      };
      execRepo.createQueryBuilder.mockReturnValue(qbMock as any);
      const result = await service.getAllExecutions({ page: 1, pageSize: 10 });
      expect(result).toHaveProperty("total", 2);
      expect(result.list).toHaveLength(2);
      expect(result.items).toBe(result.list);
      // DB-003: 页查询只执行一次 getManyAndCount（不再 getRawAndEntities/getCount 双份开销）
      expect(qbMock.getManyAndCount).toHaveBeenCalledTimes(1);
      expect(qbMock.getRawAndEntities).not.toHaveBeenCalled();
      expect(qbMock.getCount).not.toHaveBeenCalled();
      // 行已有 taskName 时无 join、无回填查询
      expect(qbMock.leftJoin).not.toHaveBeenCalled();
      expect(taskRepo.find).not.toHaveBeenCalled();
    });

    it("backfills missing taskName with one batched query (DB-003)", async () => {
      const execs = [
        { id: "e1", taskId: "t1", taskName: null },
        { id: "e2", taskId: "t1", taskName: null },
        { id: "e3", taskId: "t2", taskName: "inline-name" },
      ];
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([execs, 3]),
      };
      execRepo.createQueryBuilder.mockReturnValue(qbMock as any);
      taskRepo.find.mockResolvedValue([{ id: "t1", name: "Task One" }]);
      const result = await service.getAllExecutions({ page: 1, pageSize: 10 });
      // 一次批量 IN 查询补齐缺失的 taskName
      expect(taskRepo.find).toHaveBeenCalledTimes(1);
      const findArgs = taskRepo.find.mock.calls[0][0];
      expect(findArgs.select).toEqual(["id", "name"]);
      expect(findArgs.where.id).toEqual(
        expect.objectContaining({ _value: ["t1"] }),
      );
      expect(result.list[0].taskName).toBe("Task One");
      expect(result.list[1].taskName).toBe("Task One");
      // 行自身已有 taskName 的不做回填覆盖
      expect(result.list[2].taskName).toBe("inline-name");
    });

    it("applies status and taskId filters", async () => {
      const qbMock = {
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      execRepo.createQueryBuilder.mockReturnValue(qbMock as any);
      const result = await service.getAllExecutions({
        page: 1,
        pageSize: 10,
        status: "success",
        taskId: "task-1",
      });
      expect(result.total).toBe(0);
      // andWhere should have been called for status and taskId filters
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("status"),
        expect.objectContaining({ status: "success" }),
      );
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("taskId"),
        expect.objectContaining({ taskId: "task-1" }),
      );
    });

    it("applies taskName and executorAddress filters (taskName keeps the join for matching)", async () => {
      const qbMock = {
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      execRepo.createQueryBuilder.mockReturnValue(qbMock as any);
      taskRepo.find.mockResolvedValue([]);

      await service.getAllExecutions({
        page: 1,
        pageSize: 10,
        taskName: "daily",
        executorAddress: "10.0.0.1",
      });

      expect(qbMock.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("taskName"),
        expect.objectContaining({ taskName: "%daily%" }),
      );
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("executorAddress"),
        expect.objectContaining({ executorAddress: "%10.0.0.1%" }),
      );
      // 仅 taskName 过滤需要 join tasks 表
      expect(qbMock.leftJoin).toHaveBeenCalledWith(
        "tasks",
        "t",
        "t.id = e.taskId",
      );
    });
  });

  describe("checkCircularDependency depth limit (TASK-007)", () => {
    /** 构造一条长依赖链：task-i 依赖 task-(i+1)，由 taskRepo.findOne 提供 */
    const setupDeepChain = (depth: number) => {
      taskRepo.findOne.mockImplementation(({ where }: any) => {
        const id = where?.id as string;
        if (!id?.startsWith("task-")) return Promise.resolve(null);
        const n = parseInt(id.slice(5), 10);
        if (Number.isNaN(n)) return Promise.resolve(null);
        return Promise.resolve({
          id,
          dependencies: n < depth ? { dep: `task-${n + 1}` } : {},
        });
      });
    };

    it("accepts a dependency chain within the depth limit", async () => {
      // 链长 63 < 64，不应抛错（模拟 60 层足够验证，避免无谓的findOne次数）
      setupDeepChain(60);
      const dto = {
        // R6 后 create 会先按 id 查重（withDeleted），链 mock 只对
        // "task-*" 返回行——用 UUID 形态的新任务 id 表示"主键未被占用"
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "deep-but-ok",
        dependencies: { dep: "task-1" },
      } as any;
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      taskRepo.create.mockImplementation((t: any) => t);
      await expect(service.create(dto)).resolves.toBeDefined();
    });

    it("rejects an over-deep dependency chain with 'dependency chain too deep'", async () => {
      // 链长 200 >> 64：必须在有限深度截断，防止 N+1 DoS
      setupDeepChain(200);
      const dto = {
        id: "task-0",
        name: "too-deep",
        dependencies: { dep: "task-1" },
      } as any;
      await expect(service.create(dto)).rejects.toThrow(
        "dependency chain too deep",
      );
      // 截断生效：数据库查询次数远小于链长（深度上限 64 + 自检若干）
      expect(taskRepo.findOne.mock.calls.length).toBeLessThan(120);
    });

    it("rejects a wide dependency fan-out exceeding the visited-node cap", async () => {
      // 扇出 100 个互不相同的直接依赖：visited 集合超限即拒绝
      taskRepo.findOne.mockResolvedValue({ id: "x", dependencies: {} });
      const dependencies: Record<string, string> = {};
      for (let i = 0; i < 100; i++) dependencies[`k${i}`] = `dep-task-${i}`;
      const dto = { id: "task-0", name: "too-wide", dependencies } as any;
      await expect(service.create(dto)).rejects.toThrow(
        "dependency chain too deep",
      );
    });

    it("still detects a genuine cycle quickly", async () => {
      taskRepo.findOne.mockImplementation(({ where }: any) => {
        const id = where?.id as string;
        // a -> b -> c -> b（环）
        if (id === "task-b")
          return Promise.resolve({ id, dependencies: { dep: "task-c" } });
        if (id === "task-c")
          return Promise.resolve({ id, dependencies: { dep: "task-b" } });
        return Promise.resolve(null);
      });
      const dto = {
        id: "task-a",
        name: "cycle",
        dependencies: { dep: "task-b" },
      } as any;
      await expect(service.create(dto)).rejects.toThrow("Circular dependency");
    });
  });

  describe("SSE log stream concurrency limits (TASK-008)", () => {
    const flushableExec = { id: "exec-1", status: ExecutionStatus.SUCCESS };

    it("allows up to the per-execution limit and rejects the (N+1)th with 503", async () => {
      execRepo.findOne.mockResolvedValue(flushableExec);

      const releases = [
        service.acquireSseSlot("exec-1"),
        service.acquireSseSlot("exec-1"),
        service.acquireSseSlot("exec-1"),
        service.acquireSseSlot("exec-1"),
      ];
      // 默认单 execution 上限 4：第 5 个必须被拒绝
      expect(() => service.acquireSseSlot("exec-1")).toThrow(
        ServiceUnavailableException,
      );

      // 释放后可再次占用
      releases[0]();
      const again = service.acquireSseSlot("exec-1");
      expect(typeof again).toBe("function");
      releases.slice(1).forEach((r) => r());
      again();
    });

    it("rejects streams beyond the global limit with 503", async () => {
      execRepo.findOne.mockResolvedValue(flushableExec);
      const releases: Array<() => void> = [];
      // 全局上限默认 64：占满 64 个不同 execution 的连接
      for (let i = 0; i < 64; i++) {
        releases.push(service.acquireSseSlot(`exec-${i}`));
      }
      expect(() => service.acquireSseSlot("exec-x")).toThrow(
        ServiceUnavailableException,
      );
      // 释放一个后可再占用
      releases[0]();
      const r = service.acquireSseSlot("exec-x");
      r();
      releases.slice(1).forEach((rel) => rel());
    });

    // 可观测性补齐轮：拒绝计数只在超限抛 503 路径记录，成功占用不计数。
    it("counts rejected streams to autoflow_sse_streams_rejected_total", () => {
      const releases: Array<() => void> = [
        service.acquireSseSlot("exec-cnt"),
        service.acquireSseSlot("exec-cnt"),
        service.acquireSseSlot("exec-cnt"),
        service.acquireSseSlot("exec-cnt"),
      ];
      expect(runtimeCount("autoflow_sse_streams_rejected_total")).toBe(0);
      expect(() => service.acquireSseSlot("exec-cnt")).toThrow(
        ServiceUnavailableException,
      );
      expect(runtimeCount("autoflow_sse_streams_rejected_total")).toBe(1);
      releases.forEach((rel) => rel());
    });

    // BUG-05：活跃流 gauge（瞬时值）——占用/释放两点同步写快照。
    it("tracks autoflow_sse_streams_active/limit gauges across acquire and release", () => {
      resetRuntimeGauges();
      const gauge = (name: string): number =>
        getRuntimeGaugesSnapshot().get(name as never) ?? 0;

      const r1 = service.acquireSseSlot("exec-g1");
      const r2 = service.acquireSseSlot("exec-g2");
      expect(gauge("autoflow_sse_streams_active")).toBe(2);
      expect(gauge("autoflow_sse_streams_limit")).toBe(64);

      r1();
      expect(gauge("autoflow_sse_streams_active")).toBe(1);
      r2();
      expect(gauge("autoflow_sse_streams_active")).toBe(0);
      resetRuntimeGauges();
    });

    it("releases the slot when the stream ends normally", async () => {
      execRepo.findOne.mockResolvedValue(flushableExec);
      const send = jest.fn();
      const done = jest.fn();
      const controller = new AbortController();
      await service.streamExecutionLogs(
        "exec-1",
        send,
        done,
        controller.signal,
      );
      expect(done).toHaveBeenCalled();
      // 终态 flush 后计数应已归零：可再次满额占用
      const releases = [
        service.acquireSseSlot("exec-1"),
        service.acquireSseSlot("exec-1"),
        service.acquireSseSlot("exec-1"),
        service.acquireSseSlot("exec-1"),
      ];
      releases.forEach((r) => r());
      expect(() => service.acquireSseSlot("exec-1")).not.toThrow();
    });

    it("releases the slot when the stream aborts mid-poll", async () => {
      execRepo.findOne.mockResolvedValue({
        id: "exec-1",
        status: ExecutionStatus.RUNNING,
      });
      logLineRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      } as any);
      const send = jest.fn();
      const done = jest.fn();
      const controller = new AbortController();
      const promise = service.streamExecutionLogs(
        "exec-1",
        send,
        done,
        controller.signal,
      );
      controller.abort();
      await promise;
      expect(done).toHaveBeenCalled();
      expect(() => service.acquireSseSlot("exec-1")).not.toThrow();
    });

    it("releases the slot when the stream throws", async () => {
      execRepo.findOne.mockRejectedValue(new Error("db down"));
      const send = jest.fn();
      const done = jest.fn();
      const controller = new AbortController();
      // flush() 内 findOne 抛错 → streamExecutionLogs 向上抛，但 finally 必须释放
      await expect(
        service.streamExecutionLogs("exec-1", send, done, controller.signal),
      ).rejects.toThrow("db down");
      expect(() => service.acquireSseSlot("exec-1")).not.toThrow();
    });
  });

  // QA3: SSE idle keep-alive — nginx proxy_read_timeout (default 60s) reaps
  // a stream that writes nothing for >60s (S3-backed executions stay silent
  // until terminal). The service must emit an SSE comment frame when idle
  // and must NOT emit one while data frames are still flowing.
  describe("SSE idle heartbeat (QA3)", () => {
    const runningExec = { id: "exec-1", status: ExecutionStatus.RUNNING };

    const mockNoLines = () => {
      logLineRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      } as any);
    };

    it("writes one ping after the idle interval, and stops once the connection closes", async () => {
      execRepo.findOne.mockResolvedValue(runningExec);
      mockNoLines();

      // Simulate a long-idle window: the service reads lastWriteAt/start at
      // loop entry (first reads = 0), then every later read reports 20s —
      // past IDLE_PING_INTERVAL (15s).
      const nowSpy = jest
        .spyOn(Date, "now")
        .mockReturnValueOnce(0) // lastWriteAt init
        .mockReturnValueOnce(0) // start
        .mockReturnValue(20_000); // loop + idle-check reads
      const ping = jest.fn();
      const send = jest.fn();
      const done = jest.fn();
      const controller = new AbortController();

      const promise = service.streamExecutionLogs(
        "exec-1",
        send,
        done,
        controller.signal,
        undefined,
        ping,
      );
      // Let one loop iteration (flush → idle ping check → poll sleep) run,
      // then close the connection so the loop exits on the next check.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      controller.abort();
      await promise;

      expect(ping).toHaveBeenCalledTimes(1);
      // The ping resets the idle clock: while the loop kept running (still
      // pre-abort) no second ping fires within the same window.
      expect(ping).not.toHaveBeenCalledTimes(2);
      // After the connection closed, the loop is gone — no further pings fire
      // even though the mocked clock still reports a fully idle stream.
      await new Promise((r) => setTimeout(r, 20));
      expect(ping).toHaveBeenCalledTimes(1);
      // No data frame was ever sent for a line-less stream.
      expect(send).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalled();
      nowSpy.mockRestore();
    });

    it("does not write a ping when new lines keep flowing", async () => {
      execRepo.findOne.mockResolvedValue(runningExec);
      logLineRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([{ lineNumber: 0, content: "line0" }]),
      } as any);

      // Every Date.now() call returns the same value: each write() refreshes
      // lastWriteAt, so elapsed idle time never crosses the 15s threshold.
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      const ping = jest.fn();
      const send = jest.fn();
      const done = jest.fn();
      const controller = new AbortController();

      const promise = service.streamExecutionLogs(
        "exec-1",
        send,
        done,
        controller.signal,
        undefined,
        ping,
      );
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      controller.abort();
      await promise;

      expect(send).toHaveBeenCalled();
      expect(ping).not.toHaveBeenCalled();
      nowSpy.mockRestore();
    });

    it("never pings when no ping sink is provided (backward compatible)", async () => {
      execRepo.findOne.mockResolvedValue(runningExec);
      mockNoLines();
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(20_000);
      const send = jest.fn();
      const done = jest.fn();
      const controller = new AbortController();

      // No 6th argument — legacy callers (and existing specs) keep working.
      const promise = service.streamExecutionLogs(
        "exec-1",
        send,
        done,
        controller.signal,
      );
      await new Promise((r) => setImmediate(r));
      controller.abort();
      await promise;

      expect(send).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalled();
      nowSpy.mockRestore();
    });
  });

  describe("getExecutionLogs", () => {
    it("throws NotFoundException when execution does not exist", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(service.getExecutionLogs("missing-exec")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("returns lines, totalLines and hasMore", async () => {
      execRepo.findOne.mockResolvedValue({ id: "exec-1" });
      logLineRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { lineNumber: 0, content: "line0" },
          { lineNumber: 1, content: "line1" },
        ]),
        getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
      } as any);
      logLineRepo.count.mockResolvedValue(5);
      const result = await service.getExecutionLogs("exec-1", 0);
      expect(result.lines).toEqual(["line0", "line1"]);
      expect(result.totalLines).toBe(5);
      expect(result.hasMore).toBe(true);
    });

    it("hasMore is false when all lines are returned", async () => {
      execRepo.findOne.mockResolvedValue({ id: "exec-1" });
      logLineRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([{ lineNumber: 0, content: "only-line" }]),
        getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
      } as any);
      logLineRepo.count.mockResolvedValue(1);
      const result = await service.getExecutionLogs("exec-1", 0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("rollback", () => {
    it("updates gitCommit and enqueues rollback execution", async () => {
      const task = {
        id: "1",
        name: "test",
        gitCommit: "old-sha",
        params: {},
        maxRetry: 2,
        retryDelay: 7,
        status: TaskStatus.ACTIVE,
      };
      const exec = { id: "rb-exec", status: ExecutionStatus.PENDING };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          save: jest
            .fn()
            .mockResolvedValueOnce(task) // first save: update task.gitCommit
            .mockResolvedValueOnce(exec), // second save: persist execution
          create: jest.fn().mockReturnValue(exec),
        }),
      );
      const result = await service.rollback("1", { gitCommit: "new-sha" });
      expect(result.rolledBackFrom).toBe("old-sha");
      expect(result.rolledBackTo).toBe("new-sha");
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: "rb-exec" },
        // CORE-02: delay 带 ±20% 抖动——断言落在 [5600, 8400] 区间
        {
          attempts: 2,
          backoff: { type: "exponential", delay: expect.any(Number) },
          priority: 2,
        },
      );
      const rollbackOpts = taskQueue.add.mock.calls[0][2];
      expect(rollbackOpts.backoff.delay).toBeGreaterThanOrEqual(5_600);
      expect(rollbackOpts.backoff.delay).toBeLessThanOrEqual(8_400);
    });

    it("re-schedules active task after rollback", async () => {
      const task = {
        id: "1",
        name: "test",
        gitCommit: "old-sha",
        params: {},
        maxRetry: 2,
        retryDelay: 15,
        status: TaskStatus.ACTIVE,
      };

      const exec = { id: "rb-exec" };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          save: jest
            .fn()
            .mockResolvedValueOnce(task)
            .mockResolvedValueOnce(exec),
          create: jest.fn().mockReturnValue(exec),
        }),
      );
      await service.rollback("1", { gitCommit: "new-sha" });
      expect(schedulerService.scheduleOne).toHaveBeenCalled();
    });
  });

  describe("handleCallback", () => {
    it("marks execution as SUCCESS and saves", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.handleCallback([
        { executionId: "e1", status: "success", durationMs: 100 },
      ]);
      expect(exec.status).toBe(ExecutionStatus.SUCCESS);
      expect(result[0].success).toBe(true);
    });

    it("marks execution as FAILED and stores errorMessage", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.handleCallback([
        { executionId: "e1", status: "failed", errorMessage: "OOM" },
      ]);
      expect(exec.status).toBe(ExecutionStatus.FAILED);
      expect((exec as any).errorMessage).toBe("OOM");
      expect((exec as any).failureReason).toBe(ExecutionFailureReason.UNKNOWN);
      expect(result[0].success).toBe(true);
    });

    it("uses explicit callback failureReason when provided", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.handleCallback([
        {
          executionId: "e1",
          status: "failed",
          errorMessage: "executor offline",
          failureReason: ExecutionFailureReason.EXECUTOR_OFFLINE,
        },
      ]);
      expect((exec as any).failureReason).toBe(
        ExecutionFailureReason.EXECUTOR_OFFLINE,
      );
    });

    it("infers timeout callbacks as TIMEOUT status", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.handleCallback([
        {
          executionId: "e1",
          status: "failed",
          errorMessage: "Execution timed out",
        },
      ]);
      expect(exec.status).toBe(ExecutionStatus.TIMEOUT);
      expect((exec as any).failureReason).toBe(ExecutionFailureReason.TIMEOUT);
    });

    it("infers package fetch failures from dependency logs", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.handleCallback([
        {
          executionId: "e1",
          status: "failed",
          logs: "npm install failed: cannot find module",
        },
      ]);
      expect((exec as any).failureReason).toBe(
        ExecutionFailureReason.PACKAGE_FETCH_FAILED,
      );
    });

    it("preserves existing error message when callback only includes logs", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        logs: "",
        errorMessage: "executor dispatch failed",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.handleCallback([
        {
          executionId: "e1",
          status: "failed",
          logs: "Traceback: runtime error",
        },
      ]);
      expect((exec as any).errorMessage).toBe("executor dispatch failed");
      expect((exec as any).failureReason).toBe(
        ExecutionFailureReason.SCRIPT_ERROR,
      );
    });

    it("infers script errors from non-zero exit code", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.handleCallback([
        { executionId: "e1", status: "failed", exitCode: 1 },
      ]);
      expect((exec as any).failureReason).toBe(
        ExecutionFailureReason.SCRIPT_ERROR,
      );
    });

    it("saves log lines when logs are provided", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      logLineRepo.save.mockResolvedValue({});
      await service.handleCallback([
        { executionId: "e1", status: "success", logs: "line0\nline1" },
      ]);
      expect(logLineRepo.save).toHaveBeenCalledTimes(1);
    });

    it("backfills full logs from executor when node-style truncation marker is present", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "exec-1:8002",
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const axios = (await import("axios")).default;
      (axios.get as jest.Mock).mockClear();
      (axios.get as jest.Mock).mockResolvedValue({
        data: { lines: ["full-0", "full-1", "full-2"] },
      });
      await service.handleCallback([
        {
          executionId: "e1",
          status: "success",
          executorAddress: "exec-1:8002",
          logs: "head\n... [logs truncated, original length 50000 chars] ...\ntail",
        },
      ]);
      expect(axios.get).toHaveBeenCalledWith(
        "http://executor:3001/api/logs/e1",
        expect.objectContaining({
          headers: {},
          params: { fromLine: 0, limit: 2000 },
        }),
      );
      expect(logLineRepo.delete).toHaveBeenCalledWith({ executionId: "e1" });
      expect(logLineRepo.create).toHaveBeenCalledWith({
        executionId: "e1",
        lineNumber: 1,
        content: "full-1",
        level: null,
      });
    });

    it("falls back to truncated logs when backfill fails (python-style marker)", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "exec-1:8002",
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const axios = (await import("axios")).default;
      (axios.get as jest.Mock).mockClear();
      (axios.get as jest.Mock).mockRejectedValue(new Error("ECONNREFUSED"));
      await service.handleCallback([
        {
          executionId: "e1",
          status: "failed",
          executorAddress: "exec-1:8002",
          logs: "head\n...[truncated, total 50000 chars]...\ntail",
        },
      ]);
      expect(logLineRepo.create).toHaveBeenCalledWith({
        executionId: "e1",
        lineNumber: 0,
        content: "head",
        level: null,
      });
    });

    it("paginates backfill when executor caps page size (python-style)", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "exec-1:8002",
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const axios = (await import("axios")).default;
      (axios.get as jest.Mock).mockClear();
      (axios.get as jest.Mock)
        .mockResolvedValueOnce({
          data: { lines: ["l0", "l1"], totalLines: 5, hasMore: true },
        })
        .mockResolvedValueOnce({
          data: { lines: ["l2", "l3", "l4"], totalLines: 5, hasMore: false },
        });
      await service.handleCallback([
        {
          executionId: "e1",
          status: "success",
          executorAddress: "exec-1:8002",
          logs: "...[truncated, total 50000 chars]...",
        },
      ]);
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect((axios.get as jest.Mock).mock.calls[0][1].params).toEqual({
        fromLine: 0,
        limit: 2000,
      });
      expect((axios.get as jest.Mock).mock.calls[1][1].params).toEqual({
        fromLine: 2,
        limit: 2000,
      });
      expect(logLineRepo.create).toHaveBeenCalledWith({
        executionId: "e1",
        lineNumber: 4,
        content: "l4",
        level: null,
      });
    });

    it("R4-P1: multi-page backfill appends — every page survives, delete runs once (page 0 only)", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "exec-1:8002",
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const axios = (await import("axios")).default;
      (axios.get as jest.Mock).mockClear();
      // Three pages of 2 lines each (executor caps page size below PAGE_LIMIT)
      (axios.get as jest.Mock)
        .mockResolvedValueOnce({
          data: { lines: ["p0-a", "p0-b"], totalLines: 6, hasMore: true },
        })
        .mockResolvedValueOnce({
          data: { lines: ["p1-a", "p1-b"], totalLines: 6, hasMore: true },
        })
        .mockResolvedValueOnce({
          data: { lines: ["p2-a", "p2-b"], totalLines: 6, hasMore: false },
        });

      await service.handleCallback([
        {
          executionId: "e1",
          status: "success",
          executorAddress: "exec-1:8002",
          logs: "...[truncated, total 50000 chars]...",
        },
      ]);

      expect(axios.get).toHaveBeenCalledTimes(3);
      // Replace semantics only on the FIRST page; pages 1-2 must not delete
      // the rows persisted by earlier pages.
      expect(logLineRepo.delete).toHaveBeenCalledTimes(1);
      expect(logLineRepo.delete).toHaveBeenCalledWith({ executionId: "e1" });
      // All 6 lines persisted exactly once, with absolute line numbers.
      const created = logLineRepo.create.mock.calls.map((c: any) => c[0]);
      expect(created).toEqual([
        { executionId: "e1", lineNumber: 0, content: "p0-a", level: null },
        { executionId: "e1", lineNumber: 1, content: "p0-b", level: null },
        { executionId: "e1", lineNumber: 2, content: "p1-a", level: null },
        { executionId: "e1", lineNumber: 3, content: "p1-b", level: null },
        { executionId: "e1", lineNumber: 4, content: "p2-a", level: null },
        { executionId: "e1", lineNumber: 5, content: "p2-b", level: null },
      ]);
      expect(logLineRepo.save).toHaveBeenCalledTimes(3);
    });

    it("R4-P1: single-page backfill keeps replace semantics (stale rows cleared)", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "exec-1:8002",
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const axios = (await import("axios")).default;
      (axios.get as jest.Mock).mockClear();
      (axios.get as jest.Mock).mockResolvedValue({
        data: { lines: ["only-0", "only-1"], totalLines: 2 },
      });

      await service.handleCallback([
        {
          executionId: "e1",
          status: "success",
          executorAddress: "exec-1:8002",
          logs: "...[truncated, total 50000 chars]...",
        },
      ]);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(logLineRepo.delete).toHaveBeenCalledTimes(1);
      const created = logLineRepo.create.mock.calls.map((c: any) => c[0]);
      expect(created).toEqual([
        { executionId: "e1", lineNumber: 0, content: "only-0", level: null },
        { executionId: "e1", lineNumber: 1, content: "only-1", level: null },
      ]);
    });

    it("does not call the executor for logs without truncation marker", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "exec-1:8002",
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const axios = (await import("axios")).default;
      (axios.get as jest.Mock).mockClear();
      await service.handleCallback([
        {
          executionId: "e1",
          status: "success",
          executorAddress: "exec-1:8002",
          logs: "line0\nline1",
        },
      ]);
      expect(axios.get).not.toHaveBeenCalled();
      expect(logLineRepo.create).toHaveBeenCalledWith({
        executionId: "e1",
        lineNumber: 0,
        content: "line0",
        level: null,
      });
    });

    it("records error for unknown executionId without throwing", async () => {
      execRepo.findOne.mockResolvedValue(null);
      const result = await service.handleCallback([
        { executionId: "ghost", status: "success" },
      ]);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toMatch(/not found/i);
    });

    // 可观测性补齐轮（改动1+2）：handleCallback 的运行时计数埋点
    // （业务结果分类 / 执行结果终态）与回调原始 exitCode 入库溯源。
    describe("runtime metrics & exitCode persistence", () => {
      it("counts winner callback as accepted + execution result by final status", async () => {
        const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
        execRepo.findOne.mockResolvedValue(exec);
        await service.handleCallback([
          { executionId: "e1", status: "success", durationMs: 5 },
        ]);
        expect(
          runtimeCount("autoflow_callback_business_total", {
            result: "accepted",
          }),
        ).toBe(1);
        expect(
          runtimeCount("autoflow_execution_result_total", {
            status: "success",
          }),
        ).toBe(1);
        expect(
          runtimeCount("autoflow_execution_result_total", { status: "failed" }),
        ).toBe(0);
      });

      it("counts timeout terminal status distinctly", async () => {
        const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
        execRepo.findOne.mockResolvedValue(exec);
        await service.handleCallback([
          {
            executionId: "e1",
            status: "failed",
            errorMessage: "Execution timed out",
          },
        ]);
        expect(
          runtimeCount("autoflow_execution_result_total", {
            status: "timeout",
          }),
        ).toBe(1);
      });

      it("counts duplicate callbacks without recording execution results", async () => {
        const exec = { id: "e1", status: ExecutionStatus.SUCCESS, logs: "" };
        execRepo.findOne.mockResolvedValue(exec);
        const result = await service.handleCallback([
          { executionId: "e1", status: "success" },
        ]);
        expect(result[0].success).toBe(true);
        expect(
          runtimeCount("autoflow_callback_business_total", {
            result: "duplicate",
          }),
        ).toBe(1);
        expect(
          runtimeCount("autoflow_callback_business_total", {
            result: "accepted",
          }),
        ).toBe(0);
        expect(
          runtimeCount("autoflow_execution_result_total", {
            status: "success",
          }),
        ).toBe(0);
      });

      it("counts not_found callbacks", async () => {
        execRepo.findOne.mockResolvedValue(null);
        await service.handleCallback([
          { executionId: "ghost", status: "success" },
        ]);
        expect(
          runtimeCount("autoflow_callback_business_total", {
            result: "not_found",
          }),
        ).toBe(1);
      });

      it("splits address mismatch vs missing callback address", async () => {
        const exec = {
          id: "e1",
          status: ExecutionStatus.RUNNING,
          executorAddress: "executor-a:8002",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        await service.handleCallback([
          { executionId: "e1", status: "success", executorAddress: "other:1" },
        ]);
        expect(
          runtimeCount("autoflow_callback_business_total", {
            result: "address_mismatch",
          }),
        ).toBe(1);
        await service.handleCallback([
          { executionId: "e1", status: "success" },
        ]);
        expect(
          runtimeCount("autoflow_callback_business_total", {
            result: "address_mismatch_missing_address",
          }),
        ).toBe(1);
      });

      it("counts error only when the post-transition path throws", async () => {
        const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "x" };
        execRepo.findOne.mockResolvedValue(exec);
        logLineRepo.delete.mockRejectedValue(new Error("db exploded"));
        const result = await service.handleCallback([
          { executionId: "e1", status: "success", logs: "a\nb" },
        ]);
        expect(result[0].success).toBe(false);
        expect(
          runtimeCount("autoflow_callback_business_total", { result: "error" }),
        ).toBe(1);
        // winner 语义不变：终态 UPDATE 已命中 → accepted 与执行结果各计一次
        expect(
          runtimeCount("autoflow_callback_business_total", {
            result: "accepted",
          }),
        ).toBe(1);
        expect(
          runtimeCount("autoflow_execution_result_total", {
            status: "success",
          }),
        ).toBe(1);
      });

      it("persists integer exitCode on the terminal update", async () => {
        const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
        execRepo.findOne.mockResolvedValue(exec);
        await service.handleCallback([
          {
            executionId: "e1",
            status: "failed",
            exitCode: 42,
            errorMessage: "boom",
          },
        ]);
        expect((exec as any).exitCode).toBe(42);
      });

      it("tolerates non-integer exitCode without overwriting stored value", async () => {
        const exec = {
          id: "e1",
          status: ExecutionStatus.RUNNING,
          logs: "",
          exitCode: 7,
        };
        execRepo.findOne.mockResolvedValue(exec);
        const result = await service.handleCallback([
          {
            executionId: "e1",
            status: "failed",
            exitCode: 1.5,
            errorMessage: "boom",
          },
        ]);
        expect(result[0].success).toBe(true);
        expect((exec as any).exitCode).toBe(7);
      });

      it("leaves exitCode untouched when callback omits it", async () => {
        const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
        execRepo.findOne.mockResolvedValue(exec);
        await service.handleCallback([
          { executionId: "e1", status: "success" },
        ]);
        expect("exitCode" in exec).toBe(false);
      });
    });

    describe("dependency fan-out (R4-P0: moved from TaskProcessor to handleCallback)", () => {
      // makeRepo's QB mock: getMany defaults to []. taskRepo.dependencies QB
      // drives triggerDependentTasks' scan AND claimDependencyTrigger's
      // conditional UPDATE; execRepo.find drives checkDependencies;
      // execRepo.createQueryBuilder drives handleCallback's own UPDATE.
      // Also wires the manual-trigger path (this.trigger) used by fan-out.
      const setupDownstream = (
        downstreamTask: Record<string, unknown> | null,
        depExecutions: Array<Record<string, unknown>>,
        claimAffected: number[] = [1],
      ) => {
        // One QB mock serves both the dependencies scan (getMany) and the
        // claim (update/set/where/execute). claimAffected is consumed in
        // order: e.g. [1, 0] models "first concurrent fan-out wins, second
        // loses the short-window DB claim".
        let claimCalls = 0;
        const depQb = {
          where: jest.fn().mockReturnThis(),
          getMany: jest
            .fn()
            .mockResolvedValue(downstreamTask ? [downstreamTask] : []),
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          execute: jest.fn().mockImplementation(async () => {
            const affected =
              claimCalls < claimAffected.length
                ? claimAffected[claimCalls]
                : (claimAffected[claimAffected.length - 1] ?? 0);
            claimCalls += 1;
            return { affected };
          }),
        };
        taskRepo.createQueryBuilder.mockImplementation(() => depQb as any);
        execRepo.find.mockResolvedValue(depExecutions as any);
        if (downstreamTask) {
          taskRepo.findOne.mockResolvedValue(downstreamTask as any);
          dataSource.transaction.mockImplementation((fn: any) =>
            fn({
              create: jest
                .fn()
                .mockReturnValue({ id: "down-exec-1", status: "pending" }),
              save: jest
                .fn()
                .mockResolvedValue({ id: "down-exec-1", status: "pending" }),
            }),
          );
        }
        return depQb;
      };

      it("triggers a dependent task when a SUCCESS callback lands and all deps are satisfied", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.RUNNING,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        setupDownstream(
          { id: "t-downstream", dependencies: { up: "t-upstream" } },
          [{ taskId: "t-upstream", status: ExecutionStatus.SUCCESS }],
        );
        taskQueue.add.mockResolvedValue({});

        const result = await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        expect(result[0].success).toBe(true);
        expect(taskQueue.add).toHaveBeenCalledWith(
          "execute",
          { executionId: expect.any(String) },
          expect.objectContaining({ attempts: expect.any(Number) }),
        );
      });

      it("R4-P3: claims the downstream via a short-window conditional UPDATE on lastTriggerTime before triggering", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.RUNNING,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        const depQb = setupDownstream(
          { id: "t-downstream", dependencies: { up: "t-upstream" } },
          [{ taskId: "t-upstream", status: ExecutionStatus.SUCCESS }],
        );
        taskQueue.add.mockResolvedValue({});

        await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        // The claim ran a conditional UPDATE guarded by the dedup window.
        expect(depQb.update).toHaveBeenCalled();
        expect(depQb.set).toHaveBeenCalledWith(
          expect.objectContaining({ lastTriggerTime: expect.any(Date) }),
        );
        expect(depQb.where).toHaveBeenCalledWith(
          expect.stringContaining('"lastTriggerTime"'),
          expect.objectContaining({ windowStart: expect.any(Date) }),
        );
        expect(taskQueue.add).toHaveBeenCalledTimes(1);
      });

      it("R4-P3: two concurrent SUCCESS callbacks for two upstreams trigger the downstream exactly once", async () => {
        const downstream = {
          id: "t-downstream",
          dependencies: { a: "t-up-a", b: "t-up-b" },
        };
        execRepo.findOne
          .mockResolvedValueOnce({
            id: "e-a",
            status: ExecutionStatus.RUNNING,
            taskId: "t-up-a",
            logs: "",
          })
          .mockResolvedValueOnce({
            id: "e-b",
            status: ExecutionStatus.RUNNING,
            taskId: "t-up-b",
            logs: "",
          });
        // Both fan-outs pass checkDependencies (both upstreams SUCCESS) — the
        // short-window DB claim then serializes them: first wins, second loses.
        setupDownstream(
          downstream,
          [
            { taskId: "t-up-a", status: ExecutionStatus.SUCCESS },
            { taskId: "t-up-b", status: ExecutionStatus.SUCCESS },
          ],
          [1, 0],
        );

        await Promise.all([
          service.handleCallback([{ executionId: "e-a", status: "success" }]),
          service.handleCallback([{ executionId: "e-b", status: "success" }]),
        ]);

        // Exactly ONE downstream execution enqueued across both fan-outs.
        expect(taskQueue.add).toHaveBeenCalledTimes(1);
        expect(taskQueue.add).toHaveBeenCalledWith(
          "execute",
          { executionId: "down-exec-1" },
          expect.objectContaining({ attempts: expect.any(Number) }),
        );
      });

      it("R4-P3: a fan-out that loses the claim skips the downstream trigger without enqueueing", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.RUNNING,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        setupDownstream(
          { id: "t-downstream", dependencies: { up: "t-upstream" } },
          [{ taskId: "t-upstream", status: ExecutionStatus.SUCCESS }],
          [0],
        );

        const result = await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        expect(result[0].success).toBe(true);
        expect(taskQueue.add).not.toHaveBeenCalled();
      });

      it("R4-P3: checkDependencies caps the history scan with take and falls back per-dependency when truncated", async () => {
        const downstream = {
          id: "t-downstream",
          dependencies: { up: "t-upstream" },
        };
        // Main scan returns empty (simulating truncation pushing the latest
        // execution out of the capped window); the per-dependency fallback
        // findOne must rescue the SUCCESS row so the trigger still fires.
        setupDownstream(downstream, []);
        execRepo.findOne
          .mockResolvedValueOnce({
            id: "e-dep",
            status: ExecutionStatus.RUNNING,
            taskId: "t-upstream",
            logs: "",
          })
          .mockResolvedValueOnce({
            taskId: "t-upstream",
            status: ExecutionStatus.SUCCESS,
          });
        taskQueue.add.mockResolvedValue({});

        await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        expect(execRepo.find).toHaveBeenCalledWith(
          expect.objectContaining({
            order: { createdAt: "DESC" },
            take: MAX_DEPENDENCY_EXECUTION_SCAN,
          }),
        );
        expect(taskQueue.add).toHaveBeenCalledTimes(1);
      });

      it("R4-P3: fallback keeps unmet-dep semantics when the truncated dependency is not satisfied", async () => {
        setupDownstream(
          { id: "t-downstream", dependencies: { up: "t-upstream" } },
          [],
        );
        execRepo.findOne
          .mockResolvedValueOnce({
            id: "e-dep",
            status: ExecutionStatus.RUNNING,
            taskId: "t-upstream",
            logs: "",
          })
          .mockResolvedValueOnce({
            taskId: "t-upstream",
            status: ExecutionStatus.FAILED,
          });

        await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        expect(taskQueue.add).not.toHaveBeenCalled();
      });

      it("does not trigger the downstream task when its other dependencies are not yet satisfied", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.RUNNING,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        setupDownstream(
          {
            id: "t-downstream",
            dependencies: { up: "t-upstream", other: "t-other" },
          },
          // latest execution of t-other FAILED → deps unmet
          [
            { taskId: "t-upstream", status: ExecutionStatus.SUCCESS },
            { taskId: "t-other", status: ExecutionStatus.FAILED },
          ],
        );

        await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        expect(taskQueue.add).not.toHaveBeenCalled();
      });

      it("does not trigger dependents on a FAILED callback", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.RUNNING,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        setupDownstream(
          { id: "t-downstream", dependencies: { up: "t-upstream" } },
          [{ taskId: "t-upstream", status: ExecutionStatus.FAILED }],
        );

        await service.handleCallback([
          { executionId: "e-dep", status: "failed" },
        ]);

        expect(taskQueue.add).not.toHaveBeenCalled();
      });

      it("is idempotent: a duplicate (already terminal) success callback must not re-trigger dependents", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.SUCCESS,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        setupDownstream(
          { id: "t-downstream", dependencies: { up: "t-upstream" } },
          [{ taskId: "t-upstream", status: ExecutionStatus.SUCCESS }],
        );

        const result = await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        // makeRepo QB returns affected=0 for already-terminal rows, which is
        // the production duplicate-callback path: no slot release, no fan-out.
        expect(result[0].success).toBe(true);
        expect(releaseSlotExecute).not.toHaveBeenCalled();
        expect(taskQueue.add).not.toHaveBeenCalled();
      });

      it("fan-out errors do not fail the callback result (best-effort)", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.RUNNING,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        taskRepo.createQueryBuilder.mockImplementation(() => {
          throw new Error("dependency scan exploded");
        });

        const result = await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        expect(result[0].success).toBe(true);
      });

      it("fan-out claim failure inside trigger does not fail the callback (best-effort)", async () => {
        const exec = {
          id: "e-dep",
          status: ExecutionStatus.RUNNING,
          taskId: "t-upstream",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        setupDownstream(
          { id: "t-downstream", dependencies: { up: "t-upstream" } },
          [{ taskId: "t-upstream", status: ExecutionStatus.SUCCESS }],
        );
        // Downstream trigger creates the execution, then enqueue fails —
        // trigger() compensates and throws; the callback must stay success.
        taskQueue.add.mockRejectedValue(new Error("redis down"));
        execRepo.update = jest.fn().mockResolvedValue({ affected: 1 });

        const result = await service.handleCallback([
          { executionId: "e-dep", status: "success" },
        ]);

        expect(result[0].success).toBe(true);
      });
    });

    describe("storeLogLines transactionality (R4-P2)", () => {
      const callbackWithLogs = (logs: string) => [
        { executionId: "e1", status: "success" as const, logs },
      ];

      it("wraps delete + chunked inserts in ONE DB transaction (replace mode)", async () => {
        const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
        execRepo.findOne.mockResolvedValue(exec);
        logLineRepo.save.mockResolvedValue({});
        await service.handleCallback(callbackWithLogs("l0\nl1\nl2"));

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        // The delete runs through the transaction manager, not the repo.
        expect(logLineRepo.delete).toHaveBeenCalledWith({ executionId: "e1" });
      });

      it("rolls back on a mid-insert failure so the pre-existing rows survive", async () => {
        const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
        execRepo.findOne.mockResolvedValue(exec);
        // Emulate DB transaction semantics: writes are staged and become
        // visible only at commit; a mid-insert failure aborts the callback
        // so the delete inside the transaction is rolled back too.
        const committed = ["old-0", "old-1"]; // pre-existing rows
        dataSource.transaction.mockImplementation(async (fn: any) => {
          const staged: string[] = [];
          let cleared = false;
          const manager = {
            delete: jest.fn(async () => {
              cleared = true;
            }),
            save: jest.fn(async (_t: unknown, rows: any[]) => {
              if (rows.some((r) => r.content === "boom")) {
                throw new Error("insert failed: connection reset");
              }
              staged.push(...rows.map((r) => r.content));
            }),
          };
          await fn(manager);
          // commit point — only reached when nothing threw
          if (cleared) committed.length = 0;
          committed.push(...staged);
        });

        const result = await service.handleCallback(
          callbackWithLogs("new-0\nboom\nnew-2"),
        );

        expect(result[0].success).toBe(false);
        expect(result[0].error).toMatch(/connection reset/);
        // Rollback: the pre-existing rows are untouched — the in-transaction
        // delete never became visible.
        expect(committed).toEqual(["old-0", "old-1"]);
      });

      it("append mode (backfill page 2+) skips the delete but still commits atomically", async () => {
        const exec = {
          id: "e1",
          status: ExecutionStatus.RUNNING,
          executorAddress: "exec-1:8002",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        const axios = (await import("axios")).default;
        (axios.get as jest.Mock).mockClear();
        (axios.get as jest.Mock)
          .mockResolvedValueOnce({
            data: { lines: ["p0-a", "p0-b"], totalLines: 4, hasMore: true },
          })
          .mockResolvedValueOnce({
            data: { lines: ["p1-a", "p1-b"], totalLines: 4, hasMore: false },
          });
        logLineRepo.save.mockResolvedValue({});

        await service.handleCallback([
          {
            executionId: "e1",
            status: "success",
            executorAddress: "exec-1:8002",
            logs: "...[truncated, total 50000 chars]...",
          },
        ]);

        // Two transactional stores (page 0 replace + page 1 append).
        expect(dataSource.transaction).toHaveBeenCalledTimes(2);
        // Replace delete only inside the first transaction.
        expect(logLineRepo.delete).toHaveBeenCalledTimes(1);
        // All four lines persisted across the two transactions.
        const created = logLineRepo.create.mock.calls.map((c: any) => c[0]);
        expect(created).toEqual([
          { executionId: "e1", lineNumber: 0, content: "p0-a", level: null },
          { executionId: "e1", lineNumber: 1, content: "p0-b", level: null },
          { executionId: "e1", lineNumber: 2, content: "p1-a", level: null },
          { executionId: "e1", lineNumber: 3, content: "p1-b", level: null },
        ]);
      });
    });

    it("rejects callback when executorAddress does not match the execution", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "executor-a:8002",
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);

      const result = await service.handleCallback([
        {
          executionId: "e1",
          status: "success",
          executorAddress: "executor-b:8002",
        },
      ]);

      expect(result[0]).toEqual({
        executionId: "e1",
        success: false,
        error: "Executor address mismatch",
      });
      expect(exec.status).toBe(ExecutionStatus.RUNNING);
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(releaseSlotExecute).not.toHaveBeenCalled();
    });

    // ARCH-21: 执行器回调真实终态发布领域事件（原「改动1」告警直调解耦；
    // 通知语义等价性在 listener spec 断言，此处只验事件发布与主链无感）。
    describe("execution terminal domain events (ARCH-21)", () => {
      it("emits execution.failed on a FAILED callback with full listener payload", async () => {
        const exec = {
          id: "e1",
          taskId: "t1",
          taskName: "nightly-etl",
          status: ExecutionStatus.RUNNING,
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        taskRepo.findOne.mockResolvedValue({
          id: "t1",
          alarmEmail: "ops@example.com",
          alarmChannels: ["email", "slack"],
        });

        const result = await service.handleCallback([
          {
            executionId: "e1",
            status: "failed",
            errorMessage: "Traceback: divide by zero",
          },
        ]);

        expect(result[0].success).toBe(true);
        expect(eventBus.emit).toHaveBeenCalledTimes(1);
        const [event, payload] = eventBus.emit.mock.calls[0];
        expect(event).toBe(DOMAIN_EVENTS.EXECUTION_FAILED);
        expect(payload).toEqual(
          expect.objectContaining({
            executionId: "e1",
            taskId: "t1",
            taskName: "nightly-etl",
            status: "failed",
            // 推断分类与旧告警摘要同源（inferFailureReason：Traceback→script_error）
            failureReason: "script_error",
            errorMessage: "Traceback: divide by zero",
            aiAnalysis: null,
          }),
        );
        expect(typeof payload.finishedAt).toBe("string");
        expect(Number.isFinite(Date.parse(payload.finishedAt))).toBe(true);
        expect(typeof payload.durationMs).toBe("number");
        // 红线：主链不再触达 NotificationService（本 describe 全程无该桩）。
      });

      it("emits execution.failed with status timeout on a TIMEOUT callback", async () => {
        const exec = {
          id: "e1",
          taskId: "t1",
          taskName: "job",
          status: ExecutionStatus.RUNNING,
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        taskRepo.findOne.mockResolvedValue(null);

        await service.handleCallback([
          {
            executionId: "e1",
            status: "failed",
            errorMessage: "Execution timed out",
          },
        ]);

        expect(exec.status).toBe(ExecutionStatus.TIMEOUT);
        expect(eventBus.emit).toHaveBeenCalledTimes(1);
        const [event, payload] = eventBus.emit.mock.calls[0];
        expect(event).toBe(DOMAIN_EVENTS.EXECUTION_FAILED);
        expect(payload.status).toBe("timeout");
        expect(payload.failureReason).toBe("timeout");
      });

      it("emits execution.completed on a SUCCESS callback (and NOT execution.failed)", async () => {
        const exec = {
          id: "e1",
          taskId: "t1",
          taskName: "job",
          status: ExecutionStatus.RUNNING,
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);

        await service.handleCallback([
          { executionId: "e1", status: "success" },
        ]);

        expect(eventBus.emit).toHaveBeenCalledTimes(1);
        const [event, payload] = eventBus.emit.mock.calls[0];
        expect(event).toBe(DOMAIN_EVENTS.EXECUTION_COMPLETED);
        expect(payload.status).toBe("success");
        expect(payload.failureReason).toBeNull();
      });

      it("does NOT emit on a rejected callback (address mismatch / not found) or a duplicate winner", async () => {
        const exec = {
          id: "e1",
          taskId: "t1",
          taskName: "job",
          status: ExecutionStatus.RUNNING,
          executorAddress: "addr-1",
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);

        // 地址不符：UPDATE 前即拒绝——不 emit。
        await service.handleCallback([
          {
            executionId: "e1",
            status: "success",
            executorAddress: "other:9",
          },
        ]);
        expect(eventBus.emit).not.toHaveBeenCalled();

        // 首个 winner 回调：emit 一次。
        await service.handleCallback([
          { executionId: "e1", status: "success", executorAddress: "addr-1" },
        ]);
        expect(eventBus.emit).toHaveBeenCalledTimes(1);

        // 重复回调（行已终态，affected=0 分支）：不再 emit——保证
        // 「每个终态恰好一个事件」与旧「每个失败执行一次告警」不变量一致。
        exec.status = ExecutionStatus.SUCCESS;
        await service.handleCallback([
          { executionId: "e1", status: "success", executorAddress: "addr-1" },
        ]);
        expect(eventBus.emit).toHaveBeenCalledTimes(1);
      });

      // CORE-04: 超时终态落定后的动作兑现——kill_retry re-enqueue /
      // notify_only 显式 no-op / 缺省 kill 无追加动作 / re-enqueue 失败
      // fail-open（终态已落定）。均断言在唯一 winner 分支恰好一次。
      describe("timeout action (CORE-04)", () => {
        const timeoutExec = (extra: Record<string, unknown> = {}) => ({
          id: "e1",
          taskId: "t1",
          taskName: "job",
          status: ExecutionStatus.RUNNING,
          logs: "",
          ...extra,
        });
        const timeoutCb = {
          executionId: "e1",
          status: "failed" as const,
          failureReason: ExecutionFailureReason.TIMEOUT,
          errorMessage: "Task timeout after 60s",
        };

        it("kill_retry: re-enqueues via scheduleRetryAfterRecovery with the timeout_retry trigger", async () => {
          const exec = timeoutExec();
          execRepo.findOne.mockResolvedValue(exec);
          taskRepo.findOne.mockResolvedValue({
            id: "t1",
            name: "job",
            timeoutAction: "kill_retry",
            maxRetry: 3,
          });

          await service.handleCallback([timeoutCb]);

          expect(execRepo.createQueryBuilder).toHaveBeenCalled();
          expect(exec.status).toBe(ExecutionStatus.TIMEOUT);
          expect(
            executorServiceMock.scheduleRetryAfterRecovery,
          ).toHaveBeenCalledTimes(1);
          expect(
            executorServiceMock.scheduleRetryAfterRecovery,
          ).toHaveBeenCalledWith(
            expect.objectContaining({ id: "t1", timeoutAction: "kill_retry" }),
            exec,
            "timeout_retry",
          );
        });

        it("notify_only: no re-enqueue, terminal TIMEOUT preserved, failure event still emitted once", async () => {
          const exec = timeoutExec();
          execRepo.findOne.mockResolvedValue(exec);
          taskRepo.findOne.mockResolvedValue({
            id: "t1",
            name: "job",
            timeoutAction: "notify_only",
          });

          const result = await service.handleCallback([timeoutCb]);

          expect(result[0].success).toBe(true);
          expect(exec.status).toBe(ExecutionStatus.TIMEOUT);
          expect(
            executorServiceMock.scheduleRetryAfterRecovery,
          ).not.toHaveBeenCalled();
          // ARCH-21: 原「失败告警恰好一次」不变量以事件形式保持——
          // execution.failed 在 TIMEOUT 终态 winner 上恰好 emit 一次。
          expect(eventBus.emit).toHaveBeenCalledTimes(1);
          expect(eventBus.emit.mock.calls[0][0]).toBe(
            DOMAIN_EVENTS.EXECUTION_FAILED,
          );
        });

        it("default kill (null action): no re-enqueue (existing behavior)", async () => {
          execRepo.findOne.mockResolvedValue(timeoutExec());
          taskRepo.findOne.mockResolvedValue({
            id: "t1",
            name: "job",
            timeoutAction: null,
          });

          await service.handleCallback([timeoutCb]);

          expect(
            executorServiceMock.scheduleRetryAfterRecovery,
          ).not.toHaveBeenCalled();
        });

        it("kill_retry is fail-open: a throwing re-enqueue still reports callback success", async () => {
          jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
          const exec = timeoutExec();
          execRepo.findOne.mockResolvedValue(exec);
          taskRepo.findOne.mockResolvedValue({
            id: "t1",
            name: "job",
            timeoutAction: "kill_retry",
          });
          executorServiceMock.scheduleRetryAfterRecovery.mockRejectedValue(
            new Error("redis down"),
          );

          const result = await service.handleCallback([timeoutCb]);

          expect(result[0].success).toBe(true);
          expect(exec.status).toBe(ExecutionStatus.TIMEOUT);
        });

        it("duplicate (already terminal) callback does not re-enqueue twice", async () => {
          // 首个 findOne 是读执行行（RUNNING），QB execute 模拟并发回调已写
          // TIMEOUT 终态——重跑一次 handleCallback 前把行置为终态，affected=0
          // 分支提前返回，scheduleRetryAfterRecovery 不得再次触发。
          const exec = timeoutExec();
          execRepo.findOne.mockResolvedValue(exec);
          taskRepo.findOne.mockResolvedValue({
            id: "t1",
            name: "job",
            timeoutAction: "kill_retry",
          });
          await service.handleCallback([timeoutCb]);
          expect(
            executorServiceMock.scheduleRetryAfterRecovery,
          ).toHaveBeenCalledTimes(1);
          // 第二次回调：行已是终态（makeRepo 的 QB execute 对 TERMINAL 状态
          // 返回 affected=0），不得再 re-enqueue。
          exec.status = ExecutionStatus.TIMEOUT;
          await service.handleCallback([timeoutCb]);
          expect(
            executorServiceMock.scheduleRetryAfterRecovery,
          ).toHaveBeenCalledTimes(1);
        });
      });

      // ARCH-21 fail-open 组合证明：
      // ① 总线级（domain-event-bus.service.spec）：监听器抛错/reject → emit
      //    不外抛、其余监听器照常收派发；
      // ② 主链级（本例）：即便 emit 意外抛错（模拟总线故障），handleCallback
      //    结果与终态落库都不受影响（emitTerminalEvent 第二道保险丝）；
      // ③ 通知失败写 NOTIFICATION_FAILED 审计的兜底语义随迁移进
      //    listener 等价 spec（execution-events.listener.spec.ts）断言。
      it("is fail-open: a throwing event bus emit cannot change the callback result", async () => {
        const exec = {
          id: "e1",
          taskId: "t1",
          taskName: "job",
          status: ExecutionStatus.RUNNING,
          logs: "",
        };
        execRepo.findOne.mockResolvedValue(exec);
        taskRepo.findOne.mockResolvedValue(null);
        eventBus.emit.mockImplementation(() => {
          throw new Error("bus exploded");
        });

        const result = await service.handleCallback([
          { executionId: "e1", status: "failed", errorMessage: "boom" },
        ]);

        expect(result[0].success).toBe(true);
        expect(exec.status).toBe(ExecutionStatus.FAILED);
      });
    });

    // 改动3: winner 日志落库失败后，重试回调补写日志的闭环。
    it("persists logs on a retried callback when the first storeLogLines attempt failed (改动3)", async () => {
      const makeExec = () => ({
        id: "e1",
        status: ExecutionStatus.RUNNING,
        logStorage: null,
        logObjectKey: null,
      });
      const exec = makeExec();
      execRepo.findOne.mockResolvedValue(exec);
      // storeLogLines' DB write throws → winner catch returns success:false.
      const realTx = dataSource.transaction;
      dataSource.transaction.mockRejectedValueOnce(new Error("db blip"));

      const first = await service.handleCallback([
        { executionId: "e1", status: "success", logs: "l0\nl1" },
      ]);
      expect(first[0].success).toBe(false);

      // Executor retries the whole batch: execution is already SUCCESS →
      // affected=0 branch. The fresh re-read still shows logs unwritten, so the
      // duplicate-callback path must persist them.
      execRepo.findOne.mockImplementation(async () => makeExec());
      dataSource.transaction = realTx;

      const second = await service.handleCallback([
        { executionId: "e1", status: "success", logs: "l0\nl1" },
      ]);

      expect(second[0].success).toBe(true);
      expect(logLineRepo.create).toHaveBeenCalled();
      expect(logLineRepo.save).toHaveBeenCalled();
    });

    it("does NOT re-persist logs on a duplicate callback once storage pointer exists (改动3 idempotent)", async () => {
      const persisted = () => ({
        id: "e1",
        status: ExecutionStatus.SUCCESS,
        logStorage: "db",
        logObjectKey: null,
      });
      execRepo.findOne.mockResolvedValue(persisted());

      const result = await service.handleCallback([
        { executionId: "e1", status: "success", logs: "l0\nl1" },
      ]);

      expect(result[0].success).toBe(true);
      expect(logLineRepo.save).not.toHaveBeenCalled();
    });

    // 改动4: 快照 executorAddress 为 null、库中实际有地址时仍按库值释放槽位。
    it("releases the slot using the RETURNING executorAddress when the pre-callback snapshot is null (改动4)", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: null,
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      // 模拟 dispatch 已把地址落库、但请求前快照尚未刷新：UPDATE ... RETURNING
      // 返回库中实际地址。
      execRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({
          affected: 1,
          raw: [{ id: "e1", executorAddress: "10.0.0.9:8002" }],
        }),
      } as any);

      const whereArgs: Array<Record<string, unknown>> = [];
      dataSource.createQueryBuilder.mockImplementation(
        () =>
          ({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn((_sql: string, params: Record<string, unknown>) => {
              whereArgs.push(params);
              return {
                execute: jest.fn().mockResolvedValue({ affected: 1 }),
              };
            }),
          }) as any,
      );

      const result = await service.handleCallback([
        { executionId: "e1", status: "success", durationMs: 100 },
      ]);

      expect(result[0].success).toBe(true);
      // 快照为 null，本会 no-op；RETURNING 让释放落到库中实际地址。
      expect(whereArgs).toEqual([{ addr: "10.0.0.9:8002" }]);
    });
  });

  describe("saveVersion", () => {
    it("creates a new version snapshot", async () => {
      const task = { id: "t1", name: "task", gitCommit: "sha1" };
      taskRepo.findOne.mockResolvedValue(task);
      versionRepo.find.mockResolvedValue([]);
      versionRepo.save.mockImplementation((v: any) =>
        Promise.resolve({ id: "v1", ...v }),
      );
      const result = await service.saveVersion("t1", "user", "initial");
      expect(result.version).toBe("v1");
      expect(versionRepo.create).toHaveBeenCalled();
    });

    // W-21: the snapshot must carry requirements, or a version rollback would
    // silently drop the dependency set the rolled-back task needs.
    it("snapshot includes requirements (W-21)", async () => {
      const task = {
        id: "t1",
        name: "task",
        requirements: ["requests>=2.31"],
      };
      taskRepo.findOne.mockResolvedValue(task);
      versionRepo.find.mockResolvedValue([]);
      versionRepo.save.mockImplementation((v: any) =>
        Promise.resolve({ id: "v1", ...v }),
      );
      await service.saveVersion("t1", "user", "with-deps");
      const arg = versionRepo.create.mock.calls[0][0];
      expect(arg.snapshot.requirements).toEqual(["requests>=2.31"]);
    });

    it("throws NotFoundException when task not found", async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.saveVersion("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("rollbackToVersion", () => {
    it("applies version snapshot to task and records the rollback result", async () => {
      const version = {
        id: "v1",
        taskId: "t1",
        version: "v1",
        snapshot: { name: "snapshot-name", timeout: 60 },
      };
      const task = { id: "t1", name: "current", timeout: 30 };
      versionRepo.findOne.mockResolvedValue(version);
      taskRepo.findOne.mockResolvedValue(task);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      const result = await service.rollbackToVersion("t1", "v1");
      expect(result.name).toBe("snapshot-name");
      expect(result.timeout).toBe(60);
      expect(versionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "t1",
          snapshot: expect.objectContaining({
            name: "snapshot-name",
            timeout: 60,
          }),
        }),
      );
    });

    it("throws NotFoundException when version not found", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.rollbackToVersion("t1", "missing-v"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("compareVersions", () => {
    it("returns diff for changed fields only", async () => {
      const v1 = {
        id: "v1",
        taskId: "t1",
        version: "v1",
        snapshot: { name: "old", timeout: 30 },
      };
      const v2 = {
        id: "v2",
        taskId: "t1",
        version: "v2",
        snapshot: { name: "new", timeout: 30 },
      };
      versionRepo.findOne.mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);
      const diff = await service.compareVersions("t1", "v1", "v2");
      expect(diff).toHaveProperty("name");
      expect(diff.name).toEqual({ old: "old", new: "new" });
      expect(diff).not.toHaveProperty("timeout");
    });

    it("returns empty diff when snapshots are identical", async () => {
      const snap = { name: "same", timeout: 60 };
      const v1 = { id: "v1", taskId: "t1", version: "v1", snapshot: snap };
      const v2 = {
        id: "v2",
        taskId: "t1",
        version: "v2",
        snapshot: { ...snap },
      };
      versionRepo.findOne.mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);
      const diff = await service.compareVersions("t1", "v1", "v2");
      expect(Object.keys(diff)).toHaveLength(0);
    });
  });

  describe("getSchedulerStats", () => {
    it("delegates to schedulerService.getStats()", () => {
      schedulerService.getStats.mockReturnValue({ active: 3 });
      expect(service.getSchedulerStats()).toEqual({ active: 3 });
    });
  });

  describe("killExecution", () => {
    it("marks a RUNNING execution as KILLED and saves", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 5000),
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.killExecution("e1");
      expect(exec.status).toBe(ExecutionStatus.KILLED);
      expect((exec as any).failureReason).toBe(ExecutionFailureReason.KILLED);
      expect(exec).toHaveProperty("endTime");
      expect(result.success).toBe(true);
    });

    it("marks a PENDING execution as KILLED", async () => {
      const exec = { id: "e2", status: ExecutionStatus.PENDING };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      const result = await service.killExecution("e2");
      expect(exec.status).toBe(ExecutionStatus.KILLED);
      expect(result.success).toBe(true);
    });

    it("throws NotFoundException when execution does not exist", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(service.killExecution("ghost")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequestException when execution is already in terminal state", async () => {
      const exec = { id: "e3", status: ExecutionStatus.SUCCESS };
      execRepo.findOne.mockResolvedValue(exec);
      await expect(service.killExecution("e3")).rejects.toThrow(
        BadRequestException,
      );
    });

    // 改动5: kill 命中后通知执行器终止进程（best-effort）。
    // P2: HTTP 实现已收敛至 ExecutorService.notifyExecutorKill（scheduler
    // stale sweep 共用），本组用例断言 TaskService 侧的委托与调用点契约；
    // 真实 HTTP 行为（URL/头/超时/吞异常）在 executor.service.spec 覆盖。
    it("delegates the kill notification to ExecutorService after a successful kill (改动5)", async () => {
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "10.0.0.9:8002",
        startTime: new Date(Date.now() - 1000),
      };
      execRepo.findOne.mockResolvedValue(exec);

      const result = await service.killExecution("e1");

      expect(result.success).toBe(true);
      expect(executorServiceMock.notifyExecutorKill).toHaveBeenCalledWith(
        "e1",
        "10.0.0.9:8002",
      );
    });

    it("still returns success and releases the slot when the kill notification fails (改动5 fail-safe)", async () => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      executorServiceMock.notifyExecutorKill.mockRejectedValue(
        new Error("ECONNREFUSED"),
      );
      const exec = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        executorAddress: "10.0.0.9:8002",
        startTime: new Date(Date.now() - 1000),
      };
      execRepo.findOne.mockResolvedValue(exec);

      const result = await service.killExecution("e1");

      expect(result.success).toBe(true);
      // 地址已释放（DB 侧），通知失败不回滚。
      expect(releaseSlotExecute).toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it("skips the kill notification when the executor address is unavailable (改动5)", async () => {
      const exec = { id: "e1", status: ExecutionStatus.RUNNING };
      execRepo.findOne.mockResolvedValue(exec);

      const result = await service.killExecution("e1");

      expect(result.success).toBe(true);
      expect(executorServiceMock.notifyExecutorKill).not.toHaveBeenCalled();
    });
  });

  describe("getExecutionStats", () => {
    it("computes successRate and avgDuration from recent executions", async () => {
      const executions = [
        { status: ExecutionStatus.SUCCESS, duration: 200 },
        { status: ExecutionStatus.SUCCESS, duration: 400 },
        { status: ExecutionStatus.FAILED, duration: null },
      ];
      execRepo.find.mockResolvedValue(executions);
      execRepo.count.mockResolvedValue(10);
      const result = await service.getExecutionStats("t1");
      expect(result.successRate).toBeCloseTo(66.7, 0);
      expect(result.avgDuration).toBe(300);
      expect(result.totalRuns).toBe(10);
    });

    it("returns zero successRate and avgDuration when no recent executions", async () => {
      execRepo.find.mockResolvedValue([]);
      execRepo.count.mockResolvedValue(0);
      const result = await service.getExecutionStats("t1");
      expect(result.successRate).toBe(0);
      expect(result.avgDuration).toBe(0);
    });
  });

  describe("getVersions", () => {
    it("returns versions for a task ordered by createdAt DESC", async () => {
      const versions = [
        { id: "v2", taskId: "t1" },
        { id: "v1", taskId: "t1" },
      ];
      versionRepo.find.mockResolvedValue(versions);
      const result = await service.getVersions("t1");
      expect(result).toEqual(versions);
      expect(versionRepo.find).toHaveBeenCalledWith({
        where: { taskId: "t1" },
        order: { createdAt: "DESC" },
      });
    });
  });

  describe("getVersion", () => {
    it("returns the version when found", async () => {
      const version = { id: "v1", taskId: "t1" };
      versionRepo.findOne.mockResolvedValue(version);
      await expect(service.getVersion("t1", "v1")).resolves.toEqual(version);
    });

    it("throws NotFoundException when version is not found", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.getVersion("t1", "missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("deleteVersion", () => {
    it("deletes a version by id", async () => {
      const version = { id: "v1", taskId: "t1" };
      versionRepo.findOne.mockResolvedValue(version);
      versionRepo.delete.mockResolvedValue({ affected: 1 });
      await service.deleteVersion("t1", "v1");
      expect(versionRepo.delete).toHaveBeenCalledWith("v1");
    });

    it("throws NotFoundException when version does not exist", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.deleteVersion("t1", "ghost")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

// ============================================================================
// OBS-03: 执行日志结构化检索（level 列）
//   - 写入抽取：storeLogLines 为每行推断 level 并落库（推断不到 → null）
//   - 查询过滤：getExecutionLogs 的 level 参数在 SQL 层下推
//   - 分页协调：level 过滤时 totalLines/hasMore 按过滤后行集计算
//   - 兼容：无 level 参数时行为与引入前完全一致
// ============================================================================

/** makeLogQb：构造 getExecutionLogs 可链式 qb mock（含 skip/take） */
function makeLogQb(rows: unknown[]) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
    getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
  } as any;
}

describe("OBS-03: execution log level（写入抽取）", () => {
  let service: TaskService;
  let execRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    resetRuntimeMetrics();
    const taskRepo = makeRepo();
    execRepo = makeRepo();
    logLineRepo = makeRepo();
    const versionRepo = makeRepo();
    const releaseSlotExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const dataSource = {
      transaction: jest.fn(async (fn: any) =>
        fn({
          delete: jest.fn(async (_t: unknown, c: unknown) =>
            logLineRepo.delete(c as any),
          ),
          save: jest.fn(async (_t: unknown, rows: unknown) =>
            logLineRepo.save(rows as any),
          ),
        }),
      ),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: releaseSlotExecute,
      })),
    };

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn(),
          },
        },
        {
          provide: AiService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn(
              (_a: string, p: string) => `http://executor:3001/${p}`,
            ),
            getSharedToken: jest.fn().mockResolvedValue(""),
            notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
            notifyFailure: jest.fn().mockResolvedValue(undefined),
            sendAll: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        // SEC-02: 默认降级明文（key 空）——既有用例语义零变化
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  it("storeLogLines 按行推断 level 落库（括号/无括号/时间戳/未知形态）", async () => {
    const exec = { id: "e1", status: ExecutionStatus.RUNNING, logs: "" };
    execRepo.findOne.mockResolvedValue(exec);
    execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
    await service.handleCallback([
      {
        executionId: "e1",
        status: "success",
        logs: "[ERROR] boom\nplain text\nerror: lower\n2024-01-01 10:00:00 [WARN] careful",
      },
    ]);
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e1",
      lineNumber: 0,
      content: "[ERROR] boom",
      level: "ERROR",
    });
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e1",
      lineNumber: 1,
      content: "plain text",
      level: null,
    });
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e1",
      lineNumber: 2,
      content: "error: lower",
      level: "ERROR",
    });
    expect(logLineRepo.create).toHaveBeenCalledWith({
      executionId: "e1",
      lineNumber: 3,
      content: "2024-01-01 10:00:00 [WARN] careful",
      level: "WARN",
    });
  });
});

describe("OBS-03: getExecutionLogs level 过滤与分页协调", () => {
  let service: TaskService;
  let execRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    resetRuntimeMetrics();
    const taskRepo = makeRepo();
    execRepo = makeRepo();
    logLineRepo = makeRepo();
    const versionRepo = makeRepo();

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(),
            createQueryBuilder: jest.fn(() => ({
              update: jest.fn().mockReturnThis(),
              set: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              execute: jest.fn().mockResolvedValue({ affected: 1 }),
            })),
          },
        },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn(),
          },
        },
        {
          provide: AiService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn(
              (_a: string, p: string) => `http://executor:3001/${p}`,
            ),
            getSharedToken: jest.fn().mockResolvedValue(""),
            notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
            notifyFailure: jest.fn().mockResolvedValue(undefined),
            sendAll: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        // SEC-02: 默认降级明文（key 空）——既有用例语义零变化
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  it("无 level 参数：保持既有行为（行号游标 + 全量 count），不触碰 skip", async () => {
    execRepo.findOne.mockResolvedValue({ id: "exec-1" });
    const qb = makeLogQb([{ lineNumber: 0, content: "line0" }]);
    logLineRepo.createQueryBuilder.mockReturnValue(qb);
    logLineRepo.count.mockResolvedValue(5);

    const result = await service.getExecutionLogs("exec-1", 2, 100);

    expect(qb.andWhere).toHaveBeenCalledWith("l.lineNumber >= :from", {
      from: 2,
    });
    expect(qb.andWhere).not.toHaveBeenCalledWith("l.level = :level", {
      level: expect.anything(),
    });
    expect(qb.skip).not.toHaveBeenCalled();
    expect(logLineRepo.count).toHaveBeenCalledWith({
      where: { executionId: "exec-1" },
    });
    expect(result).toEqual({
      lines: ["line0"],
      totalLines: 5,
      hasMore: true,
    });
  });

  it("level 参数：SQL 层下推等值过滤 + 过滤后偏移量翻页", async () => {
    execRepo.findOne.mockResolvedValue({ id: "exec-1" });
    const qb = makeLogQb([{ lineNumber: 7, content: "[ERROR] boom" }]);
    logLineRepo.createQueryBuilder.mockReturnValue(qb);
    logLineRepo.count.mockResolvedValue(9);

    const result = await service.getExecutionLogs("exec-1", 2, 100, "ERROR");

    expect(qb.andWhere).toHaveBeenCalledWith("l.level = :level", {
      level: "ERROR",
    });
    expect(qb.andWhere).not.toHaveBeenCalledWith("l.lineNumber >= :from", {
      from: expect.anything(),
    });
    // 过滤模式下 fromLine = 过滤后序列的偏移量（skip/OFFSET）
    expect(qb.skip).toHaveBeenCalledWith(2);
    // totalLines 按 level 过滤后计数（分页元数据描述过滤行集）
    expect(logLineRepo.count).toHaveBeenCalledWith({
      where: { executionId: "exec-1", level: "ERROR" },
    });
    expect(result).toEqual({
      lines: ["[ERROR] boom"],
      totalLines: 9,
      hasMore: true, // fromLine(2) + 1 < 9
    });
  });

  it("level 参数：最后一页 hasMore=false 与过滤 totalLines 协调", async () => {
    execRepo.findOne.mockResolvedValue({ id: "exec-1" });
    const qb = makeLogQb([
      { lineNumber: 7, content: "[ERROR] a" },
      { lineNumber: 11, content: "[ERROR] b" },
    ]);
    logLineRepo.createQueryBuilder.mockReturnValue(qb);
    logLineRepo.count.mockResolvedValue(2);

    const result = await service.getExecutionLogs("exec-1", 0, 100, "ERROR");

    expect(result.hasMore).toBe(false); // 0 + 2 < 2 为假
    expect(result.totalLines).toBe(2);
    expect(result.lines).toEqual(["[ERROR] a", "[ERROR] b"]);
  });

  it("level=undefined 与显式 null 等价：都走无过滤路径（编程式调用兜底）", async () => {
    execRepo.findOne.mockResolvedValue({ id: "exec-1" });
    const qb = makeLogQb([]);
    logLineRepo.createQueryBuilder.mockReturnValue(qb);
    logLineRepo.count.mockResolvedValue(3);

    await service.getExecutionLogs("exec-1", 0, 100, null);

    expect(qb.andWhere).toHaveBeenCalledWith("l.lineNumber >= :from", {
      from: 0,
    });
    expect(qb.skip).not.toHaveBeenCalled();
    expect(logLineRepo.count).toHaveBeenCalledWith({
      where: { executionId: "exec-1" },
    });
  });
});

// ============================================================================
// QA-02 第二阶段（branches 冲 75）：task.service 剩余分支定向补测。
// 范围：findAll/getAllExecutions 过滤分支、suggestSchedule 统计分支、
// getExecutionStats 空/满矩阵、update 超时策略归一化、SSE 槽位配置解析、
// saveVersion maxNum 分支、rollback enqueue 失败补偿。
// 全部断言具体行为，无凑数弱断言。
// ============================================================================

describe("TaskService — QA-02 phase 2 branch gaps", () => {
  let service: TaskService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let taskQueue: { add: jest.Mock };
  let dataSource: { transaction: jest.Mock; createQueryBuilder: jest.Mock };
  let aiService: {
    analyzeFailure: jest.Mock;
    chat: jest.Mock;
    suggestSchedule: jest.Mock;
  };

  beforeEach(async () => {
    resetRuntimeMetrics();
    taskRepo = makeRepo();
    execRepo = makeRepo();
    // makeRepo 基础键不含 update——rollback 的 enqueue 失败补偿走 execRepo.update
    execRepo.update = jest.fn().mockResolvedValue({ affected: 1 });
    logLineRepo = makeRepo();
    versionRepo = makeRepo();
    taskQueue = { add: jest.fn().mockResolvedValue({}) };
    const releaseSlotExecute = jest.fn().mockResolvedValue({ affected: 1 });
    dataSource = {
      transaction: jest.fn(async (fn: any) =>
        fn({
          delete: jest.fn(async (_t: unknown, c: unknown) =>
            logLineRepo.delete(c as any),
          ),
          create: jest.fn((d: any) => d),
          save: jest.fn(async (_t: unknown, rows: unknown) =>
            logLineRepo.save(rows as any),
          ),
        }),
      ),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: releaseSlotExecute,
      })),
    };
    aiService = {
      analyzeFailure: jest.fn().mockResolvedValue(""),
      chat: jest.fn().mockResolvedValue(""),
      suggestSchedule: jest.fn().mockResolvedValue({
        suggestedCron: "0 3 * * *",
        reasoning: "AI suggestion",
        fallback: false,
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn(),
            getStats: jest.fn().mockReturnValue({}),
          },
        },
        { provide: AiService, useValue: aiService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("") } },
        {
          provide: ExecutorService,
          useValue: {
            getExecutorUrl: jest.fn(
              (_a: string, p: string) => `http://executor:3001/${p}`,
            ),
            getSharedToken: jest.fn().mockResolvedValue(""),
            notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
            scheduleRetryAfterRecovery: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: DomainEventBus, useValue: { emit: jest.fn() } },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
        { provide: getRepositoryToken(ExecutionReport), useValue: {} },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  describe("findAll — filter matrix", () => {
    it("combines status/name/runtime/applicationId into the where clause", async () => {
      taskRepo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAll({
        status: "active",
        name: "backup",
        runtime: "python",
        applicationId: "app-1",
        page: 2,
        pageSize: 20,
      } as any);
      const arg = taskRepo.findAndCount.mock.calls[0][0];
      expect(arg.where).toEqual({
        status: "active",
        name: expect.anything(), // ILike
        runtime: "python",
        applicationId: "app-1",
      });
      expect(arg.skip).toBe(20);
      expect(arg.take).toBe(20);
    });

    it("omits absent filters from the where clause", async () => {
      taskRepo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAll({ page: 1, pageSize: 10 } as any);
      const arg = taskRepo.findAndCount.mock.calls[0][0];
      expect(Object.keys(arg.where)).toEqual(["status"]);
    });
  });

  describe("getAllExecutions — time-range filters and taskName coalescing", () => {
    const makeQb = (rows: unknown[]) => ({
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
    });

    it("applies startTime/endTime range filters to the query", async () => {
      const qb = makeQb([]);
      execRepo.createQueryBuilder.mockReturnValue(qb as any);
      await service.getAllExecutions({
        page: 1,
        pageSize: 10,
        startTime: "2026-09-01T00:00:00Z",
        endTime: "2026-09-02T00:00:00Z",
      } as any);
      const called = qb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(called).toContain("e.createdAt >= :startTime");
      expect(called).toContain("e.createdAt <= :endTime");
    });

    it("keeps a missing taskName as null when no task row backfills it", async () => {
      const qb = makeQb([{ id: "e1", taskId: "t1", taskName: null }]);
      execRepo.createQueryBuilder.mockReturnValue(qb as any);
      taskRepo.find.mockResolvedValue([]);
      const result = await service.getAllExecutions({
        page: 1,
        pageSize: 10,
      } as any);
      expect(result.list[0].taskName).toBeNull();
      // 回填批量查询确实发起（missingIds 非空分支；In() 包装为 FindOperator）
      expect(taskRepo.find).toHaveBeenCalledTimes(1);
      expect(taskRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ select: ["id", "name"] }),
      );
    });

    it("prefers the row's own taskName over the backfilled map value", async () => {
      const qb = makeQb([{ id: "e1", taskId: "t1", taskName: "Own Name" }]);
      execRepo.createQueryBuilder.mockReturnValue(qb as any);
      const result = await service.getAllExecutions({
        page: 1,
        pageSize: 10,
      } as any);
      expect(result.list[0].taskName).toBe("Own Name");
      expect(taskRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("suggestSchedule — statistics branches", () => {
    it("computes success/failure counts, avg and p95 durations, and best hours", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "t1",
        name: "job",
        cronExpression: "0 1 * * *",
      });
      const mk = (
        status: string,
        duration: number | null,
        createdAt: Date,
      ) => ({ id: `e-${Math.random()}`, status, duration, createdAt });
      execRepo.find.mockResolvedValue([
        mk("success", 100, new Date("2026-09-01T03:10:00Z")),
        mk("success", 300, new Date("2026-09-02T03:20:00Z")),
        mk("failed", 900, new Date("2026-09-03T07:00:00Z")),
        mk("timeout", null, new Date("2026-09-04T07:30:00Z")),
        mk("running", null, new Date("2026-09-05T09:00:00Z")),
      ]);

      await service.suggestSchedule("t1");

      const stats = aiService.suggestSchedule.mock.calls[0][2];
      expect(stats.total).toBe(5);
      expect(stats.successes).toBe(2);
      expect(stats.failures).toBe(2); // failed + timeout
      expect(stats.avgDurationMs).toBe(Math.round((100 + 300 + 900) / 3));
      // p95 over sorted durations [100,300,900] → index floor(3*0.95)=2 → 900
      expect(stats.p95DurationMs).toBe(900);
      expect(stats.bestHoursUtc).toContain(3);
      expect(aiService.suggestSchedule.mock.calls[0][1]).toBe("0 1 * * *");
    });

    it("returns zeroed stats and a fallback cron when the task has no executions", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "t1",
        name: "empty-job",
        cronExpression: null,
      });
      execRepo.find.mockResolvedValue([]);

      await service.suggestSchedule("t1");

      const stats = aiService.suggestSchedule.mock.calls[0][2];
      expect(stats).toEqual({
        total: 0,
        successes: 0,
        failures: 0,
        avgDurationMs: 0,
        p95DurationMs: 0,
        bestHoursUtc: expect.any(Array),
      });
      expect(stats.bestHoursUtc).toHaveLength(3);
      // currentCron null → 透传 null
      expect(aiService.suggestSchedule.mock.calls[0][1]).toBeNull();
    });

    it("throws NotFoundException when the task does not exist", async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.suggestSchedule("ghost")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getExecutionStats — success-rate branches", () => {
    it("reports 0% success rate and avg duration when no recent run succeeded", async () => {
      execRepo.find.mockResolvedValue([
        { id: "e1", status: ExecutionStatus.FAILED, duration: 250 },
        { id: "e2", status: ExecutionStatus.TIMEOUT, duration: 750 },
      ]);
      execRepo.count.mockResolvedValue(4);

      const stats = await service.getExecutionStats("t1");
      expect(stats.totalRuns).toBe(4);
      expect(stats.successRate).toBe(0);
      expect(stats.avgDuration).toBe(500); // round(250+750)/2
    });

    it("reports a partial success rate with one-decimal rounding", async () => {
      execRepo.find.mockResolvedValue([
        { id: "e1", status: ExecutionStatus.SUCCESS, duration: 100 },
        { id: "e2", status: ExecutionStatus.FAILED, duration: null },
        { id: "e3", status: ExecutionStatus.SUCCESS, duration: 300 },
      ]);
      execRepo.count.mockResolvedValue(3);

      const stats = await service.getExecutionStats("t1");
      expect(stats.successRate).toBe(66.7); // round(2/3*1000)/10
      expect(stats.avgDuration).toBe(200);
    });

    it("reports 0% with zero avg when nothing ran", async () => {
      execRepo.find.mockResolvedValue([]);
      execRepo.count.mockResolvedValue(0);

      const stats = await service.getExecutionStats("t1");
      expect(stats.totalRuns).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgDuration).toBe(0);
    });
  });

  describe("update — timeout policy normalization branches (CORE-04 runtime guard)", () => {
    it("maps timeoutSeconds → timeout and normalizes an explicit null timeoutAction", async () => {
      const existing = { id: "t1", name: "job", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(existing);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));

      await service.update("t1", {
        timeoutSeconds: 42,
        timeoutAction: null,
        timeoutWarnRatio: 120 as unknown as number, // 运行态防线：越界归 null
      } as any);

      const saved = taskRepo.save.mock.calls[0][0];
      expect(saved.timeout).toBe(42);
      expect(saved.timeoutSeconds).toBeUndefined();
      expect(saved.timeoutAction).toBeNull();
      expect(saved.timeoutWarnRatio).toBeNull();
    });

    it("keeps a valid timeoutAction untouched and clamps warn ratio inside 0-90", async () => {
      const existing = { id: "t1", name: "job", status: TaskStatus.PAUSED };
      taskRepo.findOne.mockResolvedValue(existing);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));

      await service.update("t1", {
        timeoutAction: "kill_retry",
        timeoutWarnRatio: 75,
      } as any);

      const saved = taskRepo.save.mock.calls[0][0];
      expect(saved.timeoutAction).toBe("kill_retry");
      expect(saved.timeoutWarnRatio).toBe(75);
    });
  });

  describe("SSE slot config getters (TASK-008 runtime parsing)", () => {
    it("accepts a string-form numeric config value for per-execution and global limits", async () => {
      const configGet = jest.fn((key: string) => {
        if (key === "sse.maxStreamsPerExecution") return "2";
        if (key === "sse.maxStreamsGlobal") return "3";
        return "";
      });
      // 重新装配仅改 config 的服务
      const module = await Test.createTestingModule({
        providers: [
          TaskService,
          { provide: getRepositoryToken(Task), useValue: makeRepo() },
          { provide: getRepositoryToken(TaskExecution), useValue: makeRepo() },
          {
            provide: getRepositoryToken(ExecutionLogLine),
            useValue: makeRepo(),
          },
          { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
          { provide: getQueueToken("task-queue"), useValue: taskQueue },
          { provide: DataSource, useValue: dataSource },
          {
            provide: SchedulerService,
            useValue: { stop: jest.fn(), scheduleOne: jest.fn(), getStats: jest.fn() },
          },
          { provide: AiService, useValue: aiService },
          { provide: ConfigService, useValue: { get: configGet } },
          {
            provide: ExecutorService,
            useValue: { getSharedToken: jest.fn().mockResolvedValue("") },
          },
          { provide: DomainEventBus, useValue: { emit: jest.fn() } },
          {
            provide: SecretsCryptoService,
            useValue: new SecretsCryptoService({ get: () => "" } as any),
          },
          { provide: getRepositoryToken(ExecutionReport), useValue: {} },
        ],
      }).compile();
      const svc = module.get(TaskService);

      const r1 = svc.acquireSseSlot("exec-1");
      const r2 = svc.acquireSseSlot("exec-1");
      // "2" 解析成功 → 上限 2：第 3 个 per-execution 拒绝
      expect(() => svc.acquireSseSlot("exec-1")).toThrow(
        ServiceUnavailableException,
      );
      r1();
      r2();
      // 全局上限 3：占满 3 个不同 exec
      const g1 = svc.acquireSseSlot("a");
      const g2 = svc.acquireSseSlot("b");
      const g3 = svc.acquireSseSlot("c");
      expect(() => svc.acquireSseSlot("d")).toThrow(
        ServiceUnavailableException,
      );
      g1();
      g2();
      g3();
    });
  });

  describe("saveVersion / rollback — numbering and compensation branches", () => {
    it("saveVersion uses MAX+1 numbering and starts at v1 for a fresh task", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "t1",
        name: "job",
        description: "d",
      });
      const qb = versionRepo.createQueryBuilder();
      qb.getRawOne.mockResolvedValue({ maxNum: 0 });
      versionRepo.createQueryBuilder.mockReturnValue(qb);
      versionRepo.create.mockImplementation((d: any) => d);
      versionRepo.save.mockImplementation((v: any) => Promise.resolve(v));

      const version = await service.saveVersion("t1", "admin");
      expect(version.version).toBe("v1");
      expect(version.createdBy).toBe("admin");
    });

    it("saveVersion throws NotFoundException when the task is gone", async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.saveVersion("ghost")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("rollback compensates the PENDING row when the queue is down", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "t1",
        name: "job",
        gitCommit: "old",
        status: TaskStatus.ACTIVE,
      });
      // rollback 的事务形态：manager.save(Task, task) → manager.create →
      // manager.save(create 结果) 返回执行行。
      dataSource.transaction.mockImplementation(async (fn: any) =>
        fn({
          save: jest.fn(async (_t: unknown, e: unknown) =>
            (e as { id?: string })?.id ? e : { id: "rb-exec-1", status: "pending" },
          ),
          create: jest
            .fn()
            .mockReturnValue({ id: "rb-exec-1", status: "pending" }),
        }),
      );
      taskQueue.add.mockRejectedValue(new Error("queue down"));

      await expect(
        service.rollback("t1", { gitCommit: "abc123" }),
      ).rejects.toThrow("Failed to enqueue execution: queue down");

      // 补偿：PENDING 行被写为 FAILED（makeRepo 默认 update mock 返回 affected:1）
      expect(execRepo.update).toHaveBeenCalledWith(
        "rb-exec-1",
        expect.objectContaining({ status: ExecutionStatus.FAILED }),
      );
    });
  });

  describe("analyzeExecution / getExecution — lookup branches", () => {
    it("getExecution constrains by taskId when provided", async () => {
      execRepo.findOne.mockResolvedValue(null);
      await expect(
        service.getExecution("exec-1", "task-1"),
      ).rejects.toThrow(NotFoundException);
      expect(execRepo.findOne).toHaveBeenCalledWith({
        where: { id: "exec-1", taskId: "task-1" },
      });
    });

    it("analyzeExecution feeds errorMessage+logs to the AI and persists the analysis", async () => {
      const exec = {
        id: "exec-1",
        taskName: "job",
        errorMessage: "boom",
        logs: "trace",
        aiAnalysis: null as string | null,
      };
      execRepo.findOne.mockResolvedValue(exec);
      aiService.analyzeFailure.mockResolvedValue("AI: fix it");
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      const result = await service.analyzeExecution("exec-1");
      expect(aiService.analyzeFailure).toHaveBeenCalledWith(
        { name: "job", runtime: "unknown" },
        "boom\ntrace",
      );
      expect(result.aiAnalysis).toBe("AI: fix it");
    });

    it("analyzeExecution falls back to a placeholder when no logs exist", async () => {
      const exec = { id: "exec-1", taskName: "job", aiAnalysis: null };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      await service.analyzeExecution("exec-1");
      expect(aiService.analyzeFailure).toHaveBeenCalledWith(
        expect.anything(),
        "(no logs)",
      );
    });
  });
});
