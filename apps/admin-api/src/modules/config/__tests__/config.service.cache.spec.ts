import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { NotFoundException } from "@nestjs/common";
import {
  SystemConfigService,
  SYSTEM_CONFIG_CACHE_TTL_DEFAULT_MS,
} from "../config.service";
import { SystemConfig } from "../entities/system-config.entity";
import { ConfigHistory } from "../entities/config-history.entity";

/**
 * PERF-2: SystemConfig 读缓存的正确性钉子。
 *
 * 本缓存唯一不能犯的错是「写后读到旧值」——所以这里的用例结构是：
 *  1. 读命中窗口内确实**只打一次 DB**（缓存真的生效，否则优化是假的）；
 *  2. 每一个写面（upsert / batchUpsert / remove / rollback）之后，
 *     下一次 findOne **必须重新读库并看到新值**（本地失效真的发生）；
 *  3. ttl=0 时逐字节回到旧行为（每次读库），0 = 关闭的语义成立。
 *
 * 反证有牙：把任一个 invalidateCache() 删掉 → 对应用例红（读到旧值）；
 * 把 cacheTtlMs 的判断去掉 → ttl=0 用例红。
 */

const makeRepo = () => ({
  find: jest.fn(),
  findOneBy: jest.fn(),
  upsert: jest.fn(),
  remove: jest.fn(),
  manager: { transaction: jest.fn() },
});

const makeHistoryRepo = () => ({
  findOneBy: jest.fn(),
  save: jest.fn(),
  create: jest.fn((d) => d),
});

const config = (key: string, value: string): SystemConfig =>
  ({ key, value, valueType: "string", isSecret: false }) as SystemConfig;

/** 装配：configService 缺省时用常量默认 TTL（与生产缺省一致）。 */
const build = async (
  ttlMs: number | undefined,
  repos: {
    repo: ReturnType<typeof makeRepo>;
    historyRepo: ReturnType<typeof makeHistoryRepo>;
  },
): Promise<SystemConfigService> => {
  const providers: unknown[] = [
    SystemConfigService,
    { provide: getRepositoryToken(SystemConfig), useValue: repos.repo },
    { provide: getRepositoryToken(ConfigHistory), useValue: repos.historyRepo },
  ];
  if (ttlMs !== undefined) {
    providers.push({
      provide: ConfigService,
      useValue: {
        get: (key: string) =>
          key === "systemConfig.cacheTtlMs" ? ttlMs : undefined,
      },
    });
  }
  const module: TestingModule = await Test.createTestingModule({
    providers: providers as never,
  }).compile();
  return module.get<SystemConfigService>(SystemConfigService);
};

