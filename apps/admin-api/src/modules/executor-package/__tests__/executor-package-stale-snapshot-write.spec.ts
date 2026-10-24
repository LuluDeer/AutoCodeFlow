/**
 * R60-A1（ADR-026 规则 4 · 整行 save 清理）：executor-package.update() 的
 * 「陈旧快照整行回写」并发交错实证。
 *
 * 分类结论（见 executor-package.service.ts 的三处 `.save`）：:348 是创建路径
 * （repo.create 出来的新实体 ⇒ INSERT，无可覆盖的并发事实）、:626 是事务内
 * `pessimistic_write` 锁内重读后的写回（锁持有到 commit ⇒ 无陈旧窗口），
 * **只有 update()（原 :582）** 是「findOne 快照 → 就地改 → 整行 save」。
 *
 * 本文件证明的不是"某行代码不好看"，而是一条可复现的数据丢失链：
 *   ① `update()` 早期 `findOne` 拿到快照 S；
 *   ② 另一写者（并发的 push-result 回调 / 另一个管理员的 deprecate）在
 *      「读之后、写之前」把新事实落库；
 *   ③ 整行 `save(S)`：TypeORM 对既有主键是「读当前行 → **按列 diff** → 只写有差异
 *      的列」，于是快照里过期的列与当前行**不相等** ⇒ 被判定成"改动"写回 ⇒ 覆盖 ②。
 *
 * 为什么假仓库要模拟 TypeORM 的 diff 语义（ADR-027 第三次教训：测试替身保真）：
 * 若写成"整体覆盖"，红点会同时出现在"写一列"与"写多列"两种实现上，归因指向错误
 * 的原因。差分保真后，红点的唯一成因就是"快照里过期的列被 diff 判成改动"。
 */
import { ExecutorPackageService } from "../executor-package.service";
import { ExecutorPackageStatus } from "../executor-package.entity";

// executor-package.service 只把 ExecutorService 当 @Optional 的 provider 用；
// 本套件只测 DB 写面，mock 掉它以免加载 bcrypt 原生模块（与同模块其它 spec 同策）。
jest.mock("../../executor/executor.service", () => ({
  ExecutorService: jest.fn(),
}));

// 服务构造器会确保 UPLOAD_DIR 存在（mkdirSync）——本套件只测 DB 写面，不落盘。
jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
}));

type Row = Record<string, unknown>;

/** 当前时间戳，用于断言"并发写者"的 pushHistory 条目。 */
const ENTRY = {
  executorId: "exec-9",
  status: "downloaded" as const,
  version: "1.0.0",
  timestamp: "2026-01-01T00:00:00.000Z",
};

/**
 * TypeORM 语义**差分保真**的 ExecutorPackage 仓库替身：
 * - `findOne` 返回**快照副本**（= 一次 SELECT）；
 * - `save(entity)`：先读当前行，再按列 diff，**只写有差异的列**（整行回写的真实机制）；
 * - `update(criteria, patch)`：只写 patch 里的列（= `UPDATE … SET <列清单> WHERE …`）；
 * - `afterRead`：并发写者的注入点——在"读完、写之前"把新事实落进 store。
 * - `manager.transaction`：`appendPushHistory` 的 FOR UPDATE 事务替身（锁内读到的
 *   就是 store 的当前值；真实 DB 由行锁保证读到已提交的追加）。
 */
class DiffAwareExecutorPackageRepo {
  store: Row;
  saveCalls: Row[] = [];
  updateCalls: Array<{ criteria: Row; patch: Row }> = [];
  /** 只在**第一次**读（快照读）时触发；后续 findOne 是唯一键冲突探测。 */
  afterRead: (() => void | Promise<void>) | null = null;

  constructor(initial: Row) {
    this.store = { ...initial };
  }

  private async takeSnapshot(): Promise<Row> {
    const snap = { ...this.store };
    const hook = this.afterRead;
    if (hook) {
      this.afterRead = null;
      // 「读之后、写之前」的交错点：另一写者在此刻落库（可能是 async 的）。
      await hook();
    }
    return snap;
  }

  /** TypeORM save：对既有主键读当前行 → 按列 diff → 只写差异列。 */
  private writeWholeRow(entity: Row): void {
    for (const [k, v] of Object.entries(entity)) {
      // undefined = 该列不参与 diff（select:false 列/被 delete 的键的真实表现）。
      if (v === undefined) continue;
      if (JSON.stringify(v) !== JSON.stringify(this.store[k])) {
        this.store[k] = v;
      }
    }
  }

  findOne = jest.fn(async (_args?: unknown) => this.takeSnapshot());

  find = jest.fn(async () => []);

  create = jest.fn((x: Row) => x);

  save = jest.fn(async (entity: Row) => {
    this.saveCalls.push(entity);
    this.writeWholeRow(entity);
    return entity;
  });

  update = jest.fn(async (criteria: Row, patch: Row) => {
    this.updateCalls.push({ criteria, patch });
    const matched = Object.entries(criteria).every(
      ([k, v]) => this.store[k] === v,
    );
    if (!matched) return { affected: 0 };
    Object.assign(this.store, patch);
    return { affected: 1 };
  });

  createQueryBuilder = jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => [this.store]),
    getCount: jest.fn(async () => 1),
    getOne: jest.fn(async () => this.store),
  }));

  manager = {
    transaction: async (cb: (em: unknown) => Promise<void>) =>
      cb({
        // 锁内重读 = 当前已提交行（真实 DB 由 FOR UPDATE 串行化）。
        findOne: jest.fn(async () => ({ ...this.store })),
        save: jest.fn(async (e: Row) => {
          this.writeWholeRow(e);
          return e;
        }),
      }),
  };
}

