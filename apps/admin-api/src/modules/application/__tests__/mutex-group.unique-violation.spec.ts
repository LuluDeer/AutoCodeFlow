import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException } from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { MutexGroupService } from "../mutex-group.service";
import { MutexGroup } from "../entities/mutex-group.entity";

/**
 * `mutex-group.service.ts` 的 **23505 唯一冲突路径**回归网（R5 · knownGap
 * `no-spec-covers-23505-path` 销账）。
 *
 * ## 背景：为什么需要这个 spec
 *
 * 相 1 审计（`artifacts/rounds/r5-23505-audit.md`）发现：`mutex-group` 的
 * 23505 判据是**全仓唯一「比通用 util 更严格」且**没有任何专属 spec** 的那一份
 * ⇒ **它没有回归网** ⇒ 将来有人改它，**既不会破坏测试、也测不出退化**。
 *
 * 本 spec **只测现状，不改实现**（Lead 的硬约束）。
 *
 * ## ⚠️ 本 spec 钉的是**当前**语义（比 `common/utils/pg-unique-violation.util.ts`
 * **更严格**：多了 `instanceof QueryFailedError` 一层，且**不**看 `driverError`）
 *
 * 若将来要把这份判据收敛到 util（放宽），**本 spec 必须先改**，且必须先回答
 * 一个问题：**「去掉 `instanceof` 会不会让非冲突错误被误判？」**
 *
 * 答案（实测，见用例 ③/④）：**会**——
 * 去掉 `instanceof` 后，一个**只是**带 `code: "23505"` 的**裸对象**
 * （不是 TypeORM 包装过的 `QueryFailedError`）也会被判为「唯一冲突」
 * ⇒ 一个本该 500 的错误会被**吞成 409「互斥组已存在」** ⇒ **错误归因被带歪**。
 * 这就是它**刻意比 util 严格**、且**保持独立**的理由。
 *
 * ## 判据形态（逐项，实现见 `mutex-group.service.ts:23-30`）
 *
 * | 维度 | 当前实现 | 与 util 的差异 |
 * |---|---|---|
 * | `instanceof QueryFailedError` | **要求** | util **不要求** |
 * | 顶层 `code` | 认（须是 `"23505"`） | 认 |
 * | `driverError.code` | **不认** | 认（回落） |
 * | `cause.code` | **不认** | 不认 |
 * | `constraint`（具体约束名） | **不读** | 读（取约束名用） |
 */

/** 造一个 TypeORM 包装过的 23505 错误（`code` 挂顶层）。 */
const makeQueryFailed = (code: string, constraint?: string) => {
  const err = new QueryFailedError(
    "INSERT INTO mutex_groups ...",
    [],
    new Error("dup"),
  );
  (err as unknown as { code?: string }).code = code;
  if (constraint !== undefined) {
    (err as unknown as { constraint?: string }).constraint = constraint;
  }
  return err;
};

