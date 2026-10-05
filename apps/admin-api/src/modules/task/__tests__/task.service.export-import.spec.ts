import { QueryFailedError } from "typeorm";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { TaskService } from "../task.service";
import { UserRole } from "../../users/entities/user.entity";
import { Task, TaskTriggerType } from "../entities/task.entity";
import {
  buildTaskExportPayload,
  TASK_DEFINITION_EXPORT_KEYS,
  TASK_IMPORT_MAX_NAME_CONFLICTS,
  TASK_IMPORT_SECRETS_IGNORED_WARNING,
  TASK_IMPORT_SECRETS_WARNING,
} from "../task-definition.util";
import { ImportTaskDto } from "../dto/task-definition-import.dto";

/**
 * E-1（任务定义导入/导出）：TaskService 层行为。
 *
 * 装配形态对齐 task-owner-guard.spec / task.service.spec 的最小桩
 * （构造器按位注入；未触依赖用 {} / null 占位）。重点回归：
 *   - 导出：脱敏读路径取数 + 白名单装配（secrets 三层防线之两层）；
 *   - 导出键集合与 saveVersion 配置快照键的对账（单事实源，防漂移）；
 *   - 导入：复用 create 链路 + 重名后缀策略（1 次/2 次冲突/耗尽 409）
 *     + secrets 红线（secrets 键绝不进入 create）+ 非成员 403。
 */
