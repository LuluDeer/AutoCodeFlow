import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { BadRequestException } from "@nestjs/common";
import { TaskService } from "../task.service";
import { UserRole } from "../../users/entities/user.entity";
import { Task, TaskStatus } from "../entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { TaskVersion } from "../entities/task-version.entity";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { AiService } from "../../ai/ai.service";
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { ConfigService } from "@nestjs/config";
import { ExecutorService } from "../../executor/executor.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";

/**
 * R46-A1（task 模块四轴审计）：**状态迁移写**的守卫用例。
 *
 * 这一组钉的不是"能暂停/能恢复/能分析"（那些行为 HEAD 上就是对的），而是
 * ADR-026 规则 1/2/4 要求的三件事：
 *
 *   1. 状态迁移的判据必须落在**数据库行谓词**上（`WHERE status = :from`），
 *      而不是"先 findOne 判一下再写"——后者只是把竞态窗口挪了个位置；
 *   2. 写只能覆盖**本次动作真正改变的列**，不得用方法早期读到的陈旧快照
 *      整行回写（否则窗口内别人提交的 name/timeout/status 会被静默盖回）；
 *   3. 条件不命中 = 并发收敛（ADR-026 规则 3）：不得 500，也不得按旧快照
 *      把别人刚写完的状态盖回去。
 *
 * 为什么这些缺陷在既有 147+ 例用例里永远是绿的：单线程、无并发、窗口≈0 时，
 * 「无条件整行写」与「条件单列写」行为完全相同（ADR-026 §背景 原文）。
 *
 * 因此本文件的替身**刻意模仿真实仓储语义**：
 *   · `findOne` 返回**副本**（=生产代码拿到的快照对象，不是存储本身）；
 *   · `save` 把入参**整行**写回存储（=TypeORM `repo.save(entity)`）；
 *   · 条件 UPDATE 只在行谓词成立时落 patch（=PG 的 affected）。
 * 于是"用快照整行回写"会直接在存储上现形。
 */

type Repo = {
  findOne: jest.Mock;
  find: jest.Mock;
  findAndCount: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  create: jest.Mock;
  createQueryBuilder: jest.Mock;
  softDelete: jest.Mock;
  delete: jest.Mock;
  metadata: unknown;
};

const makeRepo = (): Repo => {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
  };
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    save: jest.fn((e: unknown) => Promise.resolve(e)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((d: unknown) => d),
    createQueryBuilder: jest.fn(() => qb),
    softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    metadata: { columns: [], relations: [] },
  };
};

