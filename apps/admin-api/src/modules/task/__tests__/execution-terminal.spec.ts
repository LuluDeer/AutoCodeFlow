import { ExecutionStatus } from "../entities/task-execution.entity";
import {
  OPEN_EXECUTION_STATUSES,
  TERMINAL_EXECUTION_STATUSES,
  isTerminalStatus,
  transitionOneToTerminal,
  transitionToTerminal,
} from "../execution-terminal";

/**
 * A1（DEEP_REVIEW 0ef3bbe §七）：终态跃迁入口的行为契约。
 *
 * 这里钉死的三件事，正是收口前 6 处手写 UPDATE 互相不一致的地方：
 *   ① 开放态门槛只有一份（常量不再是各处抄写的字面量）；
 *   ② RETURNING 行 = 唯一 winner（并发已终态的行不得再次释放槽位）；
 *   ③ 「驱动命中但未返回行」必须有快照兜底（批量恢复路径此前缺这一条，
 *      会在特定驱动下静默漏释放执行器槽位），且兜底**有界**——只能补全
 *      「命中数 == id 数」这种命名无歧义的情形，部分命中时宁可少释放也
 *      不编造 winner（编造会把未跃迁的行也算进去，超量释放更危险）。
 */

interface QbCall {
  patch: Record<string, unknown>;
  whereSql: string;
  params: Record<string, unknown>;
  returning: string[];
}

/** 构造一个能记录调用的 QueryBuilder 替身。 */
function makeRepo(result: { raw?: unknown; affected?: number }): {
  repo: { createQueryBuilder: jest.Mock };
  calls: QbCall[];
} {
  const calls: QbCall[] = [];
  const qb: Record<string, unknown> = {};
  const record: QbCall = {
    patch: {},
    whereSql: "",
    params: {},
    returning: [],
  };
  calls.push(record);

  qb.update = jest.fn(() => qb);
  qb.set = jest.fn((patch: Record<string, unknown>) => {
    record.patch = patch;
    return qb;
  });
  qb.where = jest.fn((sql: string, params: Record<string, unknown>) => {
    record.whereSql = sql;
    record.params = params;
    return qb;
  });
  qb.returning = jest.fn((cols: string[]) => {
    record.returning = cols;
    return qb;
  });
  qb.execute = jest.fn(async () => ({
    raw: result.raw ?? [],
    affected: result.affected ?? 0,
  }));

  const repo = { createQueryBuilder: jest.fn(() => qb) };
  return { repo: repo as unknown as { createQueryBuilder: jest.Mock }, calls };
}

const SUCCESS_PATCH = {
  status: ExecutionStatus.SUCCESS,
  endTime: new Date(0),
} as const;

