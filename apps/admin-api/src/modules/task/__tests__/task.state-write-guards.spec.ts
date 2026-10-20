import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { TaskService } from "../task.service";
import { UserRole } from "../../users/entities/user.entity";
import {
  Task,
  BlockStrategy,
  ExecuteMode,
  TaskCodeSource,
  TaskPriority,
  TaskRuntime,
  TaskStatus,
  TaskTriggerType,
} from "../entities/task.entity";
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
    // R49-A1: update/updateGlue 会落版本快照（saveVersion 走 SELECT MAX(version)），
    // 改名还会经 renameDependencyAlias 走读侧 QB——补上读链，否则列级写用例会撞
    // `getRawOne is not a function` 这种与被测语义无关的红。
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ maxNum: 0 }),
    getRawMany: jest.fn().mockResolvedValue([]),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
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
  // R63-A1: rollbackToVersion 读版本行（getVersion）；rollback 走事务 manager。
  let versionRepo: Repo;
  let dataSource: { transaction: jest.Mock; createQueryBuilder: jest.Mock };
  let schedulerService: { stop: jest.Mock; scheduleOne: jest.Mock; getStats: jest.Mock };
  let executorService: { notifyExecutorKill: jest.Mock };
  let aiService: { analyzeFailure: jest.Mock; chat: jest.Mock };
  const ADMIN_USER = { id: 1, role: UserRole.ADMIN };

  beforeEach(async () => {
    taskRepo = makeRepo();
    execRepo = makeRepo();
    versionRepo = makeRepo();
    dataSource = { transaction: jest.fn(), createQueryBuilder: jest.fn() };
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
        { provide: getRepositoryToken(TaskVersion), useValue: versionRepo },
        {
          provide: getQueueToken("task-queue"),
          useValue: { add: jest.fn().mockResolvedValue({}) },
        },
        { provide: DataSource, useValue: dataSource },
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
      // 真实 findOne 会过滤软删行（@DeleteDateColumn）：deletedAt 非空 = 该行对
      // TypeORM 读面**不存在**。S1/S2 的"输给并发 remove"用例依赖这一条，
      // 否则写后回读会把已软删的行当成"还在"，断言变成假绿。
      if (store.deletedAt != null) return null;
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

  type WriteCall = {
    setPatch: Record<string, any> | null;
    whereSql: string[];
    whereParams: Array<Record<string, any>>;
  };

  /**
   * R49-A1：**行谓词替身**——把生产代码写进 WHERE ... AND ... 的条件按真实
   * SQL 语义对存储求值（= PG 的 affected），并把每次写的 patch / 谓词录下来
   * 供断言。
   *
   * 与上面 givenConditionalUpdate 的分工：那个替身只需要一个 boolean 谓词
   * （pause/resume 的 from 是单一状态）；remove 的可删起点是**集合**、且要在
   * 同一用例里观察"先置 deleted → 再补偿回滚"的两次写，故这里把谓词文本与
   * 参数一起解析。只支持本模块用到的四种形态，遇到别的形态直接抛——替身悄悄
   * 放行会让用例在错误的前提下变绿（ADR-027 替身保真度）。
   */
  const givenRowPredicateUpdate = (store: Record<string, any>): WriteCall[] => {
    const calls: WriteCall[] = [];
    taskRepo.createQueryBuilder = jest.fn(() => {
      let patch: Record<string, any> | null = null;
      const conds: Array<{ sql: string; params?: Record<string, any> }> = [];
      const qb: any = {
        update: jest.fn(() => qb),
        set: jest.fn((p: Record<string, any>) => {
          patch = p;
          return qb;
        }),
        where: jest.fn((sql: string, params?: Record<string, any>) => {
          conds.push({ sql, params });
          return qb;
        }),
        andWhere: jest.fn((sql: string, params?: Record<string, any>) => {
          conds.push({ sql, params });
          return qb;
        }),
        returning: jest.fn(() => qb),
        select: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        addOrderBy: jest.fn(() => qb),
        take: jest.fn(() => qb),
        getRawOne: jest.fn(async () => ({ maxNum: 0 })),
        getRawMany: jest.fn(async () => []),
        getMany: jest.fn(async () => []),
        getOne: jest.fn(async () => null),
        execute: jest.fn(async () => {
          const setPatch = patch;
          calls.push({
            setPatch,
            whereSql: conds.map((c) => c.sql),
            whereParams: conds
              .map((c) => c.params)
              .filter((p): p is Record<string, any> => Boolean(p)),
          });
          const hit = conds.every(({ sql, params }) => {
            if (sql.includes('"id" = :id')) return store.id === params?.id;
            if (sql.includes('"deletedAt" IS NULL')) {
              return store.deletedAt == null;
            }
            if (sql.includes('"status" IN (:...fromStatuses)')) {
              return (params?.fromStatuses ?? []).includes(store.status);
            }
            if (sql.includes('"status" = :from')) {
              return store.status === params?.from;
            }
            // R52：乐观锁下沉到写谓词后的形态——半开区间 [tsFrom, tsTo)
            // （PG 存微秒、hydration 截毫秒，用区间而不是等值/date_trunc）。
            if (sql.includes('"updatedAt" >= :tsFrom')) {
              const v = new Date(store.updatedAt).getTime();
              const from = new Date(params?.tsFrom).getTime();
              const to = new Date(params?.tsTo).getTime();
              return v >= from && v < to;
            }
            throw new Error(
              "givenRowPredicateUpdate: 无法求值的行谓词: " + sql,
            );
          });
          if (!hit) return { affected: 0 };
          Object.assign(store, setPatch ?? {});
          return { affected: 1 };
        }),
      };
      return qb;
    });
    return calls;
  };

  /** 软删替身：命中即落 deletedAt（= @DeleteDateColumn 真实语义）；可注入失败。 */
  const givenSoftDelete = (
    store: Record<string, any>,
    opts?: { failWith?: Error },
  ) => {
    taskRepo.softDelete.mockImplementation(async () => {
      if (opts?.failWith) throw opts.failWith;
      store.deletedAt = new Date("2026-10-21T00:00:00.000Z");
      return { affected: 1 };
    });
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

  // ==========================================================================
  // R49-A1 · S2：update / updateGlue 只写**本次 DTO 出现的列**，不再整行回写
  // 方法早期读到的快照（ADR-026 规则 4）。
  //
  // 旧实现的两种现形方式（都在下面的用例里被钉死）：
  //   ① 窗口内并发 pause 把 status 改成 paused，PATCH 的整行 save 把快照里的
  //      active 盖回去 —— 暂停"自己恢复了"；
  //   ② 窗口内并发 remove 把行软删，整行 save 把 status 写回 active（软删行复活）。
  // ==========================================================================
  describe("R49-A1 S2: update / updateGlue 只写 dto 出现的列", () => {
    it("update 只写 dto 列：窗口内并发 pause 的 status / 并发 PATCH 的 description 必须存活", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          name: "旧名",
          description: "旧描述",
          timeout: 300,
          status: TaskStatus.ACTIVE,
          deletedAt: null,
          secrets: null,
        },
        (s) => {
          // 读之后、写之前的并发写（真实条件写已提交）
          s.status = TaskStatus.PAUSED;
          s.description = "并发改的描述";
        },
      );
      const calls = givenRowPredicateUpdate(store);

      const result: any = await service.update("t1", { timeout: 900 } as any);

      // 本次 PATCH 的列生效
      expect(store.timeout).toBe(900);
      expect(result.timeout).toBe(900);
      // 反证核心：快照里的 status / description 不参与任何写
      expect(store.status).toBe(TaskStatus.PAUSED);
      expect(store.description).toBe("并发改的描述");
      expect(taskRepo.save).not.toHaveBeenCalled();
      // 调度重排必须按**回读到的**状态判定：并发 pause 已生效 → 不得重排定时器
      // （旧实现按快照里的 active 重排，等于把别人的暂停又恢复了）。
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
      // patch 的键集合 = DTO 出现的键（+ 库时钟 updatedAt）
      expect(Object.keys(calls[0].setPatch ?? {}).sort()).toEqual([
        "timeout",
        "updatedAt",
      ]);
      // @UpdateDateColumn 在 QueryBuilder UPDATE 上**不会**自动刷新
      // （R46-A1 踩过）——必须显式写库时钟
      expect(typeof (calls[0].setPatch as any)?.updatedAt).toBe("function");
      // 行谓词：id + 软删过滤
      expect(calls[0].whereSql.join(" AND ")).toContain("deletedAt");
    });

    it("R52 乐观锁下沉：读时一致但窗口内被别人推进 → 写谓词落空 → 409，且不落任何列", async () => {
      const t0 = new Date("2026-10-01T08:00:00.000Z");
      const t1 = new Date("2026-10-01T09:30:00.000Z");
      const store = givenTaskStore(
        {
          id: "t1",
          name: "旧名",
          status: TaskStatus.ACTIVE,
          deletedAt: null,
          secrets: null,
          updatedAt: t0,
        },
        (s) => {
          // 读之后、写之前的并发推进：另一个标签页已经改过这一行
          s.updatedAt = t1;
        },
      );
      const calls = givenRowPredicateUpdate(store);

      // 期望版本 = 读到的 t0 —— 读时预判能过（快照确实还是 t0），
      // 但真正裁决在写谓词上：store 已是 t1，区间 [t0, t0+1ms) 不命中。
      await expect(
        service.update("t1", {
          name: "新名",
          expectedUpdatedAt: t0.toISOString(),
        } as any),
      ).rejects.toBeDefined();

      // 关键：写确实发出去了（不是靠读时短路），但**一行都没改**。
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(store.name).toBe("旧名");
      expect(store.updatedAt).toBe(t1);
    });
    it("update 输给并发 remove（行已软删）→ 404，不复活软删行、不排调度", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          name: "旧名",
          status: TaskStatus.ACTIVE,
          deletedAt: null,
          secrets: null,
        },
        (s) => {
          // 读之后、写之前：并发 remove 已把它软删
          s.deletedAt = new Date("2026-10-21T00:00:00.000Z");
          s.status = TaskStatus.DELETED;
        },
      );
      const calls = givenRowPredicateUpdate(store);

      await expect(
        service.update("t1", { name: "新名" } as any),
      ).rejects.toThrow(NotFoundException);

      // 行没有被"写回来"：软删标记与并发写下的 status 全部原样
      expect(store.deletedAt).toEqual(new Date("2026-10-21T00:00:00.000Z"));
      expect(store.status).toBe(TaskStatus.DELETED);
      expect(store.name).toBe("旧名");
      expect(taskRepo.save).not.toHaveBeenCalled();
      // 失败发生在任何副作用之前（不重排调度）
      expect(schedulerService.stop).not.toHaveBeenCalled();
      // 谓词确实求值过（不是"根本没写"的假绿）
      expect(calls).toHaveLength(1);
    });

    it("update 只在 DTO 真的带 status 时才写 status（显式意图 ≠ 快照顺带）", async () => {
      const store = givenTaskStore({
        id: "t1",
        name: "n",
        status: TaskStatus.ACTIVE,
        deletedAt: null,
        secrets: null,
      });
      const calls = givenRowPredicateUpdate(store);

      await service.update("t1", { status: TaskStatus.PAUSED } as any);

      expect(store.status).toBe(TaskStatus.PAUSED);
      expect(Object.keys(calls[0].setPatch ?? {}).sort()).toEqual([
        "status",
        "updatedAt",
      ]);
    });

    it("updateGlue 只写 glue 四列：窗口内并发 pause 的 status 与并发改名必须存活", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          name: "旧名",
          status: TaskStatus.ACTIVE,
          glueSource: "old",
          glueLanguage: "js",
          gitRepo: "https://example.com/r.git",
          codeSource: TaskCodeSource.GIT,
          deletedAt: null,
          secrets: null,
        },
        (s) => {
          s.status = TaskStatus.PAUSED;
          s.name = "并发新名";
        },
      );
      const calls = givenRowPredicateUpdate(store);

      const result: any = await service.updateGlue(
        "t1",
        "new-source",
        "python",
      );

      // 本方法的确定语义：切到 glue 且清 gitRepo（FR-18 不变式）
      expect(store.glueSource).toBe("new-source");
      expect(store.glueLanguage).toBe("python");
      expect(store.codeSource).toBe(TaskCodeSource.GLUE);
      expect(store.gitRepo).toBeNull();
      expect(result.glueSource).toBe("new-source");
      // 反证：并发 pause 的 status、并发改名都不被盖回
      expect(store.status).toBe(TaskStatus.PAUSED);
      expect(store.name).toBe("并发新名");
      expect(taskRepo.save).not.toHaveBeenCalled();
      expect(Object.keys(calls[0].setPatch ?? {}).sort()).toEqual([
        "codeSource",
        "gitRepo",
        "glueLanguage",
        "glueSource",
        "updatedAt",
      ]);
    });
  });

  // ==========================================================================
  // R49-A1 · S1：remove = 条件状态迁移（只写 status）+ 独立软删。
  //
  // 判定（写进实现注释，这里钉行为）：tasks 只有 active / paused / deleted
  // 三个状态，没有"运行中"的任务态（执行态在 task_executions 上），故**可删
  // 起点 = {active, paused}**；deleted 不是可删起点（findByIdRaw 已排除）。
  // 不凭空收严：此前 active/paused 都能删，删除也不 kill 在跑的执行。
  // ==========================================================================
  describe("R49-A1 S1: remove 条件置 DELETED + 独立软删", () => {
    it("先条件置 DELETED（只写 status）再独立软删：窗口内并发 PATCH 的 name/timeout 必须存活", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          status: TaskStatus.ACTIVE,
          name: "旧名",
          timeout: 300,
          deletedAt: null,
          secrets: null,
        },
        (s) => {
          s.name = "新名";
          s.timeout = 900;
        },
      );
      const calls = givenRowPredicateUpdate(store);
      givenSoftDelete(store);

      const result = await service.remove("t1");

      expect(result).toEqual({ deleted: true });
      expect(store.status).toBe(TaskStatus.DELETED);
      // 反证核心：整行 save 会把旧 name/timeout 盖回去
      expect(store.name).toBe("新名");
      expect(store.timeout).toBe(900);
      // 两步都在，且软删是**独立**的一次写
      expect(taskRepo.softDelete).toHaveBeenCalledWith("t1");
      expect(store.deletedAt).toBeInstanceOf(Date);
      expect(taskRepo.save).not.toHaveBeenCalled();
      // 第一步只写 status 一列（+ 库时钟）
      expect(Object.keys(calls[0].setPatch ?? {}).sort()).toEqual([
        "status",
        "updatedAt",
      ]);
      expect(calls[0].setPatch?.status).toBe(TaskStatus.DELETED);
      // 行谓词：id + 可删起点集合 + 软删过滤
      const where = calls[0].whereSql.join(" AND ");
      expect(where).toContain("status");
      expect(where).toContain("deletedAt");
      // 可删起点集合 = {active, paused}——显式钉住"哪些状态可删"
      const fromStatuses = calls[0].whereParams
        .map((p) => p.fromStatuses)
        .find(Boolean);
      expect([...fromStatuses].sort()).toEqual(
        [TaskStatus.ACTIVE, TaskStatus.PAUSED].sort(),
      );
      // 软删放在状态迁移**之后**：谓词要求 deletedAt IS NULL，顺序反了必丢写
      expect(calls).toHaveLength(1);
    });

    it("输给并发 remove（行已软删）→ 404（与顺序执行同解），不重复软删、不改行", async () => {
      const store = givenTaskStore(
        { id: "t1", status: TaskStatus.ACTIVE, name: "n", deletedAt: null, secrets: null },
        (s) => {
          s.deletedAt = new Date("2026-10-21T00:00:00.000Z");
        },
      );
      givenRowPredicateUpdate(store);
      givenSoftDelete(store);

      await expect(service.remove("t1")).rejects.toThrow(NotFoundException);

      expect(taskRepo.softDelete).not.toHaveBeenCalled();
      expect(taskRepo.save).not.toHaveBeenCalled();
      // 并发赢家的结果原样保留
      expect(store.status).toBe(TaskStatus.ACTIVE);
      expect(store.deletedAt).toEqual(new Date("2026-10-21T00:00:00.000Z"));
    });

    it("第二步软删失败 → 条件回滚 status（补偿），不留「已置 DELETED 但未软删」的行", async () => {
      const store = givenTaskStore({
        id: "t1",
        status: TaskStatus.ACTIVE,
        name: "n",
        deletedAt: null,
        secrets: null,
      });
      const calls = givenRowPredicateUpdate(store);
      givenSoftDelete(store, { failWith: new Error("soft-delete boom") });

      await expect(service.remove("t1")).rejects.toThrow("soft-delete boom");

      // 第一次：active -> deleted；第二次：deleted -> active（补偿回滚）
      expect(calls).toHaveLength(2);
      expect(calls[0].setPatch?.status).toBe(TaskStatus.DELETED);
      expect(calls[1].setPatch?.status).toBe(TaskStatus.ACTIVE);
      // 补偿同样是**条件写**（from=deleted）：行若已被并发推进则不覆盖
      expect(calls[1].whereSql.join(" AND ")).toContain("status");
      expect(calls[1].whereSql.join(" AND ")).toContain("deletedAt");
      expect(calls[1].setPatch?.status).not.toBe(TaskStatus.DELETED);
      // 终态：可继续被正常暂停/删除，raw query 也不会看到"删除态但行还在"
      expect(store.status).toBe(TaskStatus.ACTIVE);
      expect(store.deletedAt).toBeNull();
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

  // ==========================================================================
  // R63-A1：清单里剩下两处「整行 save」的判定与修法（ADR-026 规则 4）。
  //
  // 四处逐处判定（判定表见交接报告）：
  //   · storeLogLines / appendLogChunk 的 save(ExecutionLogLine, entities) ——
  //     写的是本方法内 create() 出来的新实体（无 id），是**插入路径**，不改；
  //   · rollback / rollbackToVersion 的 save(Task|task) —— 写的是方法早期读到
  //     的快照，是**整行回写**，本轮修掉。
  //
  // 这两处的语义都**不是**「只改一列」，但都可以用「本次动作真正要写的列」表达：
  //   · rollback 确实只改 gitCommit 一列 ⇒ 列级条件写；
  //   · rollbackToVersion 是"版本恢复"，语义上要覆盖**快照里带的那些列** ⇒
  //     「正向白名单 ∩ 采纳集（快照真的带了的键）」。快照里没有的列（status /
  //     secrets / ownerUserId / webhookSecret / deletedAt）永远不写——这正是
  //     旧实现 Object.assign + save 的越界处。
  // ==========================================================================
  describe("R63-A1: rollback / rollbackToVersion 不再整行回写快照", () => {
    /**
     * rollback() 的事务替身。两种写面各有**真实语义**：
     *  · `manager.save(Task, entity)` = 整行回写（= 修复前的缺陷形态；真实
     *    TypeORM save 会写实体上所有可写列，含 deletedAt ⇒ 软删行复活）；
     *  · `manager.update(Task, criteria, patch)` = 求值行谓词后只落给出的列。
     * 于是「用快照整行回写」会直接在行存储上现形。
     */
    const givenRollbackTransaction = (store: Record<string, any>) => {
      const taskSaves: Array<Record<string, any>> = [];
      const taskUpdates: Array<{
        criteria: Record<string, any>;
        patch: Record<string, any>;
      }> = [];
      const manager = {
        save: jest.fn(async (...args: any[]) => {
          const row = args[args.length - 1];
          if (args.length >= 2 && args[0] === Task) {
            taskSaves.push(row);
            Object.assign(store, row);
          }
          return row;
        }),
        update: jest.fn(
          async (
            _target: unknown,
            criteria: Record<string, any>,
            patch: Record<string, any>,
          ) => {
            taskUpdates.push({ criteria, patch });
            // 行谓词：id 命中 + 未软删（criteria 里的 deletedAt 是 IsNull()）
            const hit = store.id === criteria.id && store.deletedAt == null;
            if (!hit) return { affected: 0 };
            Object.assign(store, patch);
            return { affected: 1 };
          },
        ),
        create: jest.fn(() => ({ id: "rb-exec" })),
      };
      dataSource.transaction.mockImplementation(async (fn: any) => fn(manager));
      return { manager, taskSaves, taskUpdates };
    };

    /**
     * 一枚"每个快照键都有真实值"的任务行——用于漂移钉子：只要 saveVersion 的
     * 快照装配新增了键而 `VERSION_ROLLBACK_COLUMNS` 没跟上，本钉子就变红。
     */
    const fullTaskRow = (): Record<string, any> => ({
      id: "t1",
      name: "n",
      description: "d",
      runtime: TaskRuntime.PYTHON,
      entrypoint: "main.py",
      requirements: ["requests"],
      params: { a: 1 },
      timeout: 60,
      timeoutAction: "kill",
      timeoutWarnRatio: 80,
      estimatedDurationSec: 30,
      maxRetry: 2,
      retryDelay: 7,
      retryableErrors: ["timeout"],
      triggerType: TaskTriggerType.CRON,
      cronExpression: "0 * * * *",
      timezone: "UTC",
      fixedRate: null,
      blockStrategy: BlockStrategy.SERIAL,
      misfireStrategy: "ignore",
      priority: TaskPriority.NORMAL,
      executeMode: ExecuteMode.SINGLE,
      currentVersion: "v3",
      gitRepo: "https://example.com/r.git",
      gitBranch: "main",
      gitCommit: "sha-1",
      glueSource: "print(1)",
      glueLanguage: "python",
      runtimeVersion: "3.12",
      codeSource: TaskCodeSource.GLUE,
      applicationId: null,
      maintenanceWindows: null,
      runbook: "# rb",
      dependencies: { "dep-a": "t2" },
      deploymentPolicy: "prefer",
      executorAffinityTags: ["gpu"],
      executorAntiAffinityTags: ["edge"],
      executorId: "e-1",
      executorAppName: "app-a",
      executorGroup: "g-1",
      executorTags: ["py"],
      projectId: "p-1",
      alarmEmail: "a@b.c",
      alarmChannels: ["email"],
    });

    it("rollback 只写 gitCommit 一列：窗口内并发 PATCH 的 name / cron 必须存活", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          name: "旧名",
          gitCommit: "old-sha",
          cronExpression: "0 * * * *",
          status: TaskStatus.ACTIVE,
          params: {},
          deletedAt: null,
        },
        (s) => {
          s.name = "并发新名";
          s.cronExpression = "0 3 * * *";
        },
      );
      const { taskSaves, taskUpdates } = givenRollbackTransaction(store);

      const result: any = await service.rollback("t1", { gitCommit: "new-sha" });

      expect(store.gitCommit).toBe("new-sha");
      // 反证核心：整行回写会把这两列盖回方法读到的旧值
      expect(store.name).toBe("并发新名");
      expect(store.cronExpression).toBe("0 3 * * *");
      expect(taskSaves).toHaveLength(0);
      expect(taskUpdates).toHaveLength(1);
      expect(taskUpdates[0].patch).toEqual({ gitCommit: "new-sha" });
      // 行谓词带软删过滤（ADR-026 规则 1/2）
      expect(taskUpdates[0].criteria).toMatchObject({ id: "t1" });
      expect(taskUpdates[0].criteria.deletedAt).toBeDefined();
      expect(result.rolledBackFrom).toBe("old-sha");
      expect(result.rolledBackTo).toBe("new-sha");
    });

    it("rollback 输给并发 remove（行已软删）→ 404，不建执行行、不入队、不复活软删行", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          name: "n",
          gitCommit: "old-sha",
          status: TaskStatus.ACTIVE,
          deletedAt: null,
        },
        (s) => {
          s.deletedAt = new Date("2026-10-21T00:00:00.000Z");
          s.status = TaskStatus.DELETED;
        },
      );
      const { taskSaves } = givenRollbackTransaction(store);

      await expect(
        service.rollback("t1", { gitCommit: "new-sha" }),
      ).rejects.toThrow(NotFoundException);

      expect(store.deletedAt).toEqual(new Date("2026-10-21T00:00:00.000Z"));
      expect(store.status).toBe(TaskStatus.DELETED);
      expect(store.gitCommit).toBe("old-sha");
      expect(taskSaves).toHaveLength(0);
      expect(schedulerService.scheduleOne).not.toHaveBeenCalled();
    });

    it("rollbackToVersion 只写快照真的带了的列：窗口内并发 PATCH 的列必须存活", async () => {
      const store = givenTaskStore(
        {
          id: "t1",
          name: "当前名",
          description: "当前描述",
          timeout: 300,
          cronExpression: "0 * * * *",
          currentVersion: "v3",
          status: TaskStatus.ACTIVE,
          deletedAt: null,
        },
        (s) => {
          // 读之后、写之前的并发 PATCH（真实条件写已提交）
          s.description = "并发改的描述";
          s.cronExpression = "0 3 * * *";
        },
      );
      versionRepo.findOne.mockResolvedValue({
        id: "v1",
        taskId: "t1",
        version: "v2",
        snapshot: { id: "t1", name: "旧版名", timeout: 60 },
      });
      const calls = givenRowPredicateUpdate(store);

      const result: any = await service.rollbackToVersion("t1", "v1");

      // 快照恢复语义保留：快照里的列照常覆盖
      expect(store.name).toBe("旧版名");
      expect(store.timeout).toBe(60);
      expect(store.currentVersion).toBe("v2");
      // 反证核心：快照里没有的并发列不得被整行回写盖回
      expect(store.description).toBe("并发改的描述");
      expect(store.cronExpression).toBe("0 3 * * *");
      expect(taskRepo.save).not.toHaveBeenCalled();
      expect(result.name).toBe("旧版名");
      // 写入的列 = 快照键 ∩ 白名单（+ 库时钟）；主键 id 永不参与
      expect(Object.keys(calls[0].setPatch ?? {}).sort()).toEqual([
        "currentVersion",
        "name",
        "timeout",
        "updatedAt",
      ]);
      expect(calls[0].whereSql.join(" AND ")).toContain("deletedAt");
    });

    it("rollbackToVersion 输给并发 remove（行已软删）→ 404，不复活软删行、不排调度", async () => {
      const store = givenTaskStore(
        { id: "t1", name: "当前名", status: TaskStatus.ACTIVE, deletedAt: null },
        (s) => {
          s.deletedAt = new Date("2026-10-21T00:00:00.000Z");
          s.status = TaskStatus.DELETED;
        },
      );
      versionRepo.findOne.mockResolvedValue({
        id: "v1",
        taskId: "t1",
        version: "v2",
        snapshot: { name: "旧版名" },
      });
      givenRowPredicateUpdate(store);

      await expect(
        service.rollbackToVersion("t1", "v1"),
      ).rejects.toThrow(NotFoundException);

      // 行没有被"写回来"：软删标记与并发写下的 status 全部原样
      expect(store.deletedAt).toEqual(new Date("2026-10-21T00:00:00.000Z"));
      expect(store.status).toBe(TaskStatus.DELETED);
      expect(store.name).toBe("当前名");
      expect(taskRepo.save).not.toHaveBeenCalled();
      expect(schedulerService.stop).not.toHaveBeenCalled();
    });

    /**
     * 漂移钉子：rollbackToVersion 的可写列是**正向白名单**（不是"snapshot 里
     * 有什么就写什么"——那样一个被污染的/带 id 的快照就能改主键）。白名单与
     * saveVersion 装配的快照键必须同步，否则新字段的回滚会静默失效
     * （VER-DIFF-01 / A3 两轮审计踩的都是这一型）。这里用真实的 saveVersion
     * 产出快照，再要求它每个键都被本次回滚写入。
     */
    it("漂移钉子：saveVersion 快照的每个键都必须可被回滚写入（id 除外）", async () => {
      const row = fullTaskRow();
      taskRepo.findOne.mockImplementation(async () => ({ ...row }));

      await service.saveVersion("t1");
      const snapshot = versionRepo.create.mock.calls[0][0]
        .snapshot as Record<string, unknown>;

      versionRepo.findOne.mockResolvedValue({
        id: "v1",
        taskId: "t1",
        version: "v9",
        snapshot,
      });
      const store: Record<string, any> = { ...row, deletedAt: null };
      const calls = givenRowPredicateUpdate(store);

      await service.rollbackToVersion("t1", "v1");

      const written = calls[0].setPatch ?? {};
      const expected = Object.keys(snapshot).filter(
        (k) => k !== "id" && snapshot[k] !== undefined,
      );
      // 防止 snapshot 装配退化成空对象时本钉子假绿
      expect(expected.length).toBeGreaterThan(30);
      expect(expected.filter((k) => !(k in written))).toEqual([]);
      // 主键 / 审计列 / 快照刻意不带的列，一律不写
      expect(written).not.toHaveProperty("id");
      expect(written).not.toHaveProperty("deletedAt");
      expect(written).not.toHaveProperty("createdAt");
      expect(written).not.toHaveProperty("status");
      expect(written).not.toHaveProperty("secrets");
      expect(written).not.toHaveProperty("ownerUserId");
      expect(taskRepo.save).not.toHaveBeenCalled();
    });
  });
});
