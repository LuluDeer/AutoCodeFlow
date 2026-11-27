import { getMetadataArgsStorage } from "typeorm";
import { TaskService } from "../task.service";
import { Task, TaskStatus, TaskTriggerType } from "../entities/task.entity";

/**
 * TASKCORE 一致性/性能回归（定向单测级：内存替身，不连真 PG）。
 *
 * 覆盖用户可验收路径的四条边：
 *   1. create 缺省 status = PAUSED；
 *   2. 显式 status 优先；
 *   3. task 行与初始 v1 快照同事务，成功双在 / 失败双无；
 *   4. 列表最新执行摘要用 DISTINCT ON，一页 N 个任务最多取 N 行，不读全量历史。
 */

type RepoStub = Record<string, jest.Mock>;

const makeDeps = () => {
  const versionQueryBuilder: RepoStub = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
  };
  return {
    taskRepo: {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d: unknown) => ({ id: "task-1", ...(d as object) })),
      save: jest.fn(async (t: unknown) => t),
    } as RepoStub,
    execRepo: {
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    } as RepoStub,
    logLineRepo: {} as RepoStub,
    versionRepo: {
      createQueryBuilder: jest.fn(() => versionQueryBuilder),
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (v: unknown) => ({ ...(v as object), id: "v-1" })),
    } as RepoStub,
    taskQueue: { add: jest.fn() } as RepoStub,
    dataSource: {} as Record<string, unknown>,
    schedulerService: {
      stop: jest.fn(),
      scheduleOne: jest.fn().mockResolvedValue(undefined),
    } as RepoStub,
    executorService: {} as RepoStub,
    configService: { get: jest.fn() } as RepoStub,
    secretsCrypto: {
      encryptForStorage: jest.fn((v: unknown) => v),
      maskForResponse: jest.fn((t: unknown) => t),
    } as RepoStub,
    aiService: {} as RepoStub,
    aiAnalysisService: {} as RepoStub,
    eventBus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() } as RepoStub,
    tracing: null,
    reportRepo: null,
    projectRepo: null,
    projectAccess: null,
    audit: null,
  };
};

type Deps = ReturnType<typeof makeDeps>;

const makeService = (overrides: Partial<Deps> = {}) => {
  const deps: Deps = { ...makeDeps(), ...overrides };
  const service = new TaskService(
    deps.taskRepo as never,
    deps.execRepo as never,
    deps.logLineRepo as never,
    deps.versionRepo as never,
    deps.taskQueue as never,
    deps.dataSource as never,
    deps.schedulerService as never,
    deps.aiService as never,
    deps.aiAnalysisService as never,
    deps.configService as never,
    deps.executorService as never,
    deps.eventBus as never,
    deps.secretsCrypto as never,
    deps.tracing as never,
    deps.reportRepo as never,
    deps.projectRepo as never,
    deps.projectAccess as never,
    deps.audit as never,
  );
  return { service, deps };
};

const basicDto = () => ({
  name: "taskcore-case",
  triggerType: TaskTriggerType.API,
});

describe("TASKCORE-STATUS-01 创建默认状态", () => {
  it("未传 status：落库与返回均为 PAUSED（不是 DB ACTIVE 默认）", async () => {
    const { service, deps } = makeService();
    const saved = await service.create(basicDto() as never);

    expect(saved.status).toBe(TaskStatus.PAUSED);
    const inserted = deps.taskRepo.save.mock.calls[0][0] as Task;
    expect(inserted.status).toBe(TaskStatus.PAUSED);
  });

  it("显式 status=active：调用方优先，不被默认值覆盖", async () => {
    const { service, deps } = makeService();
    const saved = await service.create({
      ...basicDto(),
      status: TaskStatus.ACTIVE,
    } as never);

    expect(saved.status).toBe(TaskStatus.ACTIVE);
    const inserted = deps.taskRepo.save.mock.calls[0][0] as Task;
    expect(inserted.status).toBe(TaskStatus.ACTIVE);
  });

  it("实体列默认值与 API 缺省同口径（PAUSED）", () => {
    // 直接读 TypeORM 元数据，避免源码字符串断言被注释误导。
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === Task && c.propertyName === "status",
    );
    expect(column?.options.default).toBe(TaskStatus.PAUSED);
  });
});

