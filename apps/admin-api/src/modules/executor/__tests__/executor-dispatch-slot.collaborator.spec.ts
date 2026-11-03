import { Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecutorDispatchSlot,
  type ExecutorDispatchSlotDeps,
} from "../executor-dispatch-slot.collaborator";
import type { Executor } from "../entities/executor.entity";
import type { TaskExecution } from "../../task/entities/task-execution.entity";

/**
 * T1-B3b 的独立单测（**不走 DI 装配**，`new ExecutorDispatchSlot({...})` 直构）。
 *
 * ## 这些用例钉住三件"错了会静默"的事
 *
 * 1. **占坑与补偿同 owner** —— 分属两个 owner 会出现「占坑了但补偿没回滚」
 *    （计数虚高 ⇒ 欠派）或「补偿了但占坑还在」（计数虚低 ⇒ 超派）。见下方
 *    「同 owner 不变量」段（**变异测试**：拆开必须红）。
 * 2. **锁序 组→执行器** —— 顺序反了会引入跨设备互斥的死锁（不是"清理代码"）。
 * 3. **补偿的条件带地址** —— 不带地址会在重试路径换候选后**误清新候选的标记**。
 */

/** 事务内 query 分发表：按 SQL 片段返回行/记录写操作。 */
interface TxQuery {
  sql: string;
  params?: unknown[];
}

/** 造一个最小 deps（可覆盖任意项）。 */
function makeDeps(over: Partial<ExecutorDispatchSlotDeps> = {}) {
  const txQueries: TxQuery[] = [];
  let lockRow: Record<string, unknown> | null = {
    address: "10.0.0.5:3002",
    status: "online",
    runningTaskCount: 3,
    maxConcurrentTasks: 10,
  };
  let occupancyCount = 0;

  const executorRepo = {
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    })),
  };
  const execRepo = {
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    })),
  };
  const mutexGroupRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: "group-1",
      name: "ziniao-browser",
      maxConcurrentPerDevice: 1,
    }),
  };
  const transaction = jest.fn(async (cb: (m: unknown) => unknown) => {
    const fakeManager = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        txQueries.push({ sql, params });
        if (sql.includes("FOR UPDATE")) {
          return lockRow ? [lockRow] : [];
        }
        if (sql.includes("COUNT(*)")) {
          return [{ count: occupancyCount }];
        }
        return [];
      }),
    };
    return cb(fakeManager);
  });

  const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const deps: ExecutorDispatchSlotDeps = {
    repo: executorRepo as never,
    execRepo: execRepo as never,
    mutexGroupRepo: mutexGroupRepo as never,
    dataSource: { transaction } as never,
    logger,
    ...over,
  };

  return {
    deps,
    txQueries,
    transaction,
    executorRepo,
    execRepo,
    mutexGroupRepo,
    setLockRow: (r: Record<string, unknown> | null) => {
      lockRow = r;
    },
    setOccupancy: (n: number) => {
      occupancyCount = n;
    },
  };
}

const candidate = {
  id: "exec-row-1",
  address: "10.0.0.5:3002",
  status: "online",
  runningTaskCount: 3,
  maxConcurrentTasks: 10,
  version: 7,
} as unknown as Executor;

const groupedExecution = {
  id: "exec-uuid-1",
  mutexGroupId: "group-1",
  status: "running",
} as unknown as TaskExecution;