describe("PERF-2: SystemConfigService findOne 短 TTL 缓存", () => {
  let repo: ReturnType<typeof makeRepo>;
  let historyRepo: ReturnType<typeof makeHistoryRepo>;

  beforeEach(() => {
    repo = makeRepo();
    historyRepo = makeHistoryRepo();
    historyRepo.save.mockResolvedValue({});
    repo.upsert.mockResolvedValue(undefined);
    repo.remove.mockResolvedValue(undefined);
  });

  describe("读缓存命中", () => {
    it("窗口内重复 findOne 只打一次 DB（缓存真的生效）", async () => {
      const svc = await build(1000, { repo, historyRepo });
      repo.findOneBy.mockResolvedValue(config("k", "v1"));

      await expect(svc.findOne("k")).resolves.toMatchObject({ value: "v1" });
      await expect(svc.findOne("k")).resolves.toMatchObject({ value: "v1" });
      await expect(svc.findOne("k")).resolves.toMatchObject({ value: "v1" });

      expect(repo.findOneBy).toHaveBeenCalledTimes(1);
    });

    it("不同 key 各自缓存（不是全局单槽）", async () => {
      const svc = await build(1000, { repo, historyRepo });
      repo.findOneBy
        .mockResolvedValueOnce(config("a", "1"))
        .mockResolvedValueOnce(config("b", "2"));

      expect((await svc.findOne("a")).value).toBe("1");
      expect((await svc.findOne("b")).value).toBe("2");
      expect((await svc.findOne("a")).value).toBe("1");
      expect(repo.findOneBy).toHaveBeenCalledTimes(2);
    });

    it("TTL 过期后重新读库（窗口到期即失效，不依赖写入）", async () => {
      const svc = await build(20, { repo, historyRepo });
      repo.findOneBy
        .mockResolvedValueOnce(config("k", "old"))
        .mockResolvedValueOnce(config("k", "new"));

      expect((await svc.findOne("k")).value).toBe("old");
      // 越过 20ms 窗口（fake timers 会与 TypeORM 的异步栈打架，直接等）。
      await new Promise((r) => setTimeout(r, 40));
      expect((await svc.findOne("k")).value).toBe("new");
      expect(repo.findOneBy).toHaveBeenCalledTimes(2);
    });

    it("不缓存「key 不存在」——创建后立即可读到（负缓存会让 404 卡在窗口里）", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      repo.findOneBy
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(config("late", "born"));

      await expect(svc.findOne("late")).rejects.toThrow(NotFoundException);
      // 若把「不存在」也缓存了，这里会继续 404 而不是读到新行。
      await expect(svc.findOne("late")).resolves.toMatchObject({
        value: "born",
      });
      expect(repo.findOneBy).toHaveBeenCalledTimes(2);
    });
  });

  describe("写面失效（正确性核心）", () => {
    it("upsert 后下一次 findOne 重新读库并看到新值", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      repo.findOneBy
        .mockResolvedValueOnce(config("k", "old")) // 首次读（进缓存）
        .mockResolvedValueOnce(config("k", "old")) // upsertInStores 的 existing 查询
        .mockResolvedValueOnce(config("k", "new")); // upsert 返回行

      expect((await svc.findOne("k")).value).toBe("old");

      await svc.upsert({ key: "k", value: "new", valueType: "string" });

      repo.findOneBy.mockResolvedValue(config("k", "new"));
      // 若 upsert 漏了失效，这里会命中 60s 窗口里的 "old"。
      expect((await svc.findOne("k")).value).toBe("new");
    });

    it("upsert 抛错时同样失效（部分写入后缓存里的旧值更危险）", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      repo.findOneBy.mockResolvedValueOnce(config("k", "old"));
      expect((await svc.findOne("k")).value).toBe("old");

      // 历史行写入失败 → upsert 整条抛错
      historyRepo.save.mockRejectedValueOnce(new Error("history boom"));
      repo.findOneBy.mockResolvedValueOnce(config("k", "old"));
      await expect(
        svc.upsert({ key: "k", value: "new", valueType: "string" }),
      ).rejects.toThrow("history boom");

      repo.findOneBy.mockResolvedValue(config("k", "new"));
      expect((await svc.findOne("k")).value).toBe("new");
    });

    it("remove 后下一次 findOne 重新读库（行已删除 → 404，而不是缓存里的旧行）", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      const row = config("k", "v");
      repo.findOneBy.mockResolvedValueOnce(row); // 首次读（进缓存）
      expect((await svc.findOne("k")).value).toBe("v");

      repo.findOneBy.mockResolvedValueOnce(row); // remove 内部取行
      await svc.remove("k");

      repo.findOneBy.mockResolvedValue(null);
      await expect(svc.findOne("k")).rejects.toThrow(NotFoundException);
    });

    it("batchUpsert 后下一次 findOne 重新读库（事务提交后不再读旧值）", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      repo.findOneBy.mockResolvedValueOnce(config("k", "old"));
      expect((await svc.findOne("k")).value).toBe("old");

      const txConfigRepo = {
        findOneBy: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(config("k", "new")),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const txHistoryRepo = {
        create: jest.fn((d) => d),
        save: jest.fn().mockResolvedValue({}),
      };
      repo.manager.transaction.mockImplementation(async (cb: never) =>
        (cb as (m: unknown) => unknown)({
          getRepository: (entity: unknown) =>
            entity === SystemConfig ? txConfigRepo : txHistoryRepo,
        }),
      );

      await svc.batchUpsert([{ key: "k", value: "new" }]);

      repo.findOneBy.mockResolvedValue(config("k", "new"));
      expect((await svc.findOne("k")).value).toBe("new");
    });

    it("batchUpsert 事务失败后同样失效", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      repo.findOneBy.mockResolvedValueOnce(config("k", "old"));
      expect((await svc.findOne("k")).value).toBe("old");

      repo.manager.transaction.mockRejectedValueOnce(new Error("tx boom"));
      await expect(
        svc.batchUpsert([{ key: "k", value: "new" }]),
      ).rejects.toThrow("tx boom");

      repo.findOneBy.mockResolvedValue(config("k", "old"));
      // 重新读库（次数 +1）而不是继续用缓存 —— 用调用计数证明失效发生。
      expect((await svc.findOne("k")).value).toBe("old");
      expect(repo.findOneBy).toHaveBeenCalledTimes(2);
    });

    it("rollback（update 路径）后下一次 findOne 重新读库并看到回滚值", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      repo.findOneBy.mockResolvedValueOnce(config("k", "current"));
      expect((await svc.findOne("k")).value).toBe("current");

      historyRepo.findOneBy.mockResolvedValue({
        id: 1,
        configKey: "k",
        oldValue: "restored",
        action: "update",
      });
      // rollback 内部：current 查询 → 最终 findOneBy
      repo.findOneBy
        .mockResolvedValueOnce(config("k", "current"))
        .mockResolvedValueOnce(config("k", "restored"));

      await svc.rollback(1);

      repo.findOneBy.mockResolvedValue(config("k", "restored"));
      expect((await svc.findOne("k")).value).toBe("restored");
    });

    it("rollback（create → 删除）后下一次 findOne 重新读库（行没了）", async () => {
      const svc = await build(60_000, { repo, historyRepo });
      const row = config("k-new", "v");
      repo.findOneBy.mockResolvedValueOnce(row);
      expect((await svc.findOne("k-new")).value).toBe("v");

      historyRepo.findOneBy.mockResolvedValue({
        id: 5,
        configKey: "k-new",
        oldValue: null,
        action: "create",
      });
      repo.findOneBy.mockResolvedValueOnce(row);
      await svc.rollback(5);

      repo.findOneBy.mockResolvedValue(null);
      await expect(svc.findOne("k-new")).rejects.toThrow(NotFoundException);
    });
  });

  describe("关闭语义（ttl = 0）", () => {
    it("ttl=0 时每次 findOne 都读库（逐字节回到未缓存的旧行为）", async () => {
      const svc = await build(0, { repo, historyRepo });
      repo.findOneBy.mockResolvedValue(config("k", "v"));

      await svc.findOne("k");
      await svc.findOne("k");
      await svc.findOne("k");

      expect(repo.findOneBy).toHaveBeenCalledTimes(3);
    });

    it("ttl 非法（负数 / NaN / 缺省装配）时回落常量默认值，不静默关闭", async () => {
      // 负数 → 默认值（与 configuration.ts 缺省一致）
      for (const bad of [-1, Number.NaN]) {
        const localRepo = makeRepo();
        localRepo.findOneBy.mockResolvedValue(config("k", "v"));
        const svc = await build(bad, {
          repo: localRepo,
          historyRepo: makeHistoryRepo(),
        });
        await svc.findOne("k");
        await svc.findOne("k");
        // 默认 TTL > 0 → 第二次命中缓存，只打一次 DB
        expect(localRepo.findOneBy).toHaveBeenCalledTimes(1);
      }

      // ConfigService 完全缺席（既有单测装配）→ 默认值
      const localRepo = makeRepo();
      localRepo.findOneBy.mockResolvedValue(config("k", "v"));
      const svc = await build(undefined, {
        repo: localRepo,
        historyRepo: makeHistoryRepo(),
      });
      await svc.findOne("k");
      await svc.findOne("k");
      expect(localRepo.findOneBy).toHaveBeenCalledTimes(1);
      expect(SYSTEM_CONFIG_CACHE_TTL_DEFAULT_MS).toBeGreaterThan(0);
    });
  });
});