describe("TASKCORE-TX-01 创建任务与初始快照同事务", () => {
  const makeTxDeps = (failVersion: boolean) => {
    const base = makeDeps();
    let visibleTasks: Array<Record<string, unknown>> = [];
    let visibleVersions: Array<Record<string, unknown>> = [];

    const taskRepo: RepoStub = {
      create: jest.fn((d: unknown) => ({ ...(d as object) })),
      save: jest.fn(async (t: unknown) => {
        const row = { id: "task-tx", ...(t as object) };
        visibleTasks.push(row);
        return row;
      }),
    };
    const versionRepo: RepoStub = {
      createQueryBuilder: base.versionRepo.createQueryBuilder,
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (v: unknown) => {
        if (failVersion) throw new Error("version insert failed");
        const row = { id: "version-v1", ...(v as object) };
        visibleVersions.push(row);
        return row;
      }),
    };
    const dataSource = {
      getRepository: jest.fn(),
      transaction: jest.fn(
        async (fn: (manager: unknown) => Promise<unknown>) => {
          const beforeTasks = [...visibleTasks];
          const beforeVersions = [...visibleVersions];
          try {
            return await fn({
              getRepository: (entity: unknown) =>
                entity === Task ? taskRepo : versionRepo,
            });
          } catch (err) {
            // 模拟 DB 事务回滚：两处可见状态一起恢复到事务前。
            visibleTasks = beforeTasks;
            visibleVersions = beforeVersions;
            throw err;
          }
        },
      ),
    };

    return {
      ...base,
      taskRepo,
      versionRepo,
      dataSource,
      outerTaskRepo: base.taskRepo,
      outerVersionRepo: base.versionRepo,
      getVisible: () => ({
        tasks: visibleTasks,
        versions: visibleVersions,
      }),
    };
  };

  it("成功：task 行与 v1 快照同时在库，且走同一个事务", async () => {
    const deps = makeTxDeps(false);
    const { service } = makeService(deps);
    const result = await service.create(basicDto() as never);

    expect(result.id).toBe("task-tx");
    expect(deps.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(deps.outerTaskRepo.save).not.toHaveBeenCalled(); // 未走事务外仓储
    expect(deps.outerVersionRepo.save).not.toHaveBeenCalled();
    expect(deps.getVisible().tasks).toHaveLength(1);
    expect(deps.getVisible().versions).toHaveLength(1);
    expect(deps.getVisible().versions[0]).toMatchObject({
      taskId: "task-tx",
      version: "v1",
      snapshot: expect.objectContaining({ id: "task-tx" }),
    });
  });

  it("初始快照失败：事务回滚，不留下可见任务（无幽灵任务）", async () => {
    const deps = makeTxDeps(true);
    const { service } = makeService(deps);

    await expect(service.create(basicDto() as never)).rejects.toThrow(
      /version insert failed/,
    );
    expect(deps.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(deps.getVisible().tasks).toHaveLength(0);
    expect(deps.getVisible().versions).toHaveLength(0);
  });
});

describe("PERF-LASTEXEC-01 列表最新执行摘要", () => {
  it("用 DISTINCT ON 每任务只取一条，查询次数/返回行数不随历史执行数放大", async () => {
    const latestRows = [
      {
        id: "exec-latest-1",
        taskId: "t1",
        status: "success",
        startTime: new Date("2026-11-27T10:00:00Z"),
        endTime: new Date("2026-11-27T10:01:00Z"),
        duration: 60,
        createdAt: new Date("2026-11-27T10:01:00Z"),
      },
      {
        id: "exec-latest-2",
        taskId: "t2",
        status: "failed",
        startTime: null,
        endTime: null,
        duration: null,
        createdAt: new Date("2026-11-27T09:00:00Z"),
      },
    ];
    // 模拟每任务 5000 条历史；真实查询由 QB 桩只返回每任务最新 1 条。
    const history = Array.from({ length: 10_000 }, (_, i) => ({
      id: `old-${i}`,
    }));
    expect(history).toHaveLength(10_000);

    const qb: RepoStub = {
      select: jest.fn().mockReturnThis(),
      distinctOn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(latestRows),
    };
    const execRepo: RepoStub = {
      // 老路径一旦被调用即红：列表摘要不得随历史行数线性读取。
      find: jest.fn(() => {
        throw new Error("unbounded execRepo.find called");
      }),
      createQueryBuilder: jest.fn(() => qb),
    };
    const { service } = makeService({ execRepo });

    const list = [{ id: "t1" }, { id: "t2" }] as unknown as Task[];
    await (
      service as unknown as Record<string, any>
    ).attachLastExecutionSummary(list);

    expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(execRepo.find).not.toHaveBeenCalled();
    expect(qb.getMany).toHaveBeenCalledTimes(1);
    expect(qb.distinctOn).toHaveBeenCalledWith(["e.taskId"]);
    expect(qb.where).toHaveBeenCalledWith("e.taskId IN (:...ids)", {
      ids: ["t1", "t2"],
    });
    expect(qb.orderBy).toHaveBeenCalledWith("e.taskId", "ASC");
    expect(qb.addOrderBy).toHaveBeenNthCalledWith(1, "e.createdAt", "DESC");
    expect(qb.addOrderBy).toHaveBeenNthCalledWith(2, "e.id", "DESC");

    const withSummary = list as unknown as Array<
      Task & { lastExecution: { id: string } | null }
    >;
    expect(withSummary[0].lastExecution?.id).toBe("exec-latest-1");
    expect(withSummary[1].lastExecution?.id).toBe("exec-latest-2");
  });
});