describe("ExecutorDispatchSlot（T1-B3b 独立单测）", () => {
  describe("claimExecutorSlotForExecution", () => {
    it("无组执行走单条 UPDATE 路径（不开启事务，零行为变化）", async () => {
      const { deps, transaction, executorRepo } = makeDeps();
      const collab = new ExecutorDispatchSlot(deps);

      const outcome = await collab.claimExecutorSlotForExecution(candidate, {
        id: "exec-1",
        mutexGroupId: null,
      } as never);

      expect(outcome).toBe("claimed");
      expect(transaction).not.toHaveBeenCalled();
      expect(executorRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("挂组执行：占用未满 → 占坑并同事务落占用标记", async () => {
      const { deps, txQueries } = makeDeps();
      const collab = new ExecutorDispatchSlot(deps);

      const outcome = await collab.claimExecutorSlotForExecution(
        candidate,
        groupedExecution,
      );

      expect(outcome).toBe("claimed");
      const updates = () =>
        txQueries.filter(
          (q) => q.sql.includes("UPDATE") && !q.sql.includes("FOR UPDATE"),
        );
      const sqls = updates().map((q) => q.sql);
      expect(sqls.some((s) => s.includes('"executors"'))).toBe(true);
      // 占用标记：地址按锁内行值落库（COUNT 用地址入参一致）。
      const marker = updates().find((q) => q.sql.includes('"task_executions"'));
      expect(marker).toBeDefined();
      expect(marker!.params).toEqual([candidate.address, groupedExecution.id]);
    });

    it("锁序 组→执行器（固定锁序防死锁；顺序反了会跨设备死锁）", async () => {
      const { deps, txQueries, mutexGroupRepo } = makeDeps();
      mutexGroupRepo.findOne.mockResolvedValue({
        id: "group-1",
        name: "sso-site",
        maxConcurrentPerDevice: 1,
        scope: "global",
      });
      const collab = new ExecutorDispatchSlot(deps);

      await collab.claimExecutorSlotForExecution(candidate, groupedExecution);

      const groupLockIdx = txQueries.findIndex(
        (q) => q.sql.includes('"mutex_groups"') && q.sql.includes("FOR UPDATE"),
      );
      const execLockIdx = txQueries.findIndex(
        (q) => q.sql.includes('"executors"') && q.sql.includes("FOR UPDATE"),
      );
      expect(groupLockIdx).toBeGreaterThanOrEqual(0);
      expect(execLockIdx).toBeGreaterThan(groupLockIdx);
    });

    it("设备档（默认）：不发组行锁，占用判定带设备条件", async () => {
      const { deps, txQueries } = makeDeps();
      const collab = new ExecutorDispatchSlot(deps);

      await collab.claimExecutorSlotForExecution(candidate, groupedExecution);

      expect(
        txQueries.some(
          (q) =>
            q.sql.includes('"mutex_groups"') && q.sql.includes("FOR UPDATE"),
        ),
      ).toBe(false);
      const occ = txQueries.find((q) => q.sql.includes("COUNT(*)"))!;
      expect(occ.sql).toContain('"executorAddress"');
      expect(occ.params).toEqual([
        candidate.address,
        groupedExecution.mutexGroupId,
      ]);
    });

    it("全局档：占用判定不带设备条件且排除执行自身行", async () => {
      const { deps, txQueries, mutexGroupRepo } = makeDeps();
      mutexGroupRepo.findOne.mockResolvedValue({
        id: "group-1",
        name: "sso-site",
        maxConcurrentPerDevice: 1,
        scope: "global",
      });
      const collab = new ExecutorDispatchSlot(deps);

      await collab.claimExecutorSlotForExecution(candidate, groupedExecution);

      const occ = txQueries.find((q) => q.sql.includes("COUNT(*)"))!;
      expect(occ.sql).not.toContain('"executorAddress"');
      expect(occ.sql).toContain('"id" <> $2');
      expect(occ.params).toEqual([
        groupedExecution.mutexGroupId,
        groupedExecution.id,
      ]);
    });

    it("组占用已满 → mutex_full（不占坑、不落标记）", async () => {
      const { deps, txQueries, setOccupancy } = makeDeps();
      setOccupancy(1);
      const collab = new ExecutorDispatchSlot(deps);

      const outcome = await collab.claimExecutorSlotForExecution(
        candidate,
        groupedExecution,
      );

      expect(outcome).toBe("mutex_full");
      expect(
        txQueries.filter(
          (q) => q.sql.includes("UPDATE") && !q.sql.includes("FOR UPDATE"),
        ),
      ).toHaveLength(0);
    });

    it("设备离线 → unavailable", async () => {
      const { deps, setLockRow } = makeDeps();
      setLockRow({
        address: candidate.address,
        status: "offline",
        runningTaskCount: 3,
        maxConcurrentTasks: 10,
      });
      const collab = new ExecutorDispatchSlot(deps);

      const outcome = await collab.claimExecutorSlotForExecution(
        candidate,
        groupedExecution,
      );
      expect(outcome).toBe("unavailable");
    });

    it("设备容量已满 → unavailable（容量闸先于占用闸）", async () => {
      const { deps, txQueries, setLockRow } = makeDeps();
      setLockRow({
        address: candidate.address,
        status: "online",
        runningTaskCount: 10,
        maxConcurrentTasks: 10,
      });
      const collab = new ExecutorDispatchSlot(deps);

      const outcome = await collab.claimExecutorSlotForExecution(
        candidate,
        groupedExecution,
      );
      expect(outcome).toBe("unavailable");
      expect(txQueries.find((q) => q.sql.includes("COUNT(*)"))).toBeUndefined();
    });

    it("组已被删除 → 降级为无组语义（不阻断派发）", async () => {
      const { deps, transaction, mutexGroupRepo } = makeDeps();
      mutexGroupRepo.findOne.mockResolvedValue(null);
      const collab = new ExecutorDispatchSlot(deps);

      const outcome = await collab.claimExecutorSlotForExecution(
        candidate,
        groupedExecution,
      );
      expect(outcome).toBe("claimed");
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe("compensateClaimedSlot", () => {
    it("减槽用 GREATEST(count-1, 0) 且按 id 限定（防负、防误减）", async () => {
      const { deps, executorRepo } = makeDeps();
      const collab = new ExecutorDispatchSlot(deps);

      await collab.compensateClaimedSlot(
        { id: "exec-1", mutexGroupId: null } as never,
        "e1",
        "10.0.0.5:3002",
      );

      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      const qb = executorRepo.createQueryBuilder.mock.results[0].value;
      // 减槽是**数据库侧表达式**（SQL 函数），不是字面量——断言其 SQL 形态。
      const setArg = qb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(typeof setArg.runningTaskCount).toBe("function");
      expect(String(setArg.runningTaskCount)).toContain(
        'GREATEST("runningTaskCount" - 1, 0)',
      );
      expect(qb.where).toHaveBeenCalledWith("id = :id", { id: "e1" });
    });

    it("挂组执行：清占用标记且**条件带地址**（重试换候选时不误清新标记）", async () => {
      const { deps, execRepo } = makeDeps();
      const collab = new ExecutorDispatchSlot(deps);

      await collab.compensateClaimedSlot(
        { id: "exec-1", mutexGroupId: "group-1" } as never,
        "e1",
        "10.0.0.5:3002",
      );

      expect(execRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      const qb = execRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.set).toHaveBeenCalledWith({ executorAddress: null });
      expect(qb.where).toHaveBeenCalledWith("id = :id", { id: "exec-1" });
      expect(qb.andWhere).toHaveBeenCalledWith("executorAddress = :addr", {
        addr: "10.0.0.5:3002",
      });
    });

    it("无组执行：不碰执行行仓库（不产生无谓写）", async () => {
      const { deps, execRepo } = makeDeps();
      const collab = new ExecutorDispatchSlot(deps);

      await collab.compensateClaimedSlot(
        { id: "exec-1", mutexGroupId: null } as never,
        "e1",
        "10.0.0.5:3002",
      );

      expect(execRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe("同 owner 不变量（变异测试锚点）", () => {
    it("占坑与补偿声明在**同一个类**（拆开 ⇒ 本用例红）", () => {
      // 这条不变量的**结构**形态：两个方法必须是同一个类的成员。
      // 若有人把补偿拆到另一个协作者，本用例立刻红。
      const source = readFileSync(
        join(__dirname, "..", "executor-dispatch-slot.collaborator.ts"),
        "utf-8",
      );

      // ① 两个方法都在本文件里。
      expect(source).toContain("claimExecutorSlotForExecution");
      expect(source).toContain("compensateClaimedSlot");

      // ② 本文件里**只有一个 class**（两个方法必须同属它）。
      const classCount = (source.match(/^export class /gm) ?? []).length;
      expect(classCount).toBe(1);

      // ③ Facade 侧：占坑转发与补偿转发**都**指向 `this.dispatchSlot`
      //    （同一个协作者实例 ⇒ 同一个 owner）。
      const svc = readFileSync(
        join(__dirname, "..", "executor.service.ts"),
        "utf-8",
      );
      const claimForward = svc.match(
        /return this\.dispatchSlot\.claimExecutorSlotForExecution\(/,
      );
      const compensateForward = svc.match(
        /await this\.dispatchSlot\.compensateClaimedSlot\(/,
      );
      expect(claimForward).not.toBeNull();
      expect(compensateForward).not.toBeNull();
      // 不得出现「补偿走了别的协作者」的形态。
      expect(svc).not.toMatch(
        /this\.(?!dispatchSlot)\w*[Ss]lot\w*\.compensate/,
      );
    });
  });
});
