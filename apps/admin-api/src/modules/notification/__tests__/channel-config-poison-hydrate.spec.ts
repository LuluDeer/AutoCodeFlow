import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { NotificationConfigService } from "../notification-config.service";
import { NotificationService } from "../notification.service";
import { ChannelConfigStore } from "../channel-config.store";

/**
 * P2-3（2026-10-25 审计）：hydrateFromPersisted 的存量毒值防御。
 *
 * 缺陷现场：历史版本（F-53 残留窗口）曾让非 string 的 config 值写穿 DB
 * （jsonb 不挑类型，PATCH 端点当时无校验）。回灌路径把行原样灌进内存，
 * 读面 maskChannel 对非 string 调 replace 抛 TypeError → GET /channels
 * **持续 500**——一条历史坏键把整条渠道配置读面扣死。修复：非 string 值
 * 跳过并 warn，不让单个坏键打挂读面（合法值照常应用）。
 */
describe("NotificationConfigService.hydrateFromPersisted — 毒值防御（P2-3）", () => {
  const buildService = async (rows: unknown[]) => {
    const repo = {
      find: jest.fn().mockResolvedValue(rows),
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const store = new ChannelConfigStore(repo as never);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationConfigService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: NotificationService,
          useValue: { sendAll: jest.fn(), sendToChannels: jest.fn() },
        },
        { provide: ChannelConfigStore, useValue: store },
      ],
    }).compile();
    const service = module.get<NotificationConfigService>(
      NotificationConfigService,
    );
    return { service, store };
  };

  it("非 string 值被跳过并 warn：读面不再 500，合法键照常应用", async () => {
    const { service } = await buildService([
      {
        key: "webhook",
        // 混合形态：坏值（数字/嵌套对象）+ 合法值
        config: { url: "https://ok.example.com", port: 587, nested: { a: 1 } },
        enabled: true,
      },
    ]);
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        "warn",
      )
      .mockImplementation(() => {});

    const applied = await service.hydrateFromPersisted();

    expect(applied).toBe(1); // 行仍被应用（坏键剔除，不整体丢弃）
    const channel = service.getChannel("webhook")!;
    expect(channel.config.url).toBe("https://ok.example.com");
    expect(channel.config).not.toHaveProperty("port");
    expect(channel.config).not.toHaveProperty("nested");
    // warn 留现场证据：键名 + 类型，便于运维定位清理
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("webhook.port"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("number"));
    warnSpy.mockRestore();
  });

  it("全部值合法 → 行为与修复前逐字节一致", async () => {
    const { service, store } = await buildService([
      {
        key: "slack",
        config: { webhookUrl: "https://hooks/x" },
        enabled: true,
      },
    ]);
    const applied = await service.hydrateFromPersisted();
    expect(applied).toBe(1);
    expect(service.getChannel("slack")!.config.webhookUrl).toBe(
      "https://hooks/x",
    );
    // 发送面同步：store 侧拿到同一份 RAW 值
    expect(store.get("slack")).toEqual({ webhookUrl: "https://hooks/x" });
  });

  it("未知渠道键的遗留行仍不污染内存（既有语义不变）", async () => {
    const { service } = await buildService([
      { key: "carrier-pigeon", config: { url: "x" }, enabled: true },
    ]);
    expect(await service.hydrateFromPersisted()).toBe(0);
  });
});