describe("R46-A1: tasks 行状态迁移必须条件写 + 只写改变的列", () => {
  let service: TaskService;
  let taskRepo: Repo;
  let execRepo: Repo;
  let schedulerService: { stop: jest.Mock; scheduleOne: jest.Mock; getStats: jest.Mock };
  let executorService: { notifyExecutorKill: jest.Mock };
  let aiService: { analyzeFailure: jest.Mock; chat: jest.Mock };
  const ADMIN_USER = { id: 1, role: UserRole.ADMIN };

  beforeEach(async () => {
    taskRepo = makeRepo();
    execRepo = makeRepo();
    schedulerService = {
      stop: jest.fn(),
      scheduleOne: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({}),
    };
    executorService = { notifyExecutorKill: jest.fn().mockResolvedValue(undefined) };
    aiService = {
      analyzeFailure: jest.fn().mockResolvedValue(""),
      chat: jest.fn().mockResolvedValue(""),
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
        { provide: getRepositoryToken(TaskVersion), useValue: makeRepo() },
        {
          provide: getQueueToken("task-queue"),
          useValue: { add: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        { provide: SchedulerService, useValue: schedulerService },
        { provide: AiService, useValue: aiService },
        { provide: AiAnalysisService, useValue: aiService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("any") },
        },
        { provide: ExecutorService, useValue: executorService },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ],
    }).compile();

    service = module.get(TaskService);
  });

  /**
   * 行存储替身：
   * - `findOne` 返回**副本**（=生产代码方法早期拿到的快照），
   * - `save` 把入参整行写回存储（=真实 `repo.save` 语义），
   * - `afterFirstRead` 在**第一次读返回之后**同步执行，用来模拟"读已发生、
   *   写还没发生"这个真实窗口里，别的请求（PATCH / remove / 回调）提交了写入。
   *   确定性，不依赖时序。
   */
  const givenTaskStore = (
    row: Record<string, any>,
    afterFirstRead?: (store: Record<string, any>) => void,
  ) => {
    const store: Record<string, any> = { ...row };
    let reads = 0;
    taskRepo.findOne.mockImplementation(async () => {
      const snapshot = { ...store };
      reads += 1;
      if (reads === 1 && afterFirstRead) afterFirstRead(store);
      return snapshot;
    });
    taskRepo.save.mockImplementation(async (t: any) => {
      Object.assign(store, t);
      return { ...store };
    });
    return store;
  };

  /** 条件 UPDATE 替身：只有 `matches()` 成立才落 patch（=真库的行谓词）。 */
  const givenConditionalUpdate = (
    matches: () => boolean,
    onExecute?: (opts: {
      setPatch: Record<string, unknown> | null;
      whereSql: string[];
    }) => void,
  ) => {
    let setPatch: Record<string, unknown> | null = null;
    const whereSql: string[] = [];
    const qb: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn((p: Record<string, unknown>) => {
        setPatch = p;
        return qb;
      }),
      where: jest.fn((sql: string) => {
        whereSql.push(sql);
        return qb;
      }),
      andWhere: jest.fn((sql: string) => {
        whereSql.push(sql);
        return qb;
      }),
      execute: jest.fn(async () => {
        // 先求值行谓词，再落 patch（顺序反了会把"本次写自己"算进行谓词）
        const hit = matches();
        if (hit) onExecute?.({ setPatch, whereSql });
        return { affected: hit ? 1 : 0 };
      }),
    };
    taskRepo.createQueryBuilder = jest.fn(() => qb);
    return qb;
  };

  describe("pause / resume", () => {
    it("pause 只写 status 一列：窗口内并发 PATCH 的 name/timeout 必须存活", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          status: TaskStatus.ACTIVE,
          name: "旧名",
          timeout: 300,
          secrets: null,
        },
        (s) => {
          // 读之后、写之前的并发 PATCH（真实写已提交）
          s.name = "新名";
          s.timeout = 900;
        },
      );
      const qb = givenConditionalUpdate(
        () => store.status === TaskStatus.ACTIVE,
        ({ setPatch, whereSql }) => {
          Object.assign(store, setPatch ?? {});
          // 谓词形状断言：必须带前置状态与软删条件（ADR-026 规则 1/2）
          const joined = whereSql.join(" AND ");
          expect(joined).toContain("status");
          expect(joined).toContain("deletedAt");
        },
      );

      const result = await service.pause("t1");

      expect(store.status).toBe(TaskStatus.PAUSED);
      // 反证核心：陈旧快照不得整行回写
      expect(store.name).toBe("新名");
      expect(store.timeout).toBe(900);
      expect(result.status).toBe(TaskStatus.PAUSED);
      // 整行 save 必须消失（只允许条件 UPDATE）
      expect(taskRepo.save).not.toHaveBeenCalled();
      expect(qb.execute).toHaveBeenCalled();
    });

    it("pause 输给并发迁移 → 与顺序执行同解（400），且不把已删行盖回 paused", async () => {
      const store = givenTaskStore(
        { id: "t1", status: TaskStatus.ACTIVE, name: "n", secrets: null },
        (s) => {
          // 读之后、写之前：并发 remove 把行推进为 deleted
          s.status = TaskStatus.DELETED;
        },
      );
      givenConditionalUpdate(() => store.status === TaskStatus.ACTIVE);

      await expect(service.pause("t1")).rejects.toThrow(BadRequestException);
      expect(store.status).toBe(TaskStatus.DELETED);
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it("resume 只写 status 一列：窗口内并发 PATCH 的 name/timeout 必须存活", async () => {
      const store = givenTaskStore(
        {
          id: "t2",
          status: TaskStatus.PAUSED,
          name: "旧名",
          timeout: 300,
          secrets: null,
        },
        (s) => {
          s.name = "新名";
          s.timeout = 900;
        },
      );
      givenConditionalUpdate(() => store.status === TaskStatus.PAUSED, ({ setPatch }) => {
        Object.assign(store, setPatch ?? {});
      });

      const result = await service.resume("t2");

      expect(store.status).toBe(TaskStatus.ACTIVE);
      expect(store.name).toBe("新名");
      expect(store.timeout).toBe(900);
      expect(result.status).toBe(TaskStatus.ACTIVE);
      expect(taskRepo.save).not.toHaveBeenCalled();
      expect(schedulerService.scheduleOne).toHaveBeenCalled();
    });

    it("resume 输给并发迁移 → 与顺序执行同解（400），且不复活已删行、不重排调度", async () => {
      const store = givenTaskStore(
        { id: "t2", status: TaskStatus.PAUSED, name: "n", secrets: null },
        (s) => {
          s.status = TaskStatus.DELETED;
        },
      );
      givenConditionalUpdate(() => store.status === TaskStatus.PAUSED);

      await expect(service.resume("t2")).rejects.toThrow(BadRequestException);
      expect(store.status).toBe(TaskStatus.DELETED);
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
      expect(taskRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("analyzeExecution", () => {
    it("只写 aiAnalysis 一列：AI 窗口内落定的终态不得被盖回 RUNNING", async () => {
      const store: Record<string, any> = {
        id: "exec-1",
        taskId: "t1",
        taskName: "job",
        status: ExecutionStatus.RUNNING,
        endTime: null,
        exitCode: null,
        duration: null,
        failureReason: null,
        aiAnalysis: null,
      };
      execRepo.findOne.mockImplementation(async () => ({ ...store }));
      execRepo.save.mockImplementation(async (e: any) => {
        // 整行回写（真实 repo.save 语义）
        Object.assign(store, e);
        return { ...store };
      });
      execRepo.update.mockImplementation(
        async (_criteria: any, patch: Record<string, unknown>) => {
          // 单列 UPDATE：只改给出的列
          Object.assign(store, patch);
          return { affected: 1 };
        },
      );
      taskRepo.findOne.mockResolvedValue({
        id: "t1",
        ownerUserId: 1,
        projectId: null,
      });
      const finishedAt = new Date("2026-10-20T10:00:00.000Z");
      aiService.analyzeFailure.mockImplementation(async () => {
        // AI 调用窗口（秒级）内，执行器回调把该行推进到终态
        store.status = ExecutionStatus.SUCCESS;
        store.endTime = finishedAt;
        store.exitCode = 0;
        store.duration = 1234;
        return "AI: done";
      });

      const result = await service.analyzeExecution("exec-1", ADMIN_USER);

      expect(store.status).toBe(ExecutionStatus.SUCCESS);
      expect(store.endTime).toEqual(finishedAt);
      expect(store.exitCode).toBe(0);
      expect(store.duration).toBe(1234);
      expect(result.aiAnalysis).toBe("AI: done");
      // 整行回写必须消失：只允许单列 UPDATE
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(execRepo.update).toHaveBeenCalledWith(
        { id: "exec-1" },
        { aiAnalysis: "AI: done" },
      );
    });
  });

  describe("已有守卫的钉子（轴 2：kill vs 迟到回调）", () => {
    it("回调先赢（行已 SUCCESS）→ kill 抛已终态，不写库、不通知执行器", async () => {
      const exec = {
        id: "e-late",
        taskId: "t1",
        status: ExecutionStatus.SUCCESS,
        executorAddress: "10.0.0.9:8002",
        endTime: new Date(),
      };
      execRepo.findOne.mockResolvedValue(exec);
      taskRepo.findOne.mockResolvedValue({
        id: "t1",
        ownerUserId: 1,
        projectId: null,
      });
      // 真实语义：条件 UPDATE 命中 0（行已终态）
      const qb: any = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
      };
      execRepo.createQueryBuilder = jest.fn(() => qb);

      await expect(service.killExecution("e-late", ADMIN_USER)).rejects.toThrow(
        BadRequestException,
      );
      expect(execRepo.save).not.toHaveBeenCalled();
      // 已成功退出的执行器不得收到迟到的 kill 信号
      expect(executorService.notifyExecutorKill).not.toHaveBeenCalled();
    });
  });
});