describe("TaskService — 任务定义导出/导入（E-1）", () => {
  const makeDeps = () => {
    const versionQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
    };
    return {
      taskRepo: {
        findOne: jest.fn(),
        create: jest.fn((t: unknown) => t),
        save: jest.fn(),
      },
      execRepo: {},
      logLineRepo: {},
      versionRepo: {
        createQueryBuilder: jest.fn(() => versionQueryBuilder),
        create: jest.fn((v: unknown) => v),
        save: jest.fn((v: unknown) =>
          Promise.resolve({ ...(v as object), id: "version-1" }),
        ),
      },
      taskQueue: { add: jest.fn() },
      dataSource: {},
      schedulerService: { stop: jest.fn(), scheduleOne: jest.fn() },
      executorService: {},
      configService: { get: jest.fn() },
      secretsCrypto: {
        encryptForStorage: jest.fn((v: unknown) => v),
        maskForResponse: jest.fn(() => ({ API_TOKEN: "******" })),
      },
      aiService: {},
      aiAnalysisService: {},
      eventBus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
      tracing: null,
      reportRepo: null,
      projectRepo: null,
      projectAccess: null,
      audit: null,
    };
  };

  const makeService = (
    overrides: Partial<ReturnType<typeof makeDeps>> = {},
  ) => {
    const deps = { ...makeDeps(), ...overrides };
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

  const uniqueName23505 = () => {
    const driverErr = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "idx_tasks_name_unique"',
      ),
      { code: "23505", constraint: "idx_tasks_name_unique" },
    );
    return new QueryFailedError("INSERT INTO tasks ...", [], driverErr);
  };

  const importPayload = (task: Record<string, unknown>): ImportTaskDto =>
    ({
      schemaVersion: "1",
      exportedAt: "2026-10-05T00:00:00.000Z",
      task,
    }) as unknown as ImportTaskDto;

  describe("exportDefinition — 导出", () => {
    it("走脱敏读路径取数（maskForResponse），导出物不含 secrets 值/键", async () => {
      const { service, deps } = makeService();
      const rawTask = {
        id: "t-1",
        name: "nightly",
        triggerType: "cron",
        cronExpression: "0 2 * * *",
        // findOne 返回前已脱敏——这里是掩码值（防线第一层）
        secrets: { API_TOKEN: "******" },
        webhookSecret: "envelope-from-db",
      } as unknown as Task;
      deps.taskRepo.findOne.mockResolvedValue(rawTask);

      const { filename, payload } = await service.exportDefinition("t-1");

      expect(deps.taskRepo.findOne).toHaveBeenCalled();
      expect(deps.secretsCrypto.maskForResponse).toHaveBeenCalled();
      expect(filename).toBe("task-nightly.json");
      expect(payload.schemaVersion).toBe("1");
      expect(Number.isNaN(Date.parse(payload.exportedAt))).toBe(false);
      // 键与值 alike：掩码值、webhookSecret 都被白名单整键剔除
      const json = JSON.stringify(payload);
      expect(json).not.toContain("secrets");
      expect(json).not.toContain("API_TOKEN");
      expect(json).not.toContain("******");
      expect(json).not.toContain("webhookSecret");
      expect(payload.task.name).toBe("nightly");
      expect(payload.task.cronExpression).toBe("0 2 * * *");
    });

    it("任务不存在 → NotFoundException（与 GET /tasks/:id 同语义）", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.findOne.mockResolvedValue(null);
      await expect(service.exportDefinition("missing")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("对账：导出键集合 = saveVersion 配置快照键集合 − id（单事实源）", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.save.mockImplementation((t: unknown) => Promise.resolve(t));

      await service.saveVersion("t-1", undefined, undefined, {
        id: "t-1",
        name: "x",
      } as unknown as Task);
      const created = deps.versionRepo.create.mock.calls[
        deps.versionRepo.create.mock.calls.length - 1
      ]?.[0] as {
        snapshot: Record<string, unknown>;
      };
      const snapshotKeys = Object.keys(created.snapshot).filter(
        (k) => k !== "id",
      );

      expect(snapshotKeys.sort()).toEqual(
        [...TASK_DEFINITION_EXPORT_KEYS].sort(),
      );
      // 快照本体仍含 id（回滚链路需要），导出端剔除
      expect(Object.keys(created.snapshot)).toContain("id");
      // 白名单自身无重复键
      expect(new Set(TASK_DEFINITION_EXPORT_KEYS).size).toBe(
        TASK_DEFINITION_EXPORT_KEYS.length,
      );
    });
  });

  describe("importDefinition — 导入", () => {
    const baseTask = {
      name: "nightly",
      triggerType: TaskTriggerType.MANUAL,
      params: { db: "primary" },
      glueSource: "print('hello')",
      glueLanguage: "python",
    };

    it("复用 create 链路创建，返回新 taskId + secrets 重配 warnings", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.save.mockImplementation((t: unknown) =>
        Promise.resolve({ id: "new-1", ...(t as object) }),
      );

      const result = await service.importDefinition(importPayload(baseTask), {
        id: 7,
      });

      expect(result.taskId).toBe("new-1");
      expect(result.name).toBe("nightly");
      expect(result.warnings).toEqual([TASK_IMPORT_SECRETS_WARNING]);
      // 映射后的 DTO 逐字进入 create（服务层 normalize 之前的入参）
      expect(deps.taskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "nightly",
          triggerType: "manual",
          params: { db: "primary" },
          glueSource: "print('hello')",
          glueLanguage: "python",
          ownerUserId: 7,
        }),
      );
    });

    it("SEC-02 红线：导入物携带的 secrets 键被忽略，create 收到的 DTO 无 secrets", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.save.mockImplementation((t: unknown) =>
        Promise.resolve({ id: "new-2", ...(t as object) }),
      );

      const result = await service.importDefinition(
        importPayload({ ...baseTask, secrets: { API_TOKEN: "sk-live-abc" } }),
        { id: 7 },
      );

      const createdDto = deps.taskRepo.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      // create 链路恒写 secrets 槽位（encryptForStorage(normalized.secrets)），
      // 但导入映射不携带 secrets ⇒ 槽位为 undefined（无任何凭据材料），
      // 且明文绝不进入 DTO。
      expect(createdDto["secrets"]).toBeUndefined();
      expect(JSON.stringify(createdDto)).not.toContain("sk-live-abc");
      expect(deps.secretsCrypto.encryptForStorage).toHaveBeenCalledWith(
        undefined,
      );
      expect(result.warnings).toContain(TASK_IMPORT_SECRETS_WARNING);
      expect(result.warnings).toContain(TASK_IMPORT_SECRETS_IGNORED_WARNING);
    });

    it("重名 1 次冲突 → 追加 (imported) 后缀重试成功", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.save
        .mockRejectedValueOnce(uniqueName23505())
        .mockImplementation((t: unknown) => Promise.resolve(t));

      const result = await service.importDefinition(importPayload(baseTask), {
        id: 7,
      });

      expect(result.name).toBe("nightly (imported)");
      const names = deps.taskRepo.create.mock.calls.map(
        (c) => (c[0] as { name: string }).name,
      );
      expect(names).toEqual(["nightly", "nightly (imported)"]);
    });

    it("重名 2 次冲突 → (imported) 仍冲突则追加序号 2", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.save
        .mockRejectedValueOnce(uniqueName23505())
        .mockRejectedValueOnce(uniqueName23505())
        .mockImplementation((t: unknown) => Promise.resolve(t));

      const result = await service.importDefinition(importPayload(baseTask), {
        id: 7,
      });

      expect(result.name).toBe("nightly (imported) 2");
      const names = deps.taskRepo.create.mock.calls.map(
        (c) => (c[0] as { name: string }).name,
      );
      expect(names).toEqual([
        "nightly",
        "nightly (imported)",
        "nightly (imported) 2",
      ]);
    });

    it("全部候选名冲突（耗尽重试上限）→ 409，绝不覆盖同名任务", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.save.mockRejectedValue(uniqueName23505());

      await expect(
        service.importDefinition(importPayload(baseTask), { id: 7 }),
      ).rejects.toThrow(ConflictException);

      // 1（原名）+ MAX（后缀候选）次尝试，全部是 create（新建），无 update/save 覆盖
      expect(deps.taskRepo.create).toHaveBeenCalledTimes(
        TASK_IMPORT_MAX_NAME_CONFLICTS + 1,
      );
    });

    it("非成员给导入物指定 projectId → assertCanAssignProject 403（沿用创建权限语义）", async () => {
      const { service, deps } = makeService({
        projectRepo: {
          findOne: jest.fn().mockResolvedValue({ id: "p-1" }),
        } as never,
      });

      await expect(
        service.importDefinition(
          importPayload({ ...baseTask, projectId: "p-1" }),
          { id: 7, role: UserRole.USER },
        ),
      ).rejects.toThrow(ForbiddenException);
      // 存在性校验已过（项目存在），拒绝来自授权段（projectAccess 缺席 → 仅 ADMIN）
      expect(deps.taskRepo.create).not.toHaveBeenCalled();
    });

    it("非法导入物（缺 name）在映射层 fail-closed 400，不触 create", async () => {
      const { service, deps } = makeService();

      await expect(
        service.importDefinition(importPayload({ triggerType: "manual" }), {
          id: 7,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(deps.taskRepo.create).not.toHaveBeenCalled();
    });

    it("create 的非重名失败（如项目不存在 400）原样透传，不重试", async () => {
      const { service, deps } = makeService({
        projectRepo: {
          findOne: jest.fn().mockResolvedValue(null),
        } as never,
      });

      await expect(
        service.importDefinition(
          importPayload({ ...baseTask, projectId: "p-missing" }),
          { id: 7, role: UserRole.ADMIN },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(deps.taskRepo.create).not.toHaveBeenCalled();
    });

    it("导出 → 导入 round-trip：导出物导入后定义键逐字一致", async () => {
      const { service, deps } = makeService();
      deps.taskRepo.save.mockImplementation((t: unknown) => Promise.resolve(t));
      const task = {
        id: "t-1",
        name: "roundtrip",
        triggerType: "cron",
        cronExpression: "*/10 * * * *",
        runtime: "python",
        runtimeVersion: "3.12",
        requirements: ["rich==13.7.1"],
        timeout: 120,
        maxRetry: 5,
        params: { a: 1 },
        maintenanceWindows: [{ start: "0 1 * * *", end: "0 2 * * *" }],
        runbook: "rb",
        secrets: { K: "v" },
      } as unknown as Task;
      const payload = buildTaskExportPayload(task);

      const result = await service.importDefinition(
        { ...payload } as unknown as ImportTaskDto,
        { id: 7 },
      );

      expect(result.name).toBe("roundtrip");
      const createdDto = deps.taskRepo.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(payload.task)) {
        expect(createdDto[key]).toEqual(value);
      }
    });
  });
});
