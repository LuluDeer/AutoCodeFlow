import { AppModule } from "./app.module";

/**
 * OPS-P1: BullMQ 根配置必须携带 defaultJobOptions 终态保留策略——
 * cron/fixed_rate 任务每 tick 入队一个 job，无保留策略时 completed/failed
 * 集合在 Redis 无界增长。
 *
 * 不 bootstrap 整个应用：BullModule.forRootAsync 返回的 DynamicModule 的
 * providers 中，shared-config provider 的 useFactory 就是 @Module imports
 * 里写的工厂函数本身（@nestjs/bullmq createAsyncSharedConfigurationProvider
 * 直接透传），用桩 ConfigService 调用即可断言产出。
 */
describe("AppModule — BullMQ root config (OPS-P1)", () => {
  const getBullRootOptions = (
    config: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const imports = (Reflect.getMetadata("imports", AppModule) ??
      []) as Array<Record<string, unknown>>;
    const bullRoot = imports.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { module?: { name?: string } }).module?.name === "BullModule" &&
        Array.isArray((m as { providers?: unknown[] }).providers),
    ) as unknown as {
      providers: Array<{ useFactory?: (...args: unknown[]) => unknown }>;
    } | undefined;
    if (!bullRoot) {
      throw new Error(
        "BullModule.forRootAsync dynamic module not found in AppModule imports",
      );
    }
    const provider = bullRoot.providers.find(
      (p) => typeof p?.useFactory === "function",
    );
    if (!provider?.useFactory) {
      throw new Error("async shared-config provider not found");
    }
    const cfg = { get: (key: string) => config[key] };
    return provider.useFactory(cfg) as Record<string, unknown>;
  };

  it("declares removeOnComplete/removeOnFail retention for terminal jobs", () => {
    const options = getBullRootOptions({
      "redis.host": "127.0.0.1",
      "redis.port": 6379,
    });
    expect(options.defaultJobOptions).toEqual({
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 },
    });
  });

  it("keeps the redis connection block intact alongside the new defaults", () => {
    const options = getBullRootOptions({
      "redis.host": "127.0.0.1",
      "redis.port": 6379,
    });
    expect(options.connection).toMatchObject({
      host: "127.0.0.1",
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });
});
