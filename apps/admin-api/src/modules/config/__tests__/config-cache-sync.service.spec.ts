import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import type Redis from "ioredis";

import {
  ConfigCacheSyncService,
  SYSTEM_CONFIG_EVICT_CHANNEL,
} from "../config-cache-sync.service";
import { SystemConfigService } from "../config.service";
import { SystemConfig } from "../entities/system-config.entity";

/**
 * §4.2（跨实例缓存失效）的正确性钉子。
 *
 * 本文件的核心不是「广播方法被调用了几次」，而是**读到的值真的是新的**：
 * 装配一个真实的 SystemConfigService（内存仓储 + 长 TTL，使缓存必然命中），
 * 由假 ioredis 模拟「另一台实例改了配置」，再看本实例的 findOne 是否读到了
 * 新值。反证有牙：
 *  - 把 onEvict 接到空实现 → 「远端改单键」用例红（读到旧值）；
 *  - 把单键逐出改成全量 → 「单键只影响该键」用例红（另一个键被误清）；
 *  - 把 publishInvalidate 的 try/catch 去掉 → 「PUBLISH 抛错」用例红（写失败）；
 *  - 把 onModuleDestroy 改成会抛的实现 → 「destroy 幂等不抛」用例红。
 */

/** ioredis 假体：EventEmitter 覆盖订阅端语义 + publish/quit 记录。 */
class FakeRedis extends EventEmitter {
  published: Array<{ channel: string; payload: string }> = [];
  subscribed: string[] = [];
  quitCalled = 0;

  async subscribe(channel: string): Promise<void> {
    this.subscribed.push(channel);
  }

  async publish(channel: string, payload: string): Promise<number> {
    this.published.push({ channel, payload });
    return 1;
  }

  async quit(): Promise<void> {
    this.quitCalled += 1;
  }

  disconnect(): void {
    /* no-op */
  }
}

/** 暴露测试缝：用假客户端替代真实 ioredis 连接。 */
class TestableSync extends ConfigCacheSyncService {
  constructor(
    private readonly testSubscriber: FakeRedis,
    private readonly testPublisher: FakeRedis,
  ) {
    super({ get: () => undefined } as unknown as ConfigService);
  }

  protected createPublisherClient(): Redis {
    return this.testPublisher as unknown as Redis;
  }

  protected createSubscriberClient(): Redis {
    return this.testSubscriber as unknown as Redis;
  }
}

const config = (key: string, value: string): SystemConfig =>
  ({ key, value, valueType: "string", isSecret: false }) as SystemConfig;

/**
 * 内存仓储：findOneBy / upsert / remove 都作用在同一份 Map 上，因此
 * 「写库 → 下一次读」是真实的读写闭环（不是 mock 的返回值序列）。
 */
const makeInMemoryRepo = () => {
  const rows = new Map<string, SystemConfig>();
  const repo = {
    rows,
    find: jest.fn(async () => [] as SystemConfig[]),
    findOneBy: jest.fn(
      async ({ key }: { key: string }) => rows.get(key) ?? null,
    ),
    upsert: jest.fn(async (row: Partial<SystemConfig> & { key: string }) => {
      rows.set(row.key, {
        ...(rows.get(row.key) ?? {}),
        ...row,
      } as SystemConfig);
      return undefined;
    }),
    remove: jest.fn(async (row: SystemConfig) => {
      rows.delete(row.key);
      return row;
    }),
    manager: { transaction: jest.fn() },
  };
  return repo;
};

const makeHistoryRepo = () => ({
  findOneBy: jest.fn(),
  save: jest.fn(async () => ({})),
  create: jest.fn((d: unknown) => d),
});

/**
 * 装配真实的 SystemConfigService + 真实的 ConfigCacheSyncService（仅连接换成
 * 假体）。`cacheSync` 缺席时保持 @Optional 的退化为 null 语义。
 *
 * TTL 取 60s：任何「靠 TTL 到期才看到新值」的路径都会被算作失败——
 * 新值必须来自广播逐出。
 */
