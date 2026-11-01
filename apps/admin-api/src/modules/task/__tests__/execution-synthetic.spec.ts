import "reflect-metadata";
import { getMetadataArgsStorage } from "typeorm";
import { areDependenciesSatisfied } from "../dependency-gate.util";
import {
  ExecutionStatus,
  TaskExecution,
} from "../entities/task-execution.entity";
import { projectExecutionListColumns } from "../execution-list-projection";
import { TaskService } from "../task.service";

/**
 * G2-风险 1（S7 编排交叉分析 · §G2「风险 1」· 迁移 1790000000091）：
 * **为可见性合成的执行行不得参与依赖判定**。
 *
 * ## 缺陷形态（为什么这是个真缺陷）
 *
 * G2 为「未声明失败边」的下游在上游失败时落一条 `cancelled` 行——目的是让
 * `list_executions` 里能看到「它因为上游失败而**没跑**」。
 *
 * 但 `areDependenciesSatisfied` 判定依赖时看的是「依赖任务**最新**的一行执行」。
 * 那条 `cancelled` 行一旦成为该下游的最新行，它的下游（孙节点）读到的就是
 * `cancelled` 而不是它上次的 `SUCCESS`；孙节点未声明失败边（默认
 * `acceptFailure=false`）时 `cancelled` 不算满足 ⇒ **孙节点静默不触发**。
 * 「为了让没跑可见」反而让「本来会跑」的不跑，净负收益（与 Hatchet 的 cancelled
 * 级联同一副作用）。
 *
 * ## 修法与本文的四个判据
 *
 * ① `synthetic=true` 的 cancelled 行不影响依赖判定（孙节点仍看到上次的 SUCCESS）；
 * ② 回归锁：`synthetic=false` 的 cancelled 行**照旧**不满足依赖（既有语义逐字节
 *    不变——这是本改动的硬要求）；
 * ③ G2 建的那批行确实是 `synthetic=true`（用例在 `task.service.spec.ts` 的 G2-①，
 *    那里才跑得到真实的建行路径）；
 * ④ `list_executions` 仍能看到 synthetic 行（可见性没丢——这是它们的全部价值）。
 *
 * ## 为什么替身要**真的**应用 where 谓词
 *
 * 若替身忽略 `where.synthetic`（像既有多数用例那样直接返回固定数组），那么
 * 「过滤生效」这件事根本测不到——删掉生产代码里的 `synthetic: false` 用例照样绿。
 * 故下面的 `makeExecRepo` 按 DB 语义**先筛后排**：`where.synthetic` 未给时不筛，
 * 给了就按值相等筛。这样用例的绿/红由「生产代码有没有把这个谓词传下来」决定。
 */

/** 执行行替身（只建模本判据消费的三列 + 排序键）。 */
interface ExecRow {
  taskId: string;
  status: string;
  synthetic: boolean;
  /** 排序用（等价于 `createdAt DESC`；越大越新）。 */
  createdAt: number;
}

