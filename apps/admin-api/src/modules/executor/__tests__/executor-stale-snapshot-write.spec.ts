/**
 * R51-A1（ADR-026 规则 4 · 整行 save 清理）：**陈旧快照整行回写**的并发交错实证。
 *
 * 这两条用例证明的不是"某行代码不好看"，而是一条可复现的数据丢失链：
 *   ① 方法早期 `findOne` 拿到快照 S；
 *   ② 另一写者（另一个实例 / 另一个请求 / 同进程的 sweep 定时器）在「读之后、写之前」
 *      把新事实落库（status → OFFLINE、runningTaskCount 原子 +1/-1、cpu 刷新…）；
 *   ③ 整行 `save(S)`：TypeORM 的 save 是「读当前行 → **按列 diff** → 只写有差异的列」，
 *      于是快照里过期的列与当前行**不相等** ⇒ 被判定成"改动"写回 ⇒ 覆盖 ②。
 *
 * 为什么假仓库要模拟 TypeORM 的 diff 语义（ADR-027 第三次教训：测试替身保真）：
 * 若假仓库写成"整体覆盖"，用例在**改造前也会通过**吗——不会，但它会同时放过
 * "只写一列"与"写很多列但恰好值相同"的差别，红点归因会指向错误的原因。差分保真让
 * 红点的唯一成因是"过期的列被 diff 判成改动"，与真实 PG 上的行为一致
 * （`select: false` 的列不进快照 ⇒ undefined ⇒ diff 跳过，这条也与真实一致）。
 */
import * as bcrypt from "bcrypt";
import { ExecutorService } from "../executor.service";

type Row = Record<string, unknown>;

/**
 * TypeORM 语义**差分保真**的 Executor 仓库替身：
 * - `findOne` 返回**快照副本**（等价于一次 SELECT；select:false 的列不在快照里）；
 * - `save(entity)`：先读当前行，再按列 diff，**只写有差异的列**（= 整行回写的真实机制）；
 * - `update(criteria, patch)`：只写 patch 里的列（= `UPDATE … SET <列清单>`）。
 * - `afterRead`：并发写者的注入点——在"读完、写之前"把新事实落进 store。
 */
class DiffAwareExecutorRepo {
  store: Row;
  saveCalls: Row[] = [];
  updateCalls: Array<{ criteria: Row; patch: Row }> = [];
  afterRead: (() => void) | null = null;

  constructor(initial: Row) {
    this.store = { ...initial };
  }

  private takeSnapshot(): Row {
    const snap = { ...this.store };
    // 「读之后、写之前」的交错点：另一写者在此刻落库。
    this.afterRead?.();
    return snap;
  }

  findOne = jest.fn(async (_args?: unknown) => this.takeSnapshot());

  find = jest.fn(async () => []);

  create = jest.fn((x: Row) => x);

  /** TypeORM save：读当前行 → 按列 diff → 只写差异列。 */
  save = jest.fn(async (entity: Row) => {
    this.saveCalls.push(entity);
    for (const [k, v] of Object.entries(entity)) {
      // undefined = 该列不参与 diff（select:false 列/被 delete 的键的真实表现）。
      if (v === undefined) continue;
      if (JSON.stringify(v) !== JSON.stringify(this.store[k])) {
        this.store[k] = v;
      }
    }
    return entity;
  });

  /** `UPDATE … SET <patch 列>`（带 where 谓词，不命中即 affected=0）。 */
  update = jest.fn(async (criteria: Row, patch: Row) => {
    this.updateCalls.push({ criteria, patch });
    const matched = Object.entries(criteria).every(([k, v]) => {
      const op = v as { _type?: string; _value?: unknown };
      if (op && typeof op === "object" && op._type === "isNull") {
        return this.store[k] === null || this.store[k] === undefined;
      }
      return this.store[k] === v;
    });
    if (!matched) return { affected: 0 };
    Object.assign(this.store, patch);
    return { affected: 1 };
  });

