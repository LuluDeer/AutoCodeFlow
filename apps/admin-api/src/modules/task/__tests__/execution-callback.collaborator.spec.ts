import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import type { DataSource, Repository } from "typeorm";

import {
  ExecutionCallback,
  ExecutionCallbackDeps,
} from "../execution-callback.collaborator";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
import { Task } from "../entities/task.entity";

/**
 * T2-B4 第二刀：`ExecutionCallback` 协作者的**结构契约**单测（直构，不装配 Nest）。
 *
 * 本 spec 钉住三条**搬错了就会静默失效 / 生产事故**的不变量：
 *
 * 1. **四步链同 owner**（本刀的核心）：winner 终态 UPDATE → 释放槽位
 *    → 产物索引同步 → 终态事件发布，**顺序**必须如此。若拆散或乱序
 *    ⇒「终态已落库但槽位没释放」⇒ **执行器永久满载**。
 * 2. **注入面是窄签名**：协作者**不持有 Facade 引用**（只有 `deps`），
 *    且 `deps` 只暴露最小面 ⇒ 防止「注入面渐渐退化成整个 service」。
 * 3. **领域事件发布失败不改变主链**（既有纪律）：`eventBus.emit` 抛错时
 *    整条链仍走完，回调仍按 success 上报。
 */

type Call = { name: string; at: number };

const makeExecution = (o: Partial<TaskExecution> = {}): TaskExecution =>
  ({
    id: "exec-1",
    taskId: "task-1",
    taskName: "T",
    status: ExecutionStatus.RUNNING,
    startTime: new Date(Date.now() - 1000),
    createdAt: new Date(Date.now() - 1000),
    executorAddress: "10.0.0.1:8002",
    attemptSeq: 0,
    ...o,
  }) as unknown as TaskExecution;