const makeRepo = () => {
  const repo: Record<string, unknown> = {
    create: jest.fn((d: unknown) => d),
    save: jest.fn(async (e: unknown) => ({ id: "g-1", ...(e as object) })),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    manager: { query: jest.fn().mockResolvedValue([]) },
    remove: jest.fn(),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  return repo as {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
};

describe("MutexGroupService · 23505 唯一冲突路径（现状回归网）", () => {
  let service: MutexGroupService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const module = await Test.createTestingModule({
      providers: [
        MutexGroupService,
        { provide: getRepositoryToken(MutexGroup), useValue: repo },
      ],
    }).compile();
    service = module.get(MutexGroupService);
  });

  describe("判据形态（逐条钉住当前语义）", () => {
    it("① 顶层 code=23505 且是 QueryFailedError ⇒ 被识别为唯一冲突（409）", async () => {
      repo.save.mockRejectedValueOnce(makeQueryFailed("23505"));
      await expect(
        service.create({ name: "g-dup" } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("② driverError.code=23505 ⇒ **不被**识别（当前实现只看顶层）⇒ 错误原样外抛", async () => {
      // ⚠️ 这是它与 util 的**关键差异**之一：util 会回落 driverError.code，
      // 本实现**不会** ⇒ 判为「非冲突」⇒ 走 `throw err`（不被吞成 409）。
      const err = new QueryFailedError(
        "INSERT INTO mutex_groups ...",
        [],
        new Error("dup"),
      );
      (err as unknown as { driverError: { code: string } }).driverError = {
        code: "23505",
      };
      repo.save.mockRejectedValueOnce(err);
      await expect(service.create({ name: "g-dup" } as never)).rejects.toBe(
        err,
      );
    });

    it("③ instanceof QueryFailedError 是**实质门槛**：裸对象（带 code 但不是 QFE）⇒ 不被识别", async () => {
      // ⚠️ 这是它与 util 的**关键差异**之二，也是「刻意保持独立」的核心理由：
      // 去掉 instanceof 后，这个**裸对象**会被判为「唯一冲突」⇒ 一个本该
      // 500 的错误被**吞成 409「互斥组已存在」** ⇒ 错误归因被带歪。
      const bare = Object.assign(new Error("dup"), { code: "23505" });
      repo.save.mockRejectedValueOnce(bare);
      await expect(service.create({ name: "g-dup" } as never)).rejects.toBe(
        bare,
      );
    });

    it("④ 非 23505 的 DB 错误（23503 外键）⇒ **不被**识别为唯一冲突", async () => {
      const err = makeQueryFailed("23503");
      repo.save.mockRejectedValue(err); // 持续抛（两次断言用同一个错误对象）
      // 原样外抛
      await expect(service.create({ name: "g-dup" } as never)).rejects.toBe(
        err,
      );
      // 尤其**不能**被吞成 409「已存在」（那是错误归因）
      await expect(
        service.create({ name: "g-dup" } as never),
      ).rejects.not.toBeInstanceOf(ConflictException);
    });

    it("⑤ 不读 constraint：撞**别的**唯一索引也照样判为冲突（它不按约束名归因）", async () => {
      // 现状快照：判据**只**看 code，不看是哪个约束 ⇒ 撞 `uq_别的` 也会被
      // 报成「互斥组名已存在」。这是它**比 util 宽松**的一面（util 能按约束名
      // 归因），也是它**没被收敛**的原因之一：改它要先回答
      // 「别的唯一索引冲突报成『名字已存在』是不是可接受」。
      const err = makeQueryFailed("23505", "uq_something_else");
      repo.save.mockRejectedValueOnce(err);
      await expect(
        service.create({ name: "g-dup" } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("业务语义（冲突时对外抛什么 / 非冲突时不被吞）", () => {
    it("⑥ create 撞唯一冲突 ⇒ 409 + errorCode=MUTEX_GROUP_NAME_EXISTS + 文案点名组名", async () => {
      repo.save.mockRejectedValueOnce(makeQueryFailed("23505"));
      const err = await service
        .create({ name: "g-dup" } as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as { errorCode?: string }).errorCode).toBe(
        "MUTEX_GROUP_NAME_EXISTS",
      );
      // 文案要点：点名是**哪个**组名（用户要知道撞的是谁）
      expect((err as { message?: string }).message).toContain("g-dup");
    });

    it("⑦ update 更名撞唯一冲突 ⇒ 同样 409 + MUTEX_GROUP_NAME_EXISTS", async () => {
      repo.findOne.mockResolvedValueOnce({
        id: "g-1",
        name: "old",
        scope: "device",
        maxConcurrentPerDevice: 1,
      });
      repo.update.mockRejectedValueOnce(makeQueryFailed("23505"));
      const err = await service
        .update("g-1", { name: "taken" } as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as { errorCode?: string }).errorCode).toBe(
        "MUTEX_GROUP_NAME_EXISTS",
      );
    });

    it("⑧ 非冲突错误 ⇒ **原样外抛**（不被冲突分支吞掉、不被改写成 409）", async () => {
      const raw = new Error("connection reset");
      repo.save.mockRejectedValueOnce(raw);
      const err = await service
        .create({ name: "g-dup" } as never)
        .catch((e: unknown) => e);
      expect(err).toBe(raw);
      expect(err).not.toBeInstanceOf(ConflictException);
      expect((err as { errorCode?: string }).errorCode).toBeUndefined();
    });
  });
});