const build = async (
  options: { withSync?: boolean; publishThrows?: boolean } = {},
) => {
  const repo = makeInMemoryRepo();
  const historyRepo = makeHistoryRepo();
  const subscriber = new FakeRedis();
  const publisher = new FakeRedis();
  if (options.publishThrows) {
    publisher.publish = async () => {
      throw new Error("connection refused");
    };
  }

  const svc = new SystemConfigService(
    repo as never,
    historyRepo as never,
    null, // leaderGate（@Optional）
    {
      get: (key: string) =>
        key === "systemConfig.cacheTtlMs" ? 60_000 : undefined,
    } as unknown as ConfigService,
    options.withSync === false ? null : new TestableSync(subscriber, publisher),
  );
  // Nest 生命周期：SystemConfigService.onModuleInit 接线 handler，同步服务
  // onModuleInit 建订阅。顺序与生产一致（容器里两者都在模块初始化阶段）。
  svc.onModuleInit();
  const sync = (svc as unknown as { cacheSync: TestableSync | null }).cacheSync;
  sync?.onModuleInit();
  return { svc, sync, repo, historyRepo, subscriber, publisher };
};

/** 模拟「远端实例」（另一台 admin-api）发出的驱逐广播。 */
const remoteBroadcast = (subscriber: FakeRedis, payload: unknown) =>
  subscriber.emit(
    "message",
    SYSTEM_CONFIG_EVICT_CHANNEL,
    JSON.stringify(payload),
  );

