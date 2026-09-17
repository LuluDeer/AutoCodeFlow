import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TaskService } from "../task.service";
import {
  Task,
  TaskStatus,
  TaskRuntime,
  TaskCodeSource,
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
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { ExecutorService } from "../../executor/executor.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { ExecutionReport } from "../../metrics/entities/execution-report.entity";
import { resetRuntimeMetrics } from "../../metrics/runtime-metrics-entry";
import { Application } from "../../application/entities/application.entity";

// SEC-SSRF-01: create/update 的 git 源写面守卫会真的做 DNS 解析并拒绝
// example.com（CI/沙箱内解析到受限网段）——与 task.service.spec 同款做法
// stub 掉守卫。守卫本身的语义由 ssrf-deny-matrix.spec / safe-http.util.spec
// 覆盖；本 spec 关心的是**代码来源互斥**，不是 URL 安全性。
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeGitRepoUrl: jest
    .fn()
    .mockResolvedValue(new URL("https://fixture.example/r.git")),
}));

/**
 * python_task_multiversion（WS1）：任务写面的多版本字段校验 + 分因兜底分类。
 *
 * 本 spec 钉住 CONTRACT.md 的**写面**契约：
 * - §1.1 / AC-06b：`runtimeVersion` 格式 + 区间 + runtime 一致性（不做缓存预检，
 *   AC-06c）；
 * - §2.1 / FR-18 / AC-17b：`codeSource` 三选一互斥（含 PATCH 合并终态）；
 * - §2.1 / FR-19 / AC-19a：zip 来源与 `Application.runtime` 的一致性；
 * - §2.5 / D14：`interpreter_unavailable` 的兜底分因（表格驱动，含负例）。
 *
 * 装配刻意**最小**：只为 TaskService 提供它真正读到的依赖，DataSource 桩同时
 * 承载 `transaction`（既有用例路径）与 `getRepository`（FR-19 新增路径）。
 */