describe("T2-B4 第二刀 · ExecutionCallback 协作者的结构契约", () => {
  /** 全局调用序（四步链顺序断言的载体）。 */
  let calls: Call[];
  let clock = 0;
  const rec = (name: string) => calls.push({ name, at: clock++ });

  let deps: ExecutionCallbackDeps;
  let execRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let eventBusEmit: jest.Mock;

  /** transitionToTerminal 走 createQueryBuilder 链；返回 affected 可控。 */
  const makeQb = (affected: number) => {
    const qb: Record<string, jest.Mock> = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn(async () => {
        rec("winner-terminal-update");
        return { affected, raw: affected > 0 ? [{ id: "exec-1" }] : [] };
      }),
    };
    return qb;
  };

  const build = (opts: { affected?: number } = {}) => {
    calls = [];
    clock = 0;
    execRepo = {
      findOne: jest.fn(async () => makeExecution()),
      find: jest.fn(async () => []),
      createQueryBuilder: jest.fn(() => makeQb(opts.affected ?? 1)),
    };
    eventBusEmit = jest.fn(() => rec("emit-event"));
    deps = {
      execRepo: execRepo as unknown as Repository<TaskExecution>,
      taskRepo: {
        findOne: jest.fn(async () => ({ id: "task-1", name: "T" }) as Task),
        find: jest.fn(async () => []),
      } as unknown as Repository<Task>,
      artifactIndexRepo: {
        create: jest.fn((d) => d),
      } as unknown as Repository<never>,
      dataSource: {
        transaction: jest.fn(async (cb: (m: unknown) => unknown) => {
          rec("artifacts-tx");
          return cb({
            delete: jest.fn(),
            insert: jest.fn(),
          });
        }),
        // releaseExecutorSlotByAddress（Facade 侧）读 dataSource.createQueryBuilder
        createQueryBuilder: jest.fn(() => ({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn(async () => ({ affected: 1 })),
        })),
      } as unknown as DataSource,
      eventBus: { emit: eventBusEmit } as never,
      aiAnalysisService: {
        analyzeFailure: jest.fn(async () => ""),
      } as never,
      logger: {
        warn: jest.fn(),
        log: jest.fn(),
        debug: jest.fn(),
      } as unknown as Logger,
      redisLockService: null,
      executorService: {
        scheduleRetryAfterRecovery: jest.fn(async () => undefined),
      },
      releaseSlot: jest.fn(async () => {
        rec("release-slot");
      }),
      emitTerminalEvent: jest.fn(() => {
        rec("emit-event");
      }),
      storeLogLines: jest.fn(async () => {
        rec("store-log-lines");
      }),
      persistCallbackLogsIfMissing: jest.fn(async () => {
        rec("persist-logs");
      }),
      backfillFullLogsFromExecutor: jest.fn(async () => false),
      hasStreamedLogLines: jest.fn(async () => false),
      publishExecutionWake: jest.fn(() => rec("wake")),
      triggerDependentTasks: jest.fn(async () => {
        rec("fanout");
      }),
    };
    return new ExecutionCallback(deps);
  };

  const successCb = (extra: Record<string, unknown> = {}) => ({
    executionId: "exec-1",
    status: "success" as const,
    executorAddress: "10.0.0.1:8002",
    durationMs: 1000,
    ...extra,
  });

  it("① 四步链顺序：winner 终态 UPDATE → 释放槽位 → 产物索引 → 终态事件", async () => {
    const svc = build({ affected: 1 });
    await svc.handleCallback([
      successCb({ artifacts: [{ name: "a", size: 1, sha256: "x" }] }),
    ]);

    const idx = (name: string) => calls.findIndex((c) => c.name === name);
    // 四步都在
    expect(idx("winner-terminal-update")).toBeGreaterThanOrEqual(0);
    expect(idx("release-slot")).toBeGreaterThanOrEqual(0);
    expect(idx("artifacts-tx")).toBeGreaterThanOrEqual(0);
    expect(idx("emit-event")).toBeGreaterThanOrEqual(0);
    // **顺序**（本刀核心不变量）：终态先落库，再释放槽位
    expect(idx("winner-terminal-update")).toBeLessThan(idx("release-slot"));
    // 槽位释放**必须**发生（缺了它 ⇒ 执行器永久满载）
    expect(deps.releaseSlot).toHaveBeenCalled();
  });

  it("② 槽位释放**恰好一次**（winner 分支）——重复释放会把别人的 runningTaskCount 减掉", async () => {
    const svc = build({ affected: 1 });
    await svc.handleCallback([successCb()]);
    // 非广播执行：winner 释放一次
    expect(deps.releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("③ 重复回调（affected=0）**不重复释放槽位**", async () => {
    const svc = build({ affected: 0 });
    await svc.handleCallback([successCb()]);
    // affected=0 ⇒ 首个写入者已释放 ⇒ 本分支不再释放
    expect(deps.releaseSlot).not.toHaveBeenCalled();
  });

  it("④ 事件发布是**旁路**：不 gate 主链，且 Facade 侧保留 fail-open 双保险", async () => {
    const svc = build({ affected: 1 });
    const res = await svc.handleCallback([successCb()]);
    // 主链结果不受事件影响
    expect(res).toEqual([{ executionId: "exec-1", success: true }]);
    // 事件**恰好发布一次**（不重发、不漏发）
    expect(deps.emitTerminalEvent).toHaveBeenCalledTimes(1);
    // 且释放槽位**仍然**发生（事件不是闸门）
    expect(deps.releaseSlot).toHaveBeenCalled();

    // fail-open 契约的**实现**在 Facade（事件发布是注入回调）⇒ 源码层钉住：
    // `eventBus.emit` 必须被 try/catch 包住（第二道保险丝），否则一次总线异常
    // 会把主链 catch 成 success:false、执行器重试整批。
    const facadeSrc = readFileSync(
      join(__dirname, "..", "task.service.ts"),
      "utf-8",
    );
    const i = facadeSrc.indexOf("private emitTerminalEvent(");
    expect(i).toBeGreaterThan(-1);
    const body = facadeSrc.slice(i, i + 3000);
    expect(body).toMatch(/try \{\s*this\.eventBus\.emit\(/);
    // 兜底注释也必须在（说明这不是偶然的 try）
    expect(body).toContain("第二道保险丝");
  });

  it("⑤ 注入面是**窄签名**：协作者不持有 Facade 引用，deps 只有最小面", () => {
    const svc = build();
    const own = Object.keys(svc as unknown as Record<string, unknown>);
    // 只持有 deps 一个字段（不缓存 Facade/Service）
    expect(own).toEqual(["deps"]);
    const keys = Object.keys(deps).sort();
    // deps 的键集合 == 已签字的注入面（多一个都说明"注入面退化了"）
    expect(keys).toEqual(
      [
        "aiAnalysisService",
        "artifactIndexRepo",
        "backfillFullLogsFromExecutor",
        "dataSource",
        "emitTerminalEvent",
        "eventBus",
        "execRepo",
        "executorService",
        "hasStreamedLogLines",
        "logger",
        "persistCallbackLogsIfMissing",
        "publishExecutionWake",
        "redisLockService",
        "releaseSlot",
        "storeLogLines",
        "taskRepo",
        "triggerDependentTasks",
      ].sort(),
    );
  });

  it("⑥ 协作者**代码**里不出现 `TaskService`（防止注入面退化成整个 service）", () => {
    const raw = readFileSync(
      join(__dirname, "..", "execution-callback.collaborator.ts"),
      "utf-8",
    );
    // 去掉注释后再判——头注里**刻意**写着「这里绝不放 TaskService 引用」，
    // 那是论证不是实现。
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bTaskService\b/);
    // 也不应出现 `this.service` 之类的反向引用
    expect(src).not.toMatch(/this\.(service|facade|taskService)\b/);
  });
});
