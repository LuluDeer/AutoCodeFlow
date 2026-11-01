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