describe("A1 执行终态跃迁（transitionToTerminal）", () => {
  it("常量：开放态 = pending/running，终态 = 其余五个，两者无交集", () => {
    expect([...OPEN_EXECUTION_STATUSES]).toEqual([
      ExecutionStatus.PENDING,
      ExecutionStatus.RUNNING,
    ]);
    expect([...TERMINAL_EXECUTION_STATUSES]).toEqual([
      ExecutionStatus.SUCCESS,
      ExecutionStatus.FAILED,
      ExecutionStatus.TIMEOUT,
      ExecutionStatus.KILLED,
      ExecutionStatus.CANCELLED,
    ]);
    for (const s of OPEN_EXECUTION_STATUSES) {
      expect(isTerminalStatus(s)).toBe(false);
    }
    for (const s of TERMINAL_EXECUTION_STATUSES) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it("门槛：条件带 status IN (开放态)，且 RETURNING 取 id 与 executorAddress", async () => {
    const { repo, calls } = makeRepo({ raw: [], affected: 0 });
    await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { ...SUCCESS_PATCH },
    });
    expect(calls[0].whereSql).toContain('"status" IN (:...gate)');
    expect(calls[0].params.gate).toEqual([
      ExecutionStatus.PENDING,
      ExecutionStatus.RUNNING,
    ]);
    expect(calls[0].returning).toEqual(["id", "executorAddress"]);
  });

  it("门槛可收窄（如 PENDING 超时回收只认 PENDING）", async () => {
    const { repo, calls } = makeRepo({ raw: [], affected: 0 });
    await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { status: ExecutionStatus.FAILED },
      from: [ExecutionStatus.PENDING],
    });
    expect(calls[0].params.gate).toEqual([ExecutionStatus.PENDING]);
  });

  it("winner 语义：只有 RETURNING 返回的行算发生跃迁（并发已终态的不重复释放）", async () => {
    const { repo } = makeRepo({
      raw: [{ id: "e1", executorAddress: "10.0.0.1:8002" }],
      affected: 1,
    });
    const res = await transitionToTerminal(repo as never, {
      ids: ["e1", "e2"],
      patch: { ...SUCCESS_PATCH },
    });
    expect(res.rows).toEqual([{ id: "e1", executorAddress: "10.0.0.1:8002" }]);
    expect(res.transitioned).toBe(true);
    // e2 不在 rows 里——它已被并发路径终态化，调用方据此不释放它的槽位
    expect(res.rows.map((r) => r.id)).not.toContain("e2");
  });

  it("驱动兜底：affected>0 但 RETURNING 为空时用快照补全（旧批量恢复路径缺这条）", async () => {
    const { repo } = makeRepo({ raw: [], affected: 2 });
    const res = await transitionToTerminal(repo as never, {
      ids: ["e1", "e2"],
      patch: { ...SUCCESS_PATCH },
      addressSnapshot: { e1: "10.0.0.1:8002", e2: null },
    });
    expect(res.rows).toEqual([
      { id: "e1", executorAddress: "10.0.0.1:8002" },
      { id: "e2", executorAddress: null },
    ]);
    expect(res.affected).toBe(2);
  });

  it("兜底有界：批次只命中一部分时绝不编造行（否则会超量释放槽位）", async () => {
    const { repo } = makeRepo({ raw: [], affected: 1 });
    const res = await transitionToTerminal(repo as never, {
      ids: ["e1", "e2", "e3"],
      patch: { ...SUCCESS_PATCH },
      addressSnapshot: { e1: "a1", e2: "a2", e3: "a3" },
    });
    // affected=1 < 3：无法判定是哪一条跃迁——编造 3 条会把 2 条没跃迁的行
    // 也算成 winner，调用方据其释放槽位即 runningTaskCount 被打成负数。
    expect(res.rows).toEqual([]);
    expect(res.affected).toBe(1);
    expect(res.transitioned).toBe(false);
  });

  it("无快照时兜底仍给出 id（地址 null），绝不静默丢行", async () => {
    const { repo } = makeRepo({ raw: [], affected: 1 });
    const res = await transitionToTerminal(repo as never, {
      ids: ["e9"],
      patch: { ...SUCCESS_PATCH },
    });
    expect(res.rows).toEqual([{ id: "e9", executorAddress: null }]);
  });

  it("归一化：raw 为单对象或含非字符串地址时不崩", async () => {
    const single = makeRepo({
      raw: { id: "e1", executorAddress: 42 },
      affected: 1,
    });
    expect(
      (
        await transitionToTerminal(single.repo as never, {
          ids: ["e1"],
          patch: { ...SUCCESS_PATCH },
        })
      ).rows,
    ).toEqual([{ id: "e1", executorAddress: null }]);

    const junk = makeRepo({ raw: [null, { noId: 1 }], affected: 1 });
    const res = await transitionToTerminal(junk.repo as never, {
      ids: ["e1"],
      patch: { ...SUCCESS_PATCH },
      addressSnapshot: { e1: "addr" },
    });
    expect(res.rows).toEqual([{ id: "e1", executorAddress: "addr" }]);
  });

  it("空 id 列表短路：不发 SQL", async () => {
    const { repo } = makeRepo({ raw: [], affected: 0 });
    const res = await transitionToTerminal(repo as never, {
      ids: [],
      patch: { ...SUCCESS_PATCH },
    });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(res).toEqual({ rows: [], affected: 0, transitioned: false });
  });

  it("防御：patch.status 非终态直接抛错（终态门只对终态有意义）", async () => {
    const { repo } = makeRepo({ raw: [], affected: 0 });
    await expect(
      transitionToTerminal(repo as never, {
        ids: ["e1"],
        patch: { status: ExecutionStatus.RUNNING },
      }),
    ).rejects.toThrow(/must be terminal/);
    await expect(
      transitionToTerminal(repo as never, {
        ids: ["e1"],
        patch: { status: ExecutionStatus.PENDING },
      }),
    ).rejects.toThrow(/must be terminal/);
  });

  it("单执行便捷入口 transitionOneToTerminal 与批量版语义一致", async () => {
    const { repo, calls } = makeRepo({
      raw: [{ id: "e1", executorAddress: "addr" }],
      affected: 1,
    });
    const res = await transitionOneToTerminal(repo as never, {
      id: "e1",
      patch: { ...SUCCESS_PATCH },
    });
    expect(calls[0].params.ids).toEqual(["e1"]);
    expect(res.rows).toEqual([{ id: "e1", executorAddress: "addr" }]);
  });

  it("事务：传入 manager 时用 manager 建 QB（复用事务连接）", async () => {
    const { repo, calls } = makeRepo({ raw: [], affected: 0 });
    const manager = {
      createQueryBuilder: jest.fn(() => repo.createQueryBuilder()),
    };
    await transitionToTerminal(repo as never, {
      ids: ["e1"],
      patch: { ...SUCCESS_PATCH },
      manager: manager as never,
    });
    expect(manager.createQueryBuilder).toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0);
  });
});