  createQueryBuilder = jest.fn(() => ({
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(async () => this.takeSnapshot()),
    getMany: jest.fn(async () => [this.takeSnapshot()]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  }));
}

const D0 = new Date("2026-01-01T00:00:00.000Z");
const D1 = new Date("2026-01-01T00:05:00.000Z");

/** 一行"活的"执行器：常规列全部有值（select:false 的 tokenHash 例外，与真实一致）。 */
const mkRow = (over: Row = {}): Row => ({
  id: "e1",
  appName: "node-a",
  address: "10.0.0.9:3002",
  type: "node",
  status: "online",
  runningTaskCount: 0,
  totalTaskCount: 4,
  failedTaskCount: 0,
  cpuUsage: 5,
  memUsage: 10,
  diskUsage: 20,
  lastHeartbeat: D0,
  offlineReason: null,
  consecutiveHeartbeatMisses: 0,
  groupName: "prod",
  tags: ["a"],
  description: "d",
  maxConcurrentTasks: 2,
  capabilities: ["python"],
  interpreters: [{ version: "3.12" }],
  deviceFingerprint: "a".repeat(64),
  dispatchMode: "push",
  executorStartupId: "startup-1",
  executorStartedAt: D0,
  version: 1,
  ...over,
});

const makeService = (repo: DiffAwareExecutorRepo): ExecutorService => {
  const svc = new ExecutorService(
    repo as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { create: jest.fn((x: unknown) => x), save: jest.fn(async (x: unknown) => x) } as never,
    {} as never,
    { get: jest.fn() } as never,
    {
      notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
      notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
      notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
    } as never,
    {} as never,
    { decryptForDispatch: jest.fn(() => null) } as never,
  );
  jest.spyOn(svc["logger"], "log").mockImplementation(() => undefined);
  jest.spyOn(svc["logger"], "warn").mockImplementation(() => undefined);
  jest.spyOn(svc["logger"], "error").mockImplementation(() => undefined);
  return svc;
};

describe("R51-A1 · rotateToken：轮换不得拿陈旧快照整行回写（ADR-026 规则 4）", () => {
  it("轮换窗口内并发落库的 status / runningTaskCount / lastHeartbeat 不被回滚", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);
    // 交错点：findOne 读完之后、写之前，sweep 判定失联（OFFLINE）且派发原子 +7
    // （bcrypt cost 12 的 await 是数百毫秒的真实窗口）。
    repo.afterRead = () => {
      repo.store.status = "offline";
      repo.store.runningTaskCount = 7;
      repo.store.lastHeartbeat = D1;
    };

    await svc.rotateToken("e1");

    // 轮换只该动 tokenHash 一列；并发写者的三个新事实必须原样存活。
    expect(repo.store.status).toBe("offline");
    expect(repo.store.runningTaskCount).toBe(7);
    expect(repo.store.lastHeartbeat).toBe(D1);
  });

  it("仍然把新哈希落库（且只写这一列）——不许把改动做成「什么都不写」", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);

    await svc.rotateToken("e1");

    expect(String(repo.store.tokenHash)).toMatch(/^\$2[aby]\$/);
    expect(repo.updateCalls).toHaveLength(1);
    expect(Object.keys(repo.updateCalls[0].patch)).toEqual(["tokenHash"]);
    expect(repo.updateCalls[0].criteria).toEqual({ id: "e1" });
    // 整行回写已消除：save 零调用（否则 diff 会把上面整行都写一遍）。
    expect(repo.saveCalls).toHaveLength(0);
  });

  it("哈希与落库值一致（不是写了个别的串）", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);
    const { token } = await svc.rotateToken("e1");
    await expect(
      bcrypt.compare(token, String(repo.store.tokenHash)),
    ).resolves.toBe(true);
  });
});

describe("R51-A1 · update：PATCH 只许写 4 个元数据列（ADR-026 规则 4）", () => {
  it("PATCH 期间并发落库的 status / runningTaskCount / cpuUsage 不被回滚", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);
    repo.afterRead = () => {
      repo.store.status = "offline";
      repo.store.runningTaskCount = 3;
      repo.store.cpuUsage = 91;
    };

    await svc.update("e1", { groupName: "staging" });

    expect(repo.store.groupName).toBe("staging");
    expect(repo.store.status).toBe("offline");
    expect(repo.store.runningTaskCount).toBe(3);
    expect(repo.store.cpuUsage).toBe(91);
  });

  it("只写调用方给的字段：未提供的 tags/description 不被擦、也不进 patch", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);

    const result = await svc.update("e1", { maxConcurrentTasks: 8 });

    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0].patch).toEqual({ maxConcurrentTasks: 8 });
    expect(repo.updateCalls[0].criteria).toEqual({ id: "e1" });
    expect(repo.store.tags).toEqual(["a"]);
    expect(repo.store.description).toBe("d");
    expect(repo.store.maxConcurrentTasks).toBe(8);
    // 返回值仍是"合并后的实体"，既有调用方（controller 回包）语义不变。
    expect(result.maxConcurrentTasks).toBe(8);
    expect(result.groupName).toBe("prod");
    expect(repo.saveCalls).toHaveLength(0);
  });

  it("显式 null 清空上限：null 必须进 patch（不能被当成「未提供」）", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);

    await svc.update("e1", { maxConcurrentTasks: null });

    expect(repo.updateCalls[0].patch).toEqual({ maxConcurrentTasks: null });
    expect(repo.store.maxConcurrentTasks).toBeNull();
  });

  it("没有任何可写字段时不发写请求（空 patch 不该产生一条 SET）", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);

    await svc.update("e1", {});

    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.saveCalls).toHaveLength(0);
  });

  it("非法 maxConcurrentTasks 仍然 400 且零写入（A-5 语义不变）", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);

    await expect(
      svc.update("e1", { maxConcurrentTasks: 0 }),
    ).rejects.toThrow();

    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.saveCalls).toHaveLength(0);
    expect(repo.store.maxConcurrentTasks).toBe(2);
  });
});