describe("python_task_multiversion 写面契约", () => {
  const APP_ID = "11111111-2222-4333-8444-555555555555";

  /**
   * 仓储桩：与 task.service.spec 的主 harness 同口径——`createQueryBuilder`
   * 必须模拟 `transitionToTerminal` 的「条件 UPDATE ... RETURNING」语义，
   * 否则 handleCallback 会在终态跃迁处抛错并被 catch 成 success:false，
   * 断言拿到的仍是 RUNNING 行（假绿/假红都会发生）。
   */
  const makeRepo = () => {
    const repo: Record<string, jest.Mock> = {
      create: jest.fn((d: any) => d),
      save: jest.fn((e: any) => Promise.resolve(e)),
      findOne: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo.createQueryBuilder = jest.fn(() => {
      let patch: Record<string, unknown> | null = null;
      // 快照「最近一次 findOne 的结果」——条件 UPDATE 只应作用于本用例的实体。
      const target = repo.findOne.mock.results.length
        ? repo.findOne.mock.results[repo.findOne.mock.results.length - 1].value
        : null;
      const qb: Record<string, jest.Mock> = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
        update: jest.fn().mockReturnThis(),
        set: jest.fn((p: Record<string, unknown>) => {
          patch = p;
          return qb;
        }),
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
    return repo;
  };

  let service: TaskService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let appRepo: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };

  beforeEach(async () => {
    resetRuntimeMetrics();
    taskRepo = makeRepo();
    execRepo = makeRepo();
    versionRepo = makeRepo();
    appRepo = { findOne: jest.fn() };
    dataSource = {
      transaction: jest.fn(async (fn: any) =>
        fn({
          save: jest.fn(async (...args: any[]) =>
            args.length >= 2 ? args[1] : args[0],
          ),
          create: jest.fn().mockReturnValue({ id: "rb-exec" }),
        }),
      ),
      // FR-19 / AC-19a：zip 来源的 runtime 一致性校验经 dataSource 读
      // applications 行（刻意不走 @InjectRepository——避免 TaskModule ↔
      // ApplicationModule 的模块环，先例 scheduler.service.ts:726）。
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Application) return appRepo;
        return makeRepo();
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: makeRepo(),
        },
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SchedulerService,
          useValue: {
            stop: jest.fn(),
            scheduleOne: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AiService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn(), chat: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        { provide: ExecutorService, useValue: {} },
        {
          provide: DomainEventBus,
          useValue: {
            emit: jest.fn(),
            on: jest.fn(),
            off: jest.fn(),
            listenerCount: jest.fn().mockReturnValue(0),
          },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
        { provide: getRepositoryToken(ExecutionReport), useValue: {} },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  // ==========================================================================
  // FR-06 / AC-06b / AC-06c：runtimeVersion 写面校验
  // ==========================================================================
  describe("runtimeVersion 写面校验（FR-06 / AC-06b / AC-06c）", () => {
    it.each(["3.7", "3.8", "3.12", "3.13", "3.14"])(
      "create 接受区间内版本 %s（runtime=python）",
      async (v) => {
        taskRepo.save.mockImplementation((t: any) =>
          Promise.resolve({ id: "1", ...t }),
        );
        const res: any = await service.create({
          name: "t",
          runtime: TaskRuntime.PYTHON,
          runtimeVersion: v,
        } as any);
        expect(res.runtimeVersion).toBe(v);
      },
    );

    it("create 不传 runtime 时按实体缺省 python 处理（不得误判为非 python）", async () => {
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      await expect(
        service.create({ name: "t", runtimeVersion: "3.12" } as any),
      ).resolves.toMatchObject({ runtimeVersion: "3.12" });
    });

    it.each(["3.6", "3.15", "2.7", "4.0"])(
      "create 拒绝区间外版本 %s（400，不落库）",
      async (v) => {
        await expect(
          service.create({
            name: "t",
            runtime: TaskRuntime.PYTHON,
            runtimeVersion: v,
          } as any),
        ).rejects.toThrow(BadRequestException);
        expect(taskRepo.save).not.toHaveBeenCalled();
      },
    );

    it.each(["3.7.9", "v3.12", "3", "3.x", "python3.12"])(
      "create 拒绝非法格式 %j（补丁号不得声明——D1）",
      async (v) => {
        await expect(
          service.create({
            name: "t",
            runtime: TaskRuntime.PYTHON,
            runtimeVersion: v,
          } as any),
        ).rejects.toThrow(BadRequestException);
        expect(taskRepo.save).not.toHaveBeenCalled();
      },
    );

    it("create 拒绝非 python runtime 声明版本（runtime 一致性）", async () => {
      await expect(
        service.create({
          name: "t",
          runtime: TaskRuntime.NODE,
          runtimeVersion: "3.12",
        } as any),
      ).rejects.toThrow(/only supported for runtime=python/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    // AC-06c 硬要求：写面**不得**预检执行器解释器缓存。3.7 是"可声明但需离线
    // 预填"的版本——若写面预检缓存，声明 3.7 会直接 400，把 AC-06b 的指引路径
    // 彻底堵死。
    it("AC-06c：声明 3.7 可成功落库（写面不做解释器缓存预检）", async () => {
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      await expect(
        service.create({
          name: "t",
          runtime: TaskRuntime.PYTHON,
          runtimeVersion: "3.7",
        } as any),
      ).resolves.toMatchObject({ runtimeVersion: "3.7" });
      expect(taskRepo.save).toHaveBeenCalled();
    });

    it("AC-06b：3.7 的拒绝/提示路径不出现（可声明），但区间外提示含离线预填指引", async () => {
      // 3.7 本身放行；提示文案的"离线预填"分支由 runtime-version.util.spec 覆盖。
      // 此处只钉住写面**没有**把 3.7 当作非法。
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      const res: any = await service.create({
        name: "t",
        runtime: TaskRuntime.PYTHON,
        runtimeVersion: "3.7",
      } as any);
      expect(res.runtimeVersion).toBe("3.7");
    });

    // NFR-05：存量任务（无 runtimeVersion）与显式清空都必须零行为变化。
    it.each([
      ["未携带该键", undefined],
      ["显式 null（清空）", null],
      ["空串（表单清空）", ""],
    ])("NFR-05：runtimeVersion %s 时放行", async (_label, v) => {
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      await expect(
        service.create({
          name: "t",
          runtime: TaskRuntime.PYTHON,
          runtimeVersion: v,
        } as any),
      ).resolves.toBeDefined();
    });

    it("NFR-05：空串即使 runtime=node 也放行（视为未声明，不是非法格式）", async () => {
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
      await expect(
        service.create({
          name: "t",
          runtime: TaskRuntime.NODE,
          runtimeVersion: "",
        } as any),
      ).resolves.toBeDefined();
    });

    // PATCH 合并终态：增量 DTO 看不到旧行的 runtime —— 必须看合并后的实体。
    it("PATCH 合并态：旧行 runtime=node + 只带 runtimeVersion → 400", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        runtime: TaskRuntime.NODE,
      });
      await expect(
        service.update("1", { runtimeVersion: "3.12" } as any),
      ).rejects.toThrow(/only supported for runtime=python/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH 合并态：旧行 runtime=python + 只带 runtimeVersion → 放行", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        runtime: TaskRuntime.PYTHON,
      });
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await expect(
        service.update("1", { runtimeVersion: "3.13" } as any),
      ).resolves.toMatchObject({ runtimeVersion: "3.13" });
    });

    it("PATCH 合并态：同时改 runtime=node 且保留旧 runtimeVersion → 400", async () => {
      // 旧行有版本，本次只改 runtime —— 合并后 (node, 3.12) 非法，必须拦住。
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        runtime: TaskRuntime.PYTHON,
        runtimeVersion: "3.12",
      });
      await expect(
        service.update("1", { runtime: TaskRuntime.NODE } as any),
      ).rejects.toThrow(/only supported for runtime=python/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH 合并态：改 runtime=node 同时清空 runtimeVersion → 放行", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        runtime: TaskRuntime.PYTHON,
        runtimeVersion: "3.12",
      });
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await expect(
        service.update("1", {
          runtime: TaskRuntime.NODE,
          runtimeVersion: null,
        } as any),
      ).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  // FR-18 / AC-17b：codeSource 三选一互斥
  // ==========================================================================
  describe("codeSource 三选一互斥（FR-18 / AC-17b）", () => {
    const saveEcho = () =>
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );

    it.each([
      ["git", { gitRepo: "https://example.com/r.git" }, TaskCodeSource.GIT],
      ["glue", { glueSource: "print(1)" }, TaskCodeSource.GLUE],
      [
        "application_zip",
        { applicationId: APP_ID, codeSource: TaskCodeSource.APPLICATION_ZIP },
        TaskCodeSource.APPLICATION_ZIP,
      ],
    ])("create 接受单一来源 %s", async (_label, dto, expected) => {
      saveEcho();
      if ((dto as any).codeSource === TaskCodeSource.APPLICATION_ZIP) {
        appRepo.findOne.mockResolvedValue({
          id: APP_ID,
          name: "app",
          runtime: "python",
        });
      }
      const res: any = await service.create({
        name: "t",
        runtime: TaskRuntime.PYTHON,
        ...(dto as any),
      } as any);
      if (expected !== TaskCodeSource.APPLICATION_ZIP) {
        // git/glue 由 DTO 省略 codeSource 时读面按非空列推断（NFR-05 零破坏）。
        expect(res).toBeDefined();
      } else {
        expect(res.codeSource).toBe(TaskCodeSource.APPLICATION_ZIP);
      }
    });

    it("create 拒绝 gitRepo + glueSource 并存", async () => {
      await expect(
        service.create({
          name: "t",
          gitRepo: "https://example.com/r.git",
          glueSource: "print(1)",
        } as any),
      ).rejects.toThrow(/exactly one of/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("create 拒绝 gitRepo + codeSource=application_zip", async () => {
      await expect(
        service.create({
          name: "t",
          gitRepo: "https://example.com/r.git",
          applicationId: APP_ID,
          codeSource: TaskCodeSource.APPLICATION_ZIP,
        } as any),
      ).rejects.toThrow(/exactly one of/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("create 拒绝 glueSource + codeSource=application_zip", async () => {
      await expect(
        service.create({
          name: "t",
          glueSource: "print(1)",
          applicationId: APP_ID,
          codeSource: TaskCodeSource.APPLICATION_ZIP,
        } as any),
      ).rejects.toThrow(/exactly one of/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("create 拒绝 codeSource=application_zip 而无 applicationId（自相矛盾声明）", async () => {
      await expect(
        service.create({
          name: "t",
          codeSource: TaskCodeSource.APPLICATION_ZIP,
        } as any),
      ).rejects.toThrow(/requires applicationId/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("create 拒绝 codeSource=git 但无 gitRepo（声明漂移）", async () => {
      await expect(
        service.create({
          name: "t",
          codeSource: TaskCodeSource.GIT,
        } as any),
      ).rejects.toThrow(/inconsistent with the task's code source fields/);
    });

    it("create 拒绝 codeSource=glue 但无 glueSource（声明漂移）", async () => {
      await expect(
        service.create({
          name: "t",
          codeSource: TaskCodeSource.GLUE,
        } as any),
      ).rejects.toThrow(/inconsistent with the task's code source fields/);
    });

    // AC-18b：requirements/PyPI 是**依赖型**渠道，可与任一代码来源并存——
    // 若误把它算进互斥，既有"git + requirements"任务会全部 400。
    it.each([
      ["git", { gitRepo: "https://example.com/r.git" }],
      ["glue", { glueSource: "print(1)" }],
      [
        "application_zip",
        { applicationId: APP_ID, codeSource: TaskCodeSource.APPLICATION_ZIP },
      ],
    ])("AC-18b：requirements 与 %s 来源并存放行", async (label, dto) => {
      saveEcho();
      if (label === "application_zip") {
        appRepo.findOne.mockResolvedValue({
          id: APP_ID,
          name: "app",
          runtime: "python",
        });
      }
      await expect(
        service.create({
          name: "t",
          runtime: TaskRuntime.PYTHON,
          requirements: ["requests==2.31.0"],
          ...(dto as any),
        } as any),
      ).resolves.toBeDefined();
    });

    // NFR-05 / 部署链零破坏：存量"裸 applicationId"（应用部署清单自动注册，
    // application.service 两条路径只传 applicationId，不传 codeSource）
    // **不得**被互斥规则判成 zip 来源，否则应用部署全线 400。
    it("NFR-05：裸 applicationId（无 codeSource）不参与互斥，且不查 applications 表", async () => {
      saveEcho();
      await expect(
        service.create({ name: "t", applicationId: APP_ID } as any),
      ).resolves.toBeDefined();
      expect(appRepo.findOne).not.toHaveBeenCalled();
    });

    it("NFR-05：裸 applicationId + glueSource（部署清单形态）放行", async () => {
      saveEcho();
      await expect(
        service.create({
          name: "t",
          applicationId: APP_ID,
          glueSource: "print(1)",
        } as any),
      ).resolves.toBeDefined();
    });

    it("NFR-05：存量行 codeSource=NULL 且 gitRepo+glueSource 并存时，改 timeout 仍可 PATCH", async () => {
      // 历史脏数据不得因新规则突然无法 PATCH（宽松方向刻意选择）。
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        gitRepo: "https://example.com/r.git",
        glueSource: "print(1)",
        codeSource: null,
      });
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await expect(
        service.update("1", { timeout: 60 } as any),
      ).resolves.toBeDefined();
    });

    it("PATCH 合并态：旧行 gitRepo + 本次带 glueSource → 400", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        gitRepo: "https://example.com/r.git",
        codeSource: TaskCodeSource.GIT,
      });
      await expect(
        service.update("1", { glueSource: "print(1)" } as any),
      ).rejects.toThrow(/exactly one of/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH 合并态：旧行 glueSource + 本次带 gitRepo → 400", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        glueSource: "print(1)",
        codeSource: TaskCodeSource.GLUE,
      });
      await expect(
        service.update("1", { gitRepo: "https://example.com/r.git" } as any),
      ).rejects.toThrow(/exactly one of/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH 合并态：旧行 gitRepo + 本次声明 codeSource=application_zip + applicationId → 400", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        gitRepo: "https://example.com/r.git",
        codeSource: TaskCodeSource.GIT,
      });
      await expect(
        service.update("1", {
          codeSource: TaskCodeSource.APPLICATION_ZIP,
          applicationId: APP_ID,
        } as any),
      ).rejects.toThrow(/exactly one of/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH 合并态：旧行 codeSource=git + 本次显式清空 gitRepo → 400（声明漂移）", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        gitRepo: "https://example.com/r.git",
        codeSource: TaskCodeSource.GIT,
      });
      await expect(
        service.update("1", { gitRepo: null } as any),
      ).rejects.toThrow(/inconsistent with the task's code source fields/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH：合法切换到 glue（同时清 gitRepo + 声明 codeSource）→ 放行", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        gitRepo: "https://example.com/r.git",
        codeSource: TaskCodeSource.GIT,
      });
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      const res: any = await service.update("1", {
        gitRepo: null,
        glueSource: "print(1)",
        codeSource: TaskCodeSource.GLUE,
      } as any);
      expect(res.codeSource).toBe(TaskCodeSource.GLUE);
      expect(res.glueSource).toBe("print(1)");
    });

    // updateGlue 的语义就是"把代码来源切到 glue"——就地收敛而非 400。
    it("updateGlue 就地收敛：声明 codeSource=glue 且清空 gitRepo（FR-18 不变式）", async () => {
      const row: any = {
        id: "1",
        name: "t",
        gitRepo: "https://example.com/r.git",
        glueSource: "old",
        codeSource: TaskCodeSource.GIT,
      };
      taskRepo.findOne.mockResolvedValue(row);
      taskRepo.save.mockImplementation((t: any) => Promise.resolve(t));
      await service.updateGlue("1", "new-source", "python");
      expect(row.codeSource).toBe(TaskCodeSource.GLUE);
      expect(row.gitRepo).toBeNull();
      expect(row.glueSource).toBe("new-source");
    });
  });

  // ==========================================================================
  // FR-19 / AC-19a：zip 来源与 Application.runtime 一致性
  // ==========================================================================
  describe("FR-19 / AC-19a：application_zip 与 Application.runtime 一致", () => {
    const zipDto = (extra: Record<string, unknown> = {}) => ({
      name: "t",
      runtime: TaskRuntime.PYTHON,
      applicationId: APP_ID,
      codeSource: TaskCodeSource.APPLICATION_ZIP,
      ...extra,
    });

    beforeEach(() => {
      taskRepo.save.mockImplementation((t: any) =>
        Promise.resolve({ id: "1", ...t }),
      );
    });

    it("runtime 一致 → 放行", async () => {
      appRepo.findOne.mockResolvedValue({
        id: APP_ID,
        name: "app",
        runtime: "python",
      });
      await expect(service.create(zipDto() as any)).resolves.toBeDefined();
      expect(appRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: APP_ID } }),
      );
    });

    it("runtime 不一致 → 400（明确配置错误，而非运行期莫名失败）", async () => {
      appRepo.findOne.mockResolvedValue({
        id: APP_ID,
        name: "node-app",
        runtime: "node",
      });
      await expect(service.create(zipDto() as any)).rejects.toThrow(
        /inconsistent with task runtime/,
      );
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("runtime 不一致的报错含应用名与两侧 runtime（可运维定位）", async () => {
      appRepo.findOne.mockResolvedValue({
        id: APP_ID,
        name: "node-app",
        runtime: "node",
      });
      await expect(service.create(zipDto() as any)).rejects.toThrow(/node-app/);
      await expect(service.create(zipDto() as any)).rejects.toThrow(/AC-19a/);
    });

    it("create 不传 runtime（缺省 python）与 app.runtime=python → 放行", async () => {
      appRepo.findOne.mockResolvedValue({
        id: APP_ID,
        name: "app",
        runtime: "python",
      });
      const dto = zipDto();
      delete (dto as any).runtime;
      await expect(service.create(dto as any)).resolves.toBeDefined();
    });

    it("引用的 Application 不存在 → 400（弱引用早失败）", async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.create(zipDto() as any)).rejects.toThrow(
        /not found/,
      );
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("PATCH 合并态：旧行 zip 来源 + 本次改 runtime → 用合并态校验", async () => {
      taskRepo.findOne.mockResolvedValue({
        id: "1",
        name: "old",
        status: TaskStatus.PAUSED,
        runtime: TaskRuntime.PYTHON,
        applicationId: APP_ID,
        codeSource: TaskCodeSource.APPLICATION_ZIP,
      });
      appRepo.findOne.mockResolvedValue({
        id: APP_ID,
        name: "app",
        runtime: "python",
      });
      await expect(
        service.update("1", { runtime: TaskRuntime.NODE } as any),
      ).rejects.toThrow(/inconsistent with task runtime/);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("NFR-05：非 zip 来源不查 applications 表（既有路径零额外查询）", async () => {
      await service.create({
        name: "t",
        runtime: TaskRuntime.PYTHON,
        gitRepo: "https://example.com/r.git",
      } as any);
      expect(appRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // §2.5 / D14：interpreter_unavailable 兜底分因（表格驱动）
  // ==========================================================================
  describe("inferFailureReason：interpreter_unavailable（§2.5 / D14）", () => {
    /**
     * 经 handleCallback 黑盒驱动 inferFailureReason（私有方法不直测）——
     * 同时验证"回调自带 failureReason 优先"的前置契约。
     */
    const inferVia = async (cb: Record<string, unknown>) => {
      const exec: any = {
        id: "e1",
        status: ExecutionStatus.RUNNING,
        logs: "",
      };
      execRepo.findOne.mockResolvedValue(exec);
      execRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      await service.handleCallback([{ executionId: "e1", ...cb } as any]);
      return { exec, status: exec.status, reason: exec.failureReason };
    };

    // 表格驱动：lead 提供的实测分类矩阵（正例 5 条）。
    it.each([
      [
        "缓存缺失 + 下载失败（旧执行器无分类 → unknown）",
        {
          status: "failed",
          errorMessage:
            "interpreter 3.7 unavailable (cache miss + download failed)",
        },
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      ],
      [
        "uv venv --python 3.7 原始文案（exit 2，旧执行器会归 script_error）",
        {
          status: "failed",
          errorMessage:
            "No interpreter found for Python 3.7 in managed installations, search path, or registry",
          exitCode: 2,
        },
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      ],
      [
        "uv venv failed 包装 + No interpreter found（3.9）",
        {
          status: "failed",
          errorMessage: "uv venv failed: No interpreter found for Python 3.9",
          exitCode: 2,
        },
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      ],
      [
        "中文：解释器 3.13 无法获取（缓存缺失 + 下载失败：连接超时）",
        {
          status: "failed",
          errorMessage: "解释器 3.13 无法获取（缓存缺失 + 下载失败：连接超时）",
        },
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      ],
      [
        "**关键**：解释器下载超时含 timeout 措辞，必须赢过 timeout 规则",
        {
          status: "failed",
          errorMessage: "interpreter download timeout after 300s",
        },
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      ],
    ])("正例：%s", async (_label, cb, expected) => {
      const r = await inferVia(cb as any);
      expect(r.reason).toBe(expected);
    });

    it.each([
      [
        "真实任务超时 → TIMEOUT（不得被解释器规则误吞）",
        { status: "failed", errorMessage: "execution timed out after 300s" },
        ExecutionFailureReason.TIMEOUT,
      ],
      [
        "真实任务超时（大写下划线形态）",
        { status: "failed", errorMessage: "Execution timed out" },
        ExecutionFailureReason.TIMEOUT,
      ],
    ])("负例：%s", async (_label, cb, expected) => {
      const r = await inferVia(cb as any);
      expect(r.reason).toBe(expected);
    });

    it("负例：uv pip install failed → 不归 interpreter_unavailable（仍归依赖/包类）", async () => {
      const r = await inferVia({
        status: "failed",
        errorMessage:
          "uv pip install failed: no matching distribution found for foo",
      });
      expect(r.reason).not.toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
      // 本兜底分类器的依赖/包类落点是 PACKAGE_FETCH_FAILED（`pip install` 命中
      // 该规则）；DEPENDENCY_INSTALL_FAILED 是**执行器上报**的细分取值，兜底
      // 不产生它。此处钉住"仍在依赖/包类、未被解释器规则吞掉"这一语义。
      expect(r.reason).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
    });

    it("负例：任务自身代码只打印 'interpreter' 一词 → 不误判", async () => {
      const r = await inferVia({
        status: "failed",
        errorMessage: "Traceback: my interpreter helper raised ValueError",
      });
      expect(r.reason).not.toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("负例：裸 `uv venv failed`（无解释器缺失证据）→ 不误判", async () => {
      const r = await inferVia({
        status: "failed",
        errorMessage: "uv venv failed: permission denied",
      });
      expect(r.reason).not.toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("负例：非零退出码单独存在 → SCRIPT_ERROR（规则不得放宽到 exitCode）", async () => {
      const r = await inferVia({ status: "failed", exitCode: 2 });
      expect(r.reason).toBe(ExecutionFailureReason.SCRIPT_ERROR);
    });

    it("兜底定位：回调自带 failureReason 时优先采信（本规则只是 fallback）", async () => {
      // 执行器已分类 → 即使文案像解释器问题也不覆盖（尊重执行器判定）。
      const r = await inferVia({
        status: "failed",
        errorMessage: "No interpreter found for Python 3.7",
        failureReason: ExecutionFailureReason.RUNTIME_MISSING,
      });
      expect(r.reason).toBe(ExecutionFailureReason.RUNTIME_MISSING);
    });

    it("中文变体：解释器下载失败（无'无法获取'字样）→ 匹配", async () => {
      const r = await inferVia({
        status: "failed",
        errorMessage: "解释器下载失败：连接超时",
      });
      expect(r.reason).toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("UV_PYTHON_DOWNLOADS=manual 提示 → 匹配", async () => {
      const r = await inferVia({
        status: "failed",
        errorMessage:
          "python downloads are set to 'manual'; run `uv python install 3.7`",
      });
      expect(r.reason).toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("`No download found for request: cpython-3.7-<platform>` → 匹配", async () => {
      const r = await inferVia({
        status: "failed",
        errorMessage:
          "No download found for request: cpython-3.7-x86_64-unknown-linux-gnu",
      });
      expect(r.reason).toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("interpreter_unavailable 归 FAILED（非 TIMEOUT 状态——语义是明确失败，D14）", async () => {
      const r = await inferVia({
        status: "failed",
        errorMessage: "No interpreter found for Python 3.7",
      });
      expect(r.status).toBe(ExecutionStatus.FAILED);
    });

    it("跨行不误判：解释器词与失败词相隔很远（不同日志行）→ 不匹配", async () => {
      const r = await inferVia({
        status: "failed",
        logs: "starting interpreter\n... 200 lines ...\nconnection failed",
      });
      expect(r.reason).not.toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });
  });
});
