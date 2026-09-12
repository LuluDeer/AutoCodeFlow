import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { NotificationConfigService } from "../notification-config.service";
import { NotificationService } from "../notification.service";
import { ChannelConfigStore } from "../channel-config.store";

/**
 * ARCH-31: 渠道配置跨实例共享（`notification_channel_configs`，迁移
 * 1790000000014）。此前 PATCH 保存的配置只落在接收请求的那个进程的内存里，
 * 多实例下其余实例静默回退 env——保存过的 webhook/SMTP 形同失效。
 */
describe("ChannelConfigStore / NotificationConfigService — ARCH-31 跨实例共享", () => {
  const mockRepo = (over: Record<string, unknown> = {}) => ({
    find: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    ...over,
  });

  const buildConfigService = async (store: ChannelConfigStore) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationConfigService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        {
          provide: NotificationService,
          useValue: { sendAll: jest.fn(), sendToChannels: jest.fn() },
        },
        { provide: ChannelConfigStore, useValue: store },
      ],
    }).compile();
    return module.get<NotificationConfigService>(NotificationConfigService);
  };

  describe("无持久化层（@Optional 仓储缺席）—— 逐字节保持 V1 内存语义", () => {
    it("isPersistent=false，刷新/持久化整体旁路", async () => {
      const store = new ChannelConfigStore();
      expect(store.isPersistent()).toBe(false);
      expect(await store.refreshFromStore()).toBe(0);
      expect(await store.listPersisted()).toEqual([]);
      expect(await store.persist("webhook", { url: "https://x" }, true)).toBe(
        false,
      );
    });

    it("刷新周期回落默认值（无 ConfigService 也不抛）", () => {
      const store = new ChannelConfigStore();
      expect(store.resolveRefreshMs()).toBe(
        ChannelConfigStore.DEFAULT_REFRESH_MS,
      );
    });
  });

  describe("有持久化层 —— 写穿与读穿", () => {
    it("refreshFromStore 把 DB 行覆盖式灌入内存（另一个实例保存的配置）", async () => {
      const repo = mockRepo({
        find: jest.fn().mockResolvedValue([
          {
            key: "webhook",
            config: { url: "https://saved.example.com" },
            enabled: true,
          },
          {
            key: "slack",
            config: { webhookUrl: "https://hooks/x" },
            enabled: false,
          },
        ]),
      });
      const store = new ChannelConfigStore(repo as never);
      expect(store.isPersistent()).toBe(true);

      const refreshed = await store.refreshFromStore();
      expect(refreshed).toBe(2);
      expect(store.get("webhook")).toEqual({
        url: "https://saved.example.com",
      });
      expect(store.isEnabled("webhook")).toBe(true);
      expect(store.isEnabled("slack")).toBe(false);
    });

    it("persist 走 upsert（conflictPaths=key），失败仅 warn 不抛", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      const repo = mockRepo({
        upsert: jest.fn().mockRejectedValue(new Error("pg down")),
      });
      const store = new ChannelConfigStore(repo as never);

      expect(await store.persist("webhook", { url: "u" }, true)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DB persist failed"),
      );
      warnSpy.mockRestore();

      const ok = mockRepo();
      const okStore = new ChannelConfigStore(ok as never);
      expect(await okStore.persist("webhook", { url: "u" }, true)).toBe(true);
      expect(ok.upsert).toHaveBeenCalledWith(
        [{ key: "webhook", config: { url: "u" }, enabled: true }],
        { conflictPaths: ["key"] },
      );
    });

    it("delete 同步删 DB 行；无 repo 时只清内存", async () => {
      const repo = mockRepo();
      const store = new ChannelConfigStore(repo as never);
      store.set("webhook", { url: "u" }, true);
      store.delete("webhook");
      expect(store.get("webhook")).toBeUndefined();
      expect(repo.delete).toHaveBeenCalledWith("webhook");

      const bare = new ChannelConfigStore();
      bare.set("webhook", { url: "u" }, true);
      expect(() => bare.delete("webhook")).not.toThrow();
    });

    it("刷新查询失败保持内存态（不因 DB 抖动丢配置）", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      const repo = mockRepo({
        find: jest.fn().mockRejectedValue(new Error("pg down")),
      });
      const store = new ChannelConfigStore(repo as never);
      store.set("webhook", { url: "https://local" }, true);

      expect(await store.refreshFromStore()).toBe(0);
      expect(store.get("webhook")).toEqual({ url: "https://local" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DB refresh failed"),
      );
      warnSpy.mockRestore();
    });

    it("刷新周期可由配置覆盖，非法值回落默认", () => {
      const good = new ChannelConfigStore(
        mockRepo() as never,
        { get: jest.fn().mockReturnValue(5000) } as never,
      );
      expect(good.resolveRefreshMs()).toBe(5000);

      const bad = new ChannelConfigStore(
        mockRepo() as never,
        { get: jest.fn().mockReturnValue(10) } as never,
      );
      expect(bad.resolveRefreshMs()).toBe(
        ChannelConfigStore.DEFAULT_REFRESH_MS,
      );
    });
  });

  describe("NotificationConfigService 双内存面同步", () => {
    it("hydrateFromPersisted 同时刷新读面与发送面（防 GET 与 send 错位）", async () => {
      const repo = mockRepo({
        find: jest.fn().mockResolvedValue([
          {
            key: "webhook",
            config: { url: "https://other-instance.example.com" },
            enabled: true,
          },
        ]),
      });
      const store = new ChannelConfigStore(repo as never);
      const service = await buildConfigService(store);

      // 刷新前：两个面都是默认（env 种子空配置）
      expect(service.getChannel("webhook")!.enabled).toBe(false);
      expect(store.get("webhook")).toEqual({});

      const n = await service.hydrateFromPersisted();
      expect(n).toBe(1);
      expect(service.getChannel("webhook")!.enabled).toBe(true);
      // 读面：url 非 secret-class 键（N11 只掩码 pass/secret/token 类字段与
      // URL 内的 secret 类 query 参数），故原样透出；发送面必须是真实值。
      expect(service.getChannel("webhook")!.config.url).toBe(
        "https://other-instance.example.com",
      );
      expect(store.get("webhook")).toEqual({
        url: "https://other-instance.example.com",
      });
    });

    it("未知渠道键的遗留行不污染内存", async () => {
      const repo = mockRepo({
        find: jest
          .fn()
          .mockResolvedValue([
            { key: "carrier-pigeon", config: {}, enabled: true },
          ]),
      });
      const store = new ChannelConfigStore(repo as never);
      const service = await buildConfigService(store);

      expect(await service.hydrateFromPersisted()).toBe(0);
      expect(service.getAllChannels()).toHaveLength(6);
    });

    it("hydrate 失败不阻断启动（仅 warn，内存/env 语义照旧）", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      const repo = mockRepo({
        find: jest.fn().mockRejectedValue(new Error("pg down")),
      });
      const store = new ChannelConfigStore(repo as never);
      const service = await buildConfigService(store);

      await expect(service.hydrateFromPersisted()).resolves.toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("listPersisted failed"),
      );
      warnSpy.mockRestore();
    });

    it("updateChannel 保存即写穿（多实例下其余实例下一周期可见）", async () => {
      const repo = mockRepo();
      const store = new ChannelConfigStore(repo as never);
      const service = await buildConfigService(store);

      service.updateChannel("webhook", {
        enabled: true,
        config: { url: "https://saved.example.com" },
      });
      // fire-and-forget：等一拍让 promise 落地
      await new Promise((r) => setImmediate(r));

      expect(repo.upsert).toHaveBeenCalledWith(
        [
          {
            key: "webhook",
            config: { url: "https://saved.example.com" },
            enabled: true,
          },
        ],
        { conflictPaths: ["key"] },
      );
    });

    it("onModuleInit 启动即 hydrate 并登记周期刷新任务", async () => {
      const repo = mockRepo({
        find: jest
          .fn()
          .mockResolvedValue([
            { key: "webhook", config: { url: "https://saved" }, enabled: true },
          ]),
      });
      const store = new ChannelConfigStore(repo as never);
      const service = await buildConfigService(store);

      await service.onModuleInit();
      expect(store.get("webhook")).toEqual({ url: "https://saved" });
      store.onModuleDestroy(); // 清理定时器，防 jest 悬挂句柄
    });
  });
});