/** 一行"活的"执行器包：常规列全部有值（与真实行同形状）。 */
const mkRow = (over: Row = {}): Row => ({
  id: "pkg-1",
  name: "my-executor",
  version: "1.0.0",
  type: "node",
  platform: "linux",
  filename: "my-executor-1.0.0-abcd1234.zip",
  filePath: "/uploads/executor-packages/my-executor-1.0.0-abcd1234.zip",
  originalFilename: "executor-v1.0.0.zip",
  mimeType: "application/zip",
  fileSize: 1024,
  checksum: "a".repeat(64),
  description: "before",
  status: ExecutorPackageStatus.ACTIVE,
  uploadedBy: "admin",
  pushHistory: [],
  projectId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const makeService = (repo: DiffAwareExecutorPackageRepo) => {
  const svc = new ExecutorPackageService(
    repo as never,
    { get: jest.fn() } as never,
  );
  jest.spyOn(svc["logger"], "log").mockImplementation(() => undefined);
  jest.spyOn(svc["logger"], "warn").mockImplementation(() => undefined);
  jest.spyOn(svc["logger"], "error").mockImplementation(() => undefined);
  return svc;
};

describe("R60-A1 · executor-package.update()：元数据 PATCH 不得拿陈旧快照整行回写", () => {
  it("PATCH description 不得回滚并发 push-result 回调追加的 pushHistory", async () => {
    const repo = new DiffAwareExecutorPackageRepo(mkRow());
    const svc = makeService(repo);
    // 交错点：findOne 读完之后、写之前，push-result 回调（appendPushHistory，
    // 事务内 FOR UPDATE）把一条下载记录落库。
    repo.afterRead = async () => {
      await svc.appendPushHistory("pkg-1", {
        executorId: ENTRY.executorId,
        status: ENTRY.status,
        version: ENTRY.version,
      });
    };

    await svc.update("pkg-1", { description: "after" } as never);

    expect(repo.store.description).toBe("after");
    // 该列不是本次 PATCH 拥有的：并发追加的那条必须存活。
    expect(repo.store.pushHistory).toHaveLength(1);
    expect(repo.store.pushHistory).toEqual([
      expect.objectContaining({ executorId: ENTRY.executorId }),
    ]);
  });

  it("PATCH description 不得把并发 deprecate 的 status 复活成 ACTIVE", async () => {
    const repo = new DiffAwareExecutorPackageRepo(mkRow());
    const svc = makeService(repo);
    // 交错点：另一个管理员在本次 PATCH 的窗口内把包弃用（同一行的真实并发写者）。
    repo.afterRead = () => {
      repo.store.status = ExecutorPackageStatus.DEPRECATED;
    };

    await svc.update("pkg-1", { description: "after" } as never);

    expect(repo.store.description).toBe("after");
    // 弃用不得被"整行回写"按快照里的 ACTIVE 盖回去（否则包重新变成可安装）。
    expect(repo.store.status).toBe(ExecutorPackageStatus.DEPRECATED);
  });

  it("deprecate() 只写 status 一列，不覆盖并发追加的 pushHistory", async () => {
    const repo = new DiffAwareExecutorPackageRepo(mkRow());
    const svc = makeService(repo);
    repo.afterRead = async () => {
      await svc.appendPushHistory("pkg-1", {
        executorId: ENTRY.executorId,
        status: ENTRY.status,
        version: ENTRY.version,
      });
    };

    const out = await svc.deprecate("pkg-1");

    expect(out.status).toBe(ExecutorPackageStatus.DEPRECATED);
    expect(repo.store.status).toBe(ExecutorPackageStatus.DEPRECATED);
    expect(repo.store.pushHistory).toHaveLength(1);
    // 写面只有 status：不是整行 save，也不是"白名单照抄一遍"。
    expect(repo.updateCalls).toEqual([
      {
        criteria: { id: "pkg-1" },
        patch: { status: ExecutorPackageStatus.DEPRECATED },
      },
    ]);
    expect(repo.saveCalls).toHaveLength(0);
  });

  it("白名单之外的运行时字段（pushHistory / id / projectId）一律不写", async () => {
    const repo = new DiffAwareExecutorPackageRepo(mkRow());
    const svc = makeService(repo);
    // DTO 的内联类型只是编译期的：@Body() 对象运行时可带任意属性。
    const forged = {
      description: "after",
      pushHistory: [{ executorId: "forged" }],
      id: "pkg-hijacked",
      projectId: "project-2",
    };

    await svc.update("pkg-1", forged as never);

    expect(repo.updateCalls).toEqual([
      { criteria: { id: "pkg-1" }, patch: { description: "after" } },
    ]);
    expect(repo.store.pushHistory).toEqual([]);
    expect(repo.store.projectId).toBeNull();
    expect(repo.store.id).toBe("pkg-1");
    expect(repo.saveCalls).toHaveLength(0);
  });

  it("空 patch 不发写请求（旧实现会发一条 no-op 的整行 save，同样是可交错窗口）", async () => {
    const repo = new DiffAwareExecutorPackageRepo(mkRow());
    const svc = makeService(repo);

    const out = await svc.update("pkg-1", {} as never);

    expect(out.description).toBe("before");
    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.saveCalls).toHaveLength(0);
  });
});