describe("§4.2 ConfigCacheSyncService 跨实例缓存失效", () => {
  describe("订阅接线", () => {
    it("subscribe 到配置驱逐频道（订阅连接独立于发布连接）", async () => {
      const { subscriber, publisher } = await build();
      expect(subscriber.subscribed).toEqual([SYSTEM_CONFIG_EVICT_CHANNEL]);
      expect(publisher.subscribed).toEqual([]);
    });

    it("本地写配置后通过发布连接广播（订阅连接不用于发布）", async () => {
      const { svc, publisher, subscriber } = await build();
      await svc.upsert({ key: "k", value: "v", valueType: "string" });

      expect(publisher.published).toEqual([
        {
          channel: SYSTEM_CONFIG_EVICT_CHANNEL,
          payload: JSON.stringify({ key: "k" }),
        },
      ]);
      expect(subscriber.published).toEqual([]);
    });
  });

  describe("核心：收到广播后读到的是**新值**（不是断言调用了某个方法）", () => {
    it("远端改单键 → 本实例下一次 findOne 真的读库并看到新值", async () => {
      const { svc, repo, subscriber } = await build();
      repo.rows.set(
        "executor.sharedToken",
        config("executor.sharedToken", "old"),
      );

      // 首次读进缓存（TTL 60s，若不逐出，下面必然仍读到 "old"）
      expect((await svc.findOne("executor.sharedToken")).value).toBe("old");

      // 另一台实例把库里的值改了，并广播
      repo.rows.set(
        "executor.sharedToken",
        config("executor.sharedToken", "new-from-instance-A"),
      );
      remoteBroadcast(subscriber, { key: "executor.sharedToken" });

      const after = await svc.findOne("executor.sharedToken");
      expect(after.value).toBe("new-from-instance-A");
      // 确实重新读了库（而不是缓存里的旧实体）
      expect(repo.findOneBy).toHaveBeenCalledTimes(2);
    });

    it("全量广播（无 key）→ 所有键的下一次读都是新值", async () => {
      const { svc, repo, subscriber } = await build();
      repo.rows.set("a", config("a", "a-old"));
      repo.rows.set("b", config("b", "b-old"));
      expect((await svc.findOne("a")).value).toBe("a-old");
      expect((await svc.findOne("b")).value).toBe("b-old");

      repo.rows.set("a", config("a", "a-new"));
      repo.rows.set("b", config("b", "b-new"));
      remoteBroadcast(subscriber, {});

      expect((await svc.findOne("a")).value).toBe("a-new");
      expect((await svc.findOne("b")).value).toBe("b-new");
    });

    it("订阅连接 ready（首连 + 每次重连）触发全量清空，自愈漏掉的消息", async () => {
      const { svc, repo, subscriber } = await build();
      repo.rows.set("k", config("k", "old"));
      expect((await svc.findOne("k")).value).toBe("old");

      // 断连窗口里漏掉了一条消息：只有库变了，没有广播
      repo.rows.set("k", config("k", "missed"));
      expect((await svc.findOne("k")).value).toBe("old"); // 仍是旧值（符合预期）

      // 重连 → flush → 下一次读拿到新值
      subscriber.emit("ready");
      expect((await svc.findOne("k")).value).toBe("missed");
    });

    it("畸形的广播载荷按全量清空处理（不认识的变化 = 保守失效）", async () => {
      const { svc, repo, subscriber } = await build();
      repo.rows.set("k", config("k", "old"));
      expect((await svc.findOne("k")).value).toBe("old");

      repo.rows.set("k", config("k", "new"));
      expect(() =>
        subscriber.emit("message", SYSTEM_CONFIG_EVICT_CHANNEL, "not-json"),
      ).not.toThrow();
      expect((await svc.findOne("k")).value).toBe("new");
    });

    it("其他频道的消息不影响本实例缓存", async () => {
      const { svc, repo, subscriber } = await build();
      repo.rows.set("k", config("k", "old"));
      expect((await svc.findOne("k")).value).toBe("old");

      repo.rows.set("k", config("k", "new"));
      subscriber.emit(
        "message",
        "some:other:channel",
        JSON.stringify({ key: "k" }),
      );
      // 未逐出 → 仍在 60s 窗口内读到旧值（证明频道过滤真的生效）
      expect((await svc.findOne("k")).value).toBe("old");
    });
  });

  describe("单键逐出只影响该键", () => {
    it("逐出 k1 后 k2 仍在缓存里（各自的 TTL 窗口独立）", async () => {
      const { svc, repo, subscriber } = await build();
      repo.rows.set("k1", config("k1", "v1-old"));
      repo.rows.set("k2", config("k2", "v2-old"));
      expect((await svc.findOne("k1")).value).toBe("v1-old");
      expect((await svc.findOne("k2")).value).toBe("v2-old");
      expect(repo.findOneBy).toHaveBeenCalledTimes(2);

      repo.rows.set("k1", config("k1", "v1-new"));
      repo.rows.set("k2", config("k2", "v2-new"));
      remoteBroadcast(subscriber, { key: "k1" });

      expect((await svc.findOne("k1")).value).toBe("v1-new");
      // k2 未被逐出：60s 窗口内仍返回旧值且不重新读库
      expect((await svc.findOne("k2")).value).toBe("v2-old");
      expect(repo.findOneBy).toHaveBeenCalledTimes(3);
    });

    it("逐出未知 key 是无害的（不抛、不影响其他键）", async () => {
      const { svc, repo, subscriber } = await build();
      repo.rows.set("k", config("k", "v"));
      expect((await svc.findOne("k")).value).toBe("v");

      expect(() =>
        remoteBroadcast(subscriber, { key: "never-existed" }),
      ).not.toThrow();
      expect((await svc.findOne("k")).value).toBe("v");
      expect(repo.findOneBy).toHaveBeenCalledTimes(1);
    });
  });

  describe("fail-open：Redis 不可用绝不改变与本实例的写操作结果", () => {
    it("PUBLISH 抛错 → 写操作仍然成功，且本地缓存照样失效", async () => {
      const { svc, repo } = await build({ publishThrows: true });

      await expect(
        svc.upsert({ key: "k", value: "v", valueType: "string" }),
      ).resolves.toBeDefined();
      // 本地读面照样看到新值（不依赖广播）
      expect((await svc.findOne("k")).value).toBe("v");

      // 删除同样不受 PUBLISH 抛错影响
      await expect(svc.remove("k")).resolves.toEqual({ deleted: true });
      await expect(svc.findOne("k")).rejects.toThrow();
      expect(repo.rows.has("k")).toBe(false);
    });

    it("Redis 完全不可用（订阅端建连即抛）→ 服务仍可用，TTL 兜底", async () => {
      const repo = makeInMemoryRepo();
      const historyRepo = makeHistoryRepo();
      const broken = new TestableSync(new FakeRedis(), new FakeRedis());
      // 订阅端建连失败（DNS/connection refused 的等价形态）
      (
        broken as unknown as { createSubscriberClient: () => Redis }
      ).createSubscriberClient = () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      };

      const svc = new SystemConfigService(
        repo as never,
        historyRepo as never,
        null,
        {
          get: (key: string) =>
            key === "systemConfig.cacheTtlMs" ? 60_000 : undefined,
        } as unknown as ConfigService,
        broken,
      );
      expect(() => svc.onModuleInit()).not.toThrow();
      expect(() => broken.onModuleInit()).not.toThrow();

      repo.rows.set("k", config("k", "v1"));
      await expect(svc.findOne("k")).resolves.toMatchObject({ value: "v1" });
      await expect(
        svc.upsert({ key: "k", value: "v2", valueType: "string" }),
      ).resolves.toBeDefined();
      // 本地缓存仍按既有语义失效
      expect((await svc.findOne("k")).value).toBe("v2");
    });

    it("cacheSync 缺席（@Optional 未装配）→ 既有行为逐字节不变", async () => {
      const { svc, repo } = await build({ withSync: false });
      repo.rows.set("k", config("k", "v1"));
      expect((await svc.findOne("k")).value).toBe("v1");
      expect(repo.findOneBy).toHaveBeenCalledTimes(1);

      await expect(
        svc.upsert({ key: "k", value: "v2", valueType: "string" }),
      ).resolves.toBeDefined();
      expect((await svc.findOne("k")).value).toBe("v2");
    });

    it("publishInvalidate 在 destroy 之后是 no-op（不抛、不再建连）", async () => {
      const { sync, publisher } = await build();
      await sync!.publishInvalidate("k");
      expect(publisher.published).toHaveLength(1);

      await sync!.onModuleDestroy();
      await expect(sync!.publishInvalidate("k")).resolves.toBeUndefined();
      expect(publisher.published).toHaveLength(1);
    });
  });

  describe("onModuleDestroy", () => {
    it("关闭两条连接（各自 quit 一次），且幂等——重复调用不抛", async () => {
      const { sync, subscriber, publisher } = await build();
      await sync!.publishInvalidate("k"); // publisher 惰性创建于首次发布
      expect(publisher.quitCalled).toBe(0);

      await expect(sync!.onModuleDestroy()).resolves.toBeUndefined();
      expect(publisher.quitCalled).toBe(1);
      expect(subscriber.quitCalled).toBe(1);

      // 幂等：第二次调用时客户端已被置 null，什么都不做也不抛
      await expect(sync!.onModuleDestroy()).resolves.toBeUndefined();
      expect(publisher.quitCalled).toBe(1);
      expect(subscriber.quitCalled).toBe(1);
    });

    it("quit 抛错时回落到 disconnect，不向调用方抛", async () => {
      const { sync, subscriber, publisher } = await build();
      await sync!.publishInvalidate("k");
      publisher.quit = async () => {
        throw new Error("quit boom");
      };
      subscriber.quit = async () => {
        throw new Error("quit boom");
      };
      let disconnected = 0;
      publisher.disconnect = () => {
        disconnected += 1;
      };
      subscriber.disconnect = () => {
        disconnected += 1;
      };

      await expect(sync!.onModuleDestroy()).resolves.toBeUndefined();
      expect(disconnected).toBe(2);
    });
  });
});