const makeExecRepo = (rows: ExecRow[]) => {
  const applyWhere = (where: Record<string, any> | undefined): ExecRow[] => {
    if (!where) return rows;
    return rows
      .filter((row) => {
        const w = where["taskId"];
        if (w === undefined) return true;
        // TypeORM 的 In(...) 是 FindOperator，值在 _value（既有用例同款取法）
        if (typeof w === "string") return row.taskId === w;
        const values = (w as { _value?: unknown })._value;
        return Array.isArray(values) ? values.includes(row.taskId) : true;
      })
      .filter((row) =>
        where["synthetic"] === undefined
          ? true
          : row.synthetic === where["synthetic"],
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  };

  return {
    find: jest.fn(async (opts?: Record<string, any>) => {
      const matched = applyWhere(opts?.["where"]);
      return (
        opts?.["take"] ? matched.slice(0, opts["take"]) : matched
      ) as never;
    }),
    findOne: jest.fn(
      async (opts?: Record<string, any>) =>
        (applyWhere(opts?.["where"])[0] ?? null) as never,
    ),
  };
};

describe("G2-风险 1 · synthetic 执行行不参与依赖判定（迁移 1790000000091）", () => {
  it("① synthetic=true 的 cancelled 行不顶替最新执行：孙节点仍看到该下游上次的 SUCCESS → 满足", async () => {
    // 依赖 dep-1 的历史（新 → 旧）：
    //   ★ G2 合成行：cancelled / synthetic = true（它自己的上游刚失败）
    //   · 真实尝试：SUCCESS（synthetic = false）
    const repo = makeExecRepo([
      {
        taskId: "dep-1",
        status: ExecutionStatus.CANCELLED,
        synthetic: true,
        createdAt: 2,
      },
      {
        taskId: "dep-1",
        status: ExecutionStatus.SUCCESS,
        synthetic: false,
        createdAt: 1,
      },
    ]);

    // 孙节点（默认 acceptFailure=false）照旧满足 ⇒ 正常触发
    await expect(areDependenciesSatisfied(repo, { up: "dep-1" })).resolves.toBe(
      true,
    );
    // 查询层证据：谓词确实传下去了（替身据此筛掉了合成行）
    const findArg = repo.find.mock.calls[0][0] as Record<string, any>;
    expect(findArg["where"].synthetic).toBe(false);
  });

  it("①b acceptFailure=true 时 synthetic 行也不被当成「真实失败」：判定仍用上次真实 FAILED", async () => {
    // 若合成行参与判定，acceptFailure=true 会把「因上游坏而没跑」误当成该下游自己
    // 的一次失败终态——两种结论碰巧都是「满足」，但语义完全不同。这里用
    // 「上次真实尝试是 FAILED」来证明判定取的是**真实**那一行。
    const repo = makeExecRepo([
      {
        taskId: "dep-1",
        status: ExecutionStatus.CANCELLED,
        synthetic: true,
        createdAt: 2,
      },
      {
        taskId: "dep-1",
        status: ExecutionStatus.FAILED,
        synthetic: false,
        createdAt: 1,
      },
    ]);
    await expect(
      areDependenciesSatisfied(repo, { up: "dep-1" }, { acceptFailure: true }),
    ).resolves.toBe(true);

    // 对照：上次真实尝试是 SUCCESS、本次是合成行 ⇒ 满足（与 acceptFailure 无关）
    const successRepo = makeExecRepo([
      {
        taskId: "dep-1",
        status: ExecutionStatus.CANCELLED,
        synthetic: true,
        createdAt: 2,
      },
      {
        taskId: "dep-1",
        status: ExecutionStatus.SUCCESS,
        synthetic: false,
        createdAt: 1,
      },
    ]);
    await expect(
      areDependenciesSatisfied(successRepo, { up: "dep-1" }),
    ).resolves.toBe(true);
  });

  it("② 回归锁：synthetic=false 的 cancelled 行照旧不满足依赖（既有语义逐字节不变）", async () => {
    // 一行 cancelled、synthetic=false（= 一次真实尝试，例如人工取消）作为最新行：
    // 默认 acceptFailure=false 下**仍然不满足**——与引入本列前完全一致。
    const repo = makeExecRepo([
      {
        taskId: "dep-1",
        status: ExecutionStatus.CANCELLED,
        synthetic: false,
        createdAt: 2,
      },
      {
        taskId: "dep-1",
        status: ExecutionStatus.SUCCESS,
        synthetic: false,
        createdAt: 1,
      },
    ]);
    await expect(areDependenciesSatisfied(repo, { up: "dep-1" })).resolves.toBe(
      false,
    );

    // 回归锁之二：真实 FAILED 仍不满足（acceptFailure 默认 false）
    const failedRepo = makeExecRepo([
      {
        taskId: "dep-1",
        status: ExecutionStatus.FAILED,
        synthetic: false,
        createdAt: 1,
      },
    ]);
    await expect(
      areDependenciesSatisfied(failedRepo, { up: "dep-1" }),
    ).resolves.toBe(false);
  });

  it("只有 synthetic 行 = 该依赖从未真正跑过 → 不满足，且定向兜底查询同样带 synthetic=false", async () => {
    // 主扫描的 500 行窗口里只有合成行（被谓词筛掉）⇒ 该依赖缺席 ⇒ 走 findOne 兜底；
    // 兜底若不带谓词，合成行会从这条后门重新成为「最新执行」（正是要防的漂移）。
    const repo = makeExecRepo([
      {
        taskId: "dep-1",
        status: ExecutionStatus.CANCELLED,
        synthetic: true,
        createdAt: 1,
      },
    ]);

    await expect(areDependenciesSatisfied(repo, { up: "dep-1" })).resolves.toBe(
      false,
    );
    // 主扫描不带谓词（未实现过滤）时兜底也不会被调到——所以先证明兜底真的发了
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    const fallbackArg = repo.findOne.mock.calls[0][0] as Record<string, any>;
    expect(fallbackArg["where"]).toMatchObject({
      taskId: "dep-1",
      synthetic: false,
    });
  });
});

describe("G2-风险 1 · 可见性没丢：list_executions 照旧显示 synthetic 行", () => {
  const entityColumnNames = () =>
    getMetadataArgsStorage()
      .columns.filter((c) => c.target === TaskExecution)
      .map((c) => c.propertyName);

  it("④ 列表读投影包含 synthetic（排除表只排重型文本列，新列自动入选）", () => {
    // 执行列表的列投影 = 实体列全集 − 重型文本排除表（execution-list-projection.ts）。
    // 若哪天有人把 synthetic 塞进排除表，用例红——那正是「为了修依赖判定而顺手
    // 把可见性也砍掉」的形态。
    const projected = projectExecutionListColumns(entityColumnNames());
    expect(projected).toContain("synthetic");
    // 对照：重型文本列仍被排除（判据不是「恒真全集」）
    expect(projected).not.toContain("logs");
  });

  it("④ getExecutions 的行集与 where 都不按 synthetic 过滤（合成行照旧返回）", async () => {
    // 用真实实体元数据派生 select（与生产同一份代码路径），仓储替身返回
    // 一条 synthetic 行——列表必须把它原样带出来。
    const service = Object.create(TaskService.prototype) as Record<string, any>;
    const syntheticRow = {
      id: "exec-synthetic-1",
      taskId: "t-downstream",
      taskName: "report",
      status: ExecutionStatus.CANCELLED,
      synthetic: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    // 显式标注入参/返回类型：否则 jest.fn 会推断出空元组 []，mock.calls[0][0]
    // 变成索引越界的编译错误（TS2493）。
    const findAndCount = jest.fn(
      async (_opts?: Record<string, any>): Promise<[unknown[], number]> => [
        [syntheticRow],
        1,
      ],
    );
    const execRepo = {
      metadata: {
        columns: entityColumnNames().map((propertyName) => ({ propertyName })),
      },
      findAndCount,
    };
    service["execRepo"] = execRepo;

    const res = (await service["getExecutions"]("t-downstream", {
      page: 1,
      pageSize: 20,
    })) as { list: Array<Record<string, unknown>> };

    // 行照旧出现在列表里（synthetic 只是一列标记，不是过滤条件）
    expect(res.list).toHaveLength(1);
    expect(res.list[0]).toMatchObject({
      id: "exec-synthetic-1",
      status: ExecutionStatus.CANCELLED,
      synthetic: true,
    });
    const opts = findAndCount.mock.calls[0]![0] as Record<string, any>;
    // where 里不许出现 synthetic：可见性正是这些行存在的全部价值
    expect(opts["where"]).toEqual({ taskId: "t-downstream" });
    // 且 synthetic 确实被 SELECT 出来（否则前端只会看到 undefined 这一列）
    expect(opts["select"].synthetic).toBe(true);
  });
});

/**
 * S8：`synthetic` 的读面**只铺了 3 处**（依赖闸门两条查询 + triggerDependentTasks
 * 的别名哨兵），另外两处统计/筛选漏了——合成行不是「一次执行」，让它进入
 * 「最新执行」与「执行次数」会让两类读面同时说谎：
 *
 *  · ② `lastStatus` 筛的是「这个任务上次到底跑成什么样」。合成行从未运行，
 *    若它成了「最新执行」，`lastStatus=cancelled` 会筛出一个「上次其实成功」的
 *    任务——运维按「上次被取消」排查，而事实是「本轮因上游坏而没轮到」。
 *  · ③ `getExecutionStats` 的 total / 近 20 窗口是「执行次数」与「成功率」的
 *    分母。把从未执行的行算进去 ⇒ 次数虚高、成功率被稀释。
 *
 * ④（见 metrics.service.spec.ts）日报 cancelledCount 同病。
 *
 * ## 口径边界（本文件最重要的红线）
 *
 * 只改**统计/筛选**，绝不改**列表行集**：合成行留在 `getExecutions` /
 * `getAllExecutions` 的返回里，那是它存在的全部价值。下面的用例
 * 「③+⑤ 同一批行：统计 2 次 / 列表 3 行」就是这条红线的显式锚点。
 */
describe("S8 · 合成行不进统计/最新执行，但仍在列表里", () => {
  /** 让 TaskService 的私有方法可被真实调用（只注入仓储，不走 DI）。 */
  const makeService = (execRepo: Record<string, unknown>) =>
    Object.assign(Object.create(TaskService.prototype) as Record<string, any>, {
      execRepo,
    });

  const entityColumnNames = () =>
    getMetadataArgsStorage()
      .columns.filter((c) => c.target === TaskExecution)
      .map((c) => c.propertyName);

  const metadataStub = () => ({
    columns: entityColumnNames().map((propertyName) => ({ propertyName })),
  });

  /** 与 DB 等价的 where 求值：只建模本判据消费的两列（taskId / synthetic）。
   *  未给某键 ⇒ 不过滤（生产代码若把谓词删掉，用例据此变红）。 */
  const applyWhere = (
    rows: Array<Record<string, any>>,
    where?: Record<string, any>,
  ) => {
    if (!where) return rows;
    return rows.filter((row) => {
      if (where["taskId"] !== undefined && row["taskId"] !== where["taskId"]) {
        return false;
      }
      if (
        where["synthetic"] !== undefined &&
        row["synthetic"] !== where["synthetic"]
      ) {
        return false;
      }
      return true;
    });
  };

  /**
   * `findAllByLastStatus` 的 QB 桩：把 where/andWhere 的 SQL 文本按别名留档。
   * 求值交给下面的 evaluateExists——**只认本用例覆盖的条件形态**，出现未预期
   * 条件直接抛错，避免「替身悄悄放行」让删掉谓词的生产代码照样绿。
   */
  const makeLastStatusRepos = (rows: Array<Record<string, any>>) => {
    const qbs: Record<string, { alias: string; conds: string[] }> = {};
    const mkQb = (alias: string) => {
      const rec = { alias, conds: [] as string[] };
      qbs[alias] = rec;
      const qb: Record<string, any> = {
        select: () => qb,
        where: (sql: string) => (rec.conds.push(sql), qb),
        andWhere: (sql: string) => (rec.conds.push(sql), qb),
        orderBy: () => qb,
        addOrderBy: () => qb,
        limit: () => qb,
        skip: () => qb,
        take: () => qb,
        setParameters: () => qb,
        getParameters: () => ({}),
        getQuery: () => `[${alias}:${rec.conds.join(" & ")}]`,
        getManyAndCount: async () => [[], 0],
      };
      return qb;
    };
    const execRepo = { createQueryBuilder: jest.fn((a: string) => mkQb(a)) };
    const taskRepo = { createQueryBuilder: jest.fn((a: string) => mkQb(a)) };
    return { execRepo, taskRepo, qbs, rows };
  };

  /**
   * 按「被测代码真正拼出来的条件」求值 EXISTS：
   *   EXISTS( te: taskId=task, status=:lastStatus, id=(te2 最新行) )
   * 其中 te2 的「最新行」是否排除合成行，**由 te2 条件里有没有
   * `te2.synthetic = false` 决定**——这正是本用例要钉住的生产事实。
   */
  const evaluateExists = (
    rows: Array<Record<string, any>>,
    te2Conds: string[],
    teConds: string[],
    lastStatus: string,
  ): boolean => {
    const KNOWN = new Set([
      "te2.id",
      "te.taskId = task.id",
      "te2.taskId = task.id",
      "te2.synthetic = false",
      "te.synthetic = false",
      "te.status = :lastStatus",
      "task.status != :__deleted",
      "task.status = :__status",
    ]);
    for (const c of [...te2Conds, ...teConds]) {
      const isKnown =
        KNOWN.has(c) ||
        c.startsWith("te.id = (") ||
        c.includes("task.name ILIKE") ||
        c.includes("task.runtime") ||
        c.includes("task.projectId") ||
        c.includes("task.applicationId") ||
        c.includes("task.name ILIKE") ||
        c.startsWith("(task.name ILIKE") ||
        c.startsWith("EXISTS (");
      if (!isKnown) throw new Error(`未预期的查询条件：${c}`);
    }
    const honoursSyntheticOnLatest = te2Conds.includes("te2.synthetic = false");
    const pool = rows
      .filter((r) => r["taskId"] === "t1")
      .filter((r) => !honoursSyntheticOnLatest || r["synthetic"] !== true)
      .sort((a, b) => Number(b["createdAt"]) - Number(a["createdAt"]));
    const latest = pool[0];
    if (!latest) return false;
    if (!teConds.includes("te.status = :lastStatus")) return false;
    if (!teConds.some((c) => c.startsWith("te.id = ("))) return false;
    return latest["status"] === lastStatus;
  };

  // 下游任务 t1 的执行史（新 → 旧）：
  //   ★ 合成行：cancelled / synthetic=true（本轮上游失败，为可见性补的，**从未运行**）
  //   · 真实尝试：success（上一轮真的跑成功了）
  const downstreamRows = [
    {
      id: "e-syn",
      taskId: "t1",
      status: ExecutionStatus.CANCELLED,
      synthetic: true,
      createdAt: 3,
    },
    {
      id: "e-ok",
      taskId: "t1",
      status: ExecutionStatus.SUCCESS,
      synthetic: false,
      createdAt: 2,
    },
    {
      id: "e-fail",
      taskId: "t1",
      status: ExecutionStatus.FAILED,
      synthetic: false,
      createdAt: 1,
    },
  ];

  it("② lastStatus 的「最新执行」排除合成行：lastStatus=cancelled 不再命中「上次其实成功」的任务", async () => {
    const { execRepo, taskRepo, qbs } = makeLastStatusRepos(downstreamRows);
    const service = makeService(execRepo);
    (service as Record<string, any>)["taskRepo"] = taskRepo;

    await service["findAll"]({
      page: 1,
      pageSize: 10,
      lastStatus: ExecutionStatus.CANCELLED,
    });

    const te2 = qbs["te2"].conds;
    const te = qbs["te"].conds;
    // 生产事实：取最新行的子查询带 synthetic=false
    expect(te2).toContain("te2.synthetic = false");
    // 语义后果：这个任务的「最新执行」= 真实成功那次 ⇒ cancelled 筛选**不命中**
    expect(
      evaluateExists(downstreamRows, te2, te, ExecutionStatus.CANCELLED),
    ).toBe(false);
    // 对照：按 success 筛则命中（说明求值器不是恒 false）
    expect(
      evaluateExists(downstreamRows, te2, te, ExecutionStatus.SUCCESS),
    ).toBe(true);
    // 反证：若谓词缺席（旧实现），合成行会顶替最新执行 ⇒ cancelled **命中**（正是要修的错）
    expect(
      evaluateExists(
        downstreamRows,
        te2.filter((c) => c !== "te2.synthetic = false"),
        te,
        ExecutionStatus.CANCELLED,
      ),
    ).toBe(true);
  });

  it("② 对照：只有合成行 ⇒ 该任务没有任何「上次执行状态」，任何 lastStatus 都不命中", async () => {
    const onlySynthetic = [
      {
        id: "e-syn",
        taskId: "t1",
        status: ExecutionStatus.CANCELLED,
        synthetic: true,
        createdAt: 1,
      },
    ];
    const { execRepo, taskRepo, qbs } = makeLastStatusRepos(onlySynthetic);
    const service = makeService(execRepo);
    (service as Record<string, any>)["taskRepo"] = taskRepo;

    await service["findAll"]({
      page: 1,
      pageSize: 10,
      lastStatus: ExecutionStatus.CANCELLED,
    });
    expect(
      evaluateExists(
        onlySynthetic,
        qbs["te2"].conds,
        qbs["te"].conds,
        ExecutionStatus.CANCELLED,
      ),
    ).toBe(false);
  });

  /**
   * ③ + ⑤：同一批行，两个读面必须给出**相反**的答案。
   *   统计：2 次真实尝试（success + failed），合成行不算。
   *   列表：3 行，合成行照旧可见。
   */
  const statsRows = [
    {
      id: "e-syn",
      taskId: "t1",
      status: ExecutionStatus.CANCELLED,
      synthetic: true,
      createdAt: 3,
      duration: null,
    },
    {
      id: "e-ok",
      taskId: "t1",
      status: ExecutionStatus.SUCCESS,
      synthetic: false,
      createdAt: 2,
      duration: 100,
    },
    {
      id: "e-fail",
      taskId: "t1",
      status: ExecutionStatus.FAILED,
      synthetic: false,
      createdAt: 1,
      duration: 300,
    },
  ];

  /** getExecutionStats 的仓储桩：find / count / GROUP BY QB 全部**真的应用**谓词。 */
  const makeStatsRepo = (rows: Array<Record<string, any>>) => {
    const groupByConds: string[] = [];
    const qb: Record<string, any> = {
      select: () => qb,
      addSelect: () => qb,
      where: (sql: string) => (groupByConds.push(sql), qb),
      andWhere: (sql: string) => (groupByConds.push(sql), qb),
      groupBy: () => qb,
      getRawMany: async () => {
        // 只有生产代码把 `e.synthetic = false` 拼进来，合成行才被排除
        const honour = groupByConds.includes("e.synthetic = false");
        const map = new Map<string, number>();
        for (const r of rows) {
          if (honour && r["synthetic"] === true) continue;
          map.set(r["status"], (map.get(r["status"]) ?? 0) + 1);
        }
        return [...map].map(([status, count]) => ({
          status,
          count: String(count),
        }));
      },
    };
    return {
      qb,
      groupByConds,
      metadata: metadataStub(),
      find: jest.fn(async (opts: Record<string, any>) => {
        const matched = applyWhere(rows, opts["where"]).sort(
          (a, b) => Number(b["createdAt"]) - Number(a["createdAt"]),
        );
        return (
          opts["take"] ? matched.slice(0, opts["take"]) : matched
        ) as never;
      }),
      count: jest.fn(
        async (opts: Record<string, any>) =>
          applyWhere(rows, opts["where"]).length,
      ),
      createQueryBuilder: jest.fn(() => qb),
      findAndCount: jest.fn(async (opts: Record<string, any>) => {
        // 列表读面：**刻意不过滤** synthetic（行集由 where 决定，生产 where 不含它）
        const matched = applyWhere(rows, opts["where"]);
        return [matched, matched.length] as never;
      }),
    };
  };

  it("③ 任务统计 total / 近 20 窗口 / 成功率分母都不含合成行", async () => {
    const execRepo = makeStatsRepo(statsRows);
    const service = makeService(execRepo);

    const stats = await service["getExecutionStats"]("t1");

    // 分母：2 次真实尝试（不是 3）
    expect(stats.totalRuns).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.successRate).toBe(50); // 1/2，若把合成行算进分母会变 1/3=33.3
    // 近 20 窗口同样只装真实尝试
    expect(stats.recentExecutions.map((e: any) => e.id)).toEqual([
      "e-ok",
      "e-fail",
    ]);
    expect(stats.recentSuccessRate).toBe(50);
    expect(stats.avgDuration).toBe(200); // (100+300)/2

    // 查询层证据（替身据此求值，删谓词即变红）
    expect(execRepo.count).toHaveBeenCalledWith({
      where: { taskId: "t1", synthetic: false },
    });
    const findArg = execRepo.find.mock.calls[0]![0] as Record<string, any>;
    expect(findArg["where"]).toEqual({ taskId: "t1", synthetic: false });
    expect(execRepo.groupByConds).toContain("e.synthetic = false");
  });

  it("⑤ 同一批行：列表照样返回合成行（统计 2 次 / 列表 3 行）", async () => {
    const execRepo = makeStatsRepo(statsRows);
    const service = makeService(execRepo);

    const stats = await service["getExecutionStats"]("t1");
    const list = (await service["getExecutions"]("t1", {
      page: 1,
      pageSize: 20,
    })) as { list: Array<Record<string, any>>; total: number };

    // 统计：2；列表：3（合成行在里面，且合成行仍是 cancelled+synthetic）
    expect(stats.totalRuns).toBe(2);
    expect(list.list).toHaveLength(3);
    expect(list.list.map((r) => r.id)).toContain("e-syn");
    expect(list.list.find((r) => r.id === "e-syn")).toMatchObject({
      status: ExecutionStatus.CANCELLED,
      synthetic: true,
    });
    // 列表的 where 里**没有** synthetic——红线：可见性不许被统计修复顺手砍掉
    const opts = execRepo.findAndCount.mock.calls[0]![0] as Record<string, any>;
    expect(opts["where"]).toEqual({ taskId: "t1" });
    expect(opts["where"]).not.toHaveProperty("synthetic");
  });
});