describe("R53-A1 · heartbeat：整行 save → 「实际采纳字段」的正向白名单（ADR-026 规则 4）", () => {
  /**
   * 上一轮 R51-A1 登记的最后一处整行回写：heartbeat 入口 findOne 拿快照，跨多个
   * await 后就地改若干字段再 `save(e)`。原注释只为 runningTaskCount 的 ±1 偏差
   * 辩护（「下一个心跳会自纠正」），却**没辩护**那些「由 register / 管理台拥有、
   * 心跳永不自纠正」的列——整行 save 会把它们按快照写回，管理台刚改的配置
   * 「随机回弹一次」，而且因为心跳不自纠正，会一直错到下一次 register。
   *
   * 本组用例用差分保真假仓库（findOne 给快照副本、save 按列 diff、update 只写
   * patch、afterRead 注入并发写者）钉住两条对称的性质：
   *   ① 心跳**不拥有**的列，窗口内被别人改了就绝不能被回弹；
   *   ② 心跳**拥有**的列必须照常落库（不许把修复做成「什么都不写」）。
   */
  it("窗口内管理台改了 groupName/tags/description/maxConcurrentTasks → 心跳不得回弹", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);
    // 交错点：findOne 读完快照之后、update 落库之前，管理台 PATCH 落了一批新事实。
    repo.afterRead = () => {
      repo.store.groupName = "staging";
      repo.store.tags = ["b"];
      repo.store.description = "new description";
      repo.store.maxConcurrentTasks = 16;
    };

    const saved = await svc.heartbeat("10.0.0.9:3002", { cpuUsage: 42 });

    // ① 管理台的四列原样存活（这正是整行 save 会把它们 diff 回旧值的地方）。
    expect(repo.store.groupName).toBe("staging");
    expect(repo.store.tags).toEqual(["b"]);
    expect(repo.store.description).toBe("new description");
    expect(repo.store.maxConcurrentTasks).toBe(16);
    // ①b 返回值 = 「读到的快照 + 本次 patch」，**不重新 findOne**（多一次往返，
    //     且可能读到别人的并发写，返回体/事件就会描述一个本次心跳没写的状态）。
    //     故非心跳拥有的列在返回体里仍是快照值；权威值以 DB（上面四条）为准。
    //     这里钉住「返回体不崩、且心跳拥有的列已更新」。
    expect(saved.groupName).toBe("prod");
    expect(saved.id).toBe("e1");
    expect(saved.cpuUsage).toBe(42);
    expect(saved.status).toBe("online");
    expect(saved.lastHeartbeat).toBeInstanceOf(Date);
    // ② 心跳确实落了库（修复不许变成"什么都不写"）。
    expect(repo.store.cpuUsage).toBe(42);
    // ③ 写面唯一：一次列级 update，整行 save 零调用。
    expect(repo.saveCalls).toHaveLength(0);
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0].criteria).toEqual({ id: "e1" });
  });

  it("register 拥有的列（appName/capabilities/dispatchMode/版本）同样不被回弹", async () => {
    const repo = new DiffAwareExecutorRepo(
      mkRow({ capabilities: ["python"], dispatchMode: "push", executorVersion: "1.0.0" }),
    );
    const svc = makeService(repo);
    repo.afterRead = () => {
      repo.store.appName = "node-renamed";
      repo.store.capabilities = ["python", "node"];
      repo.store.dispatchMode = "pull";
      repo.store.executorVersion = "2.0.0";
      repo.store.protocolVersion = 3;
      repo.store.type = "universal";
    };

    await svc.heartbeat("10.0.0.9:3002", { runningTaskCount: 3 });

    expect(repo.store.appName).toBe("node-renamed");
    expect(repo.store.capabilities).toEqual(["python", "node"]);
    expect(repo.store.dispatchMode).toBe("pull");
    expect(repo.store.executorVersion).toBe("2.0.0");
    expect(repo.store.protocolVersion).toBe(3);
    expect(repo.store.type).toBe("universal");
    expect(repo.store.runningTaskCount).toBe(3);
  });

  it("patch 的键集合 ⊆ 心跳白名单（任何「顺手带上的旧值」都写不进去）", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);

    await svc.heartbeat("10.0.0.9:3002", {
      cpuUsage: 1,
      memUsage: 2,
      diskUsage: 3,
      networkLatency: 4,
      runningTaskCount: 5,
      totalTaskCount: 6,
      failedTaskCount: 7,
      maxConcurrentTasks: 9,
      deadLetterCount: 8,
      runningExecutionIds: ["x"],
      reservedSlots: 1,
      interpreters: [{ version: "3.12" }],
      deviceFingerprint: "a".repeat(64),
      startupId: "startup-2",
      restartedAt: D0,
    });

    const patch = repo.updateCalls[0].patch;
    const owned = new Set([
      "address", "status", "offlineReason", "consecutiveHeartbeatMisses",
      "lastHeartbeat", "executorStartedAt", "executorStartupId",
      "runningTaskCount", "reservedSlots", "runningExecutionIds",
      "cpuUsage", "memUsage", "diskUsage", "networkLatency",
      "totalTaskCount", "failedTaskCount", "maxConcurrentTasks",
      "deadLetterCount", "interpreters", "deviceFingerprint",
    ]);
    for (const key of Object.keys(patch)) {
      expect(owned.has(key)).toBe(true);
    }
    // 「从不被心跳修改」的列一个都不许出现（这正是整行 save 的缺陷来源）。
    for (const notOwned of [
      "id", "appName", "type", "executorVersion", "protocolVersion",
      "dispatchMode", "capabilities", "agentCapabilities", "groupName",
      "tags", "description", "projectId", "tokenHash", "version",
      "createdAt", "updatedAt",
    ]) {
      expect(patch).not.toHaveProperty(notOwned);
    }
    // 本次全部上报 ⇒ 白名单里的「可上报列」应悉数在 patch 里。
    for (const reported of [
      "cpuUsage", "memUsage", "diskUsage", "networkLatency",
      "runningTaskCount", "totalTaskCount", "failedTaskCount",
      "maxConcurrentTasks", "deadLetterCount", "runningExecutionIds",
      "interpreters", "deviceFingerprint", "executorStartupId",
    ]) {
      expect(patch).toHaveProperty(reported);
    }
  });

  it("心跳拥有的四列仍然无条件落库：并发 sweep 置的 OFFLINE 被心跳纠正回 ONLINE", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);
    repo.afterRead = () => {
      // stale sweep 在窗口内判死：status=OFFLINE + 新的 lastHeartbeat 观测值。
      repo.store.status = "offline";
      repo.store.offlineReason = "stale_timeout";
      repo.store.consecutiveHeartbeatMisses = 2;
      repo.store.lastHeartbeat = D1;
    };

    await svc.heartbeat("10.0.0.9:3002", {});

    // 覆盖式上报的语义就是 last-writer-wins：心跳必须把这四列写回去。
    expect(repo.store.status).toBe("online");
    expect(repo.store.offlineReason).toBeNull();
    expect(repo.store.consecutiveHeartbeatMisses).toBe(0);
    expect(repo.store.lastHeartbeat).not.toEqual(D1);
    expect(repo.saveCalls).toHaveLength(0);
  });

  it("双主人列 maxConcurrentTasks：本次上报了 → 心跳值胜出（不许因噎废食整列不写）", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);
    repo.afterRead = () => {
      repo.store.maxConcurrentTasks = 16;
    };

    await svc.heartbeat("10.0.0.9:3002", { maxConcurrentTasks: 8 });

    // 管理台值 16 被心跳上报的 8 覆盖 —— last-writer-wins 即正确语义
    // （与"未上报时一个字都不写"是同一判据的两面）。
    expect(repo.store.maxConcurrentTasks).toBe(8);
    expect(repo.updateCalls[0].patch).toHaveProperty("maxConcurrentTasks", 8);
  });

  it("双主人列 maxConcurrentTasks：本次未上报 → 不进 patch（管理台值存活）", async () => {
    const repo = new DiffAwareExecutorRepo(mkRow());
    const svc = makeService(repo);
    repo.afterRead = () => {
      repo.store.maxConcurrentTasks = 16;
    };

    await svc.heartbeat("10.0.0.9:3002", { cpuUsage: 5 });

    expect(repo.store.maxConcurrentTasks).toBe(16);
    expect(repo.updateCalls[0].patch).not.toHaveProperty("maxConcurrentTasks");
  });
});

