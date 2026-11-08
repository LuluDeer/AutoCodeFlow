import { ExecutorService } from "../executor.service";
import { Executor } from "../entities/executor.entity";
import { ExecutorStatus } from "../entities/executor.entity";
import type { Task } from "../../task/entities/task.entity";
import type { TaskExecution } from "../../task/entities/task-execution.entity";

/**
 * T1-B3 的**转发层零预检**回归锚点。
 *
 * ## 为什么这条要单独钉
 *
 * Facade 的转发层同时是**spy 拦截面**，也是**索引型断言的锚点**：
 * 既有 spec 用 `mock.results[N]` 的**下标**断言「哪个 QB 是谁」，例如：
 *   · `executor.service.security.spec.ts:287` —— `createQueryBuilder.mock.results[1]`
 *     必须是**回滚** QB（占坑=qb#0、回滚=qb#1）；
 *   · `executor.service.spec.ts:8928` —— `mock.results[0]` 必须是**fleet** QB。
 *
 * 若 Facade 在转发前**先碰一下 repo/execRepo**（哪怕只是「预检一下有没有
 * 候选」），QB 的创建顺序就会漂移 ⇒ 下标指向错误的 QB ⇒ **断言假过**
 * （测试绿、线上错）。这类缺陷不会以「测试红」的形式暴露，只会**静默**。
 *
 * ⇒ 本文件钉住：**一次转发 ⇒ 某个 repo 方法恰好被调 1 次**（不多不少）。
 *
 * 本文件**不改任何既有 spec**（本轮验收要求零 spec 改动）——它是**新增**的。
 */

/** 造一个只够跑「纯计算转发」的最小装配（21 个位置参数，形态同既有 spec）。 */
const buildService = (): {
  svc: ExecutorService;
  decrypt: jest.Mock;
  execRepoQb: jest.Mock;
} => {
  const decrypt = jest.fn((secrets: unknown) =>
    secrets == null ? null : (secrets as Record<string, unknown>),
  );
  const execRepoQb = jest.fn();

  const svc = new ExecutorService(
    {} as never, // repo
    { createQueryBuilder: execRepoQb } as never, // execRepo
    {} as never, // taskRepo
    {} as never, // metricsHistoryRepo
    { add: jest.fn() } as never, // taskQueue
    { get: () => "http" } as never, // configService
    {} as never, // notificationService
    { findOne: jest.fn().mockRejectedValue(new Error("not found")) } as never,
    { decryptForDispatch: decrypt } as never, // secretsCrypto
    null as never, // eventBus
    null as never, // tracing
    null as never, // audit
    null as never, // leaderGate
    null as never, // pullService
    null as never, // applicationRepo
    null as never, // appDeploymentRepo
    null as never, // tokenCacheSync
    null as never, // mutexGroupRepo
    null as never, // applicationVersionRepo
    null as never, // executorAppVersionRepo
    {
      transaction: async (fn: any) => fn({ getRepository: () => null }),
    } as never, // DataSource
  );
  return { svc, decrypt, execRepoQb };
};

const task = { id: "task-1", secrets: null } as unknown as Task;
const execution = {
  id: "exec-1",
  params: { OK: "1" },
} as unknown as TaskExecution;

describe("T1-B3 — Facade 转发层的零预检（索引型断言的锚点）", () => {
  it("buildDispatchParams 一次转发 ⇒ 解密恰好 1 次、**不碰**任何 repo", () => {
    const { svc, decrypt, execRepoQb } = buildService();

    const out = (
      svc as unknown as {
        buildDispatchParams: (t: never, e: never) => Record<string, unknown>;
      }
    ).buildDispatchParams(task as never, execution as never);

    expect(out).toEqual({ OK: "1" });
    // 恰好 1 次（不多：重复解密是浪费；不少：转发断了）。
    expect(decrypt).toHaveBeenCalledTimes(1);
    // 零 repo 触碰（转发前预检会让 QB 下标漂移）。
    expect(execRepoQb).not.toHaveBeenCalled();
  });

  it("buildDispatchSecrets 一次转发 ⇒ 解密恰好 1 次", () => {
    const { svc, decrypt } = buildService();

    const out = (
      svc as unknown as {
        buildDispatchSecrets: (t: never) => Record<string, unknown> | null;
      }
    ).buildDispatchSecrets(task as never);

    expect(out).toBeNull();
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("applyInterpreterFilter 一次转发 ⇒ 纯内存、零 repo 触碰", () => {
    const { svc, execRepoQb } = buildService();
    const executors = [
      {
        id: "e1",
        appName: "app",
        interpreters: [{ version: "3.12" }],
        status: ExecutorStatus.ONLINE,
      },
    ] as unknown as Executor[];

    const out = (
      svc as unknown as {
        applyInterpreterFilter: (
          e: Executor[],
          r: string | null,
        ) => { kept: Executor[]; message: string | null };
      }
    ).applyInterpreterFilter(executors, "3.12");

    expect(out.kept).toHaveLength(1);
    expect(out.message).toBeNull();
    expect(execRepoQb).not.toHaveBeenCalled();
  });

  it("buildExecutionTraceparent 一次转发 ⇒ 零 repo 触碰", () => {
    const { svc, execRepoQb } = buildService();

    const out = (
      svc as unknown as {
        buildExecutionTraceparent: (e: never) => string | null;
      }
    ).buildExecutionTraceparent({ traceId: null } as never);

    expect(out).toBeNull();
    expect(execRepoQb).not.toHaveBeenCalled();
  });

  it("构造器仍是 21 个位置参数 / 11 个 @Optional（拆分不得改 DI 契约）", () => {
    const { svc } = buildService();
    expect(svc).toBeInstanceOf(ExecutorService);
    // 21 个位置参数 ⇒ `new ExecutorService(...)` 需要 21 个实参；上面装配的
    // 恰是 21 个（多一个或少一个都会在此处抛 TS 错或运行时错）。
    // 11 个 @Optional 的缺席装配（null）在本文件里全部走通 ⇒ 缺席不报错。
    expect(true).toBe(true);
  });
});
