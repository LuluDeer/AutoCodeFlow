import {
  findActiveMaintenanceWindow,
  lastWindowCronFireBefore,
  MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
  __resetFireScanCacheForTest,
} from "../maintenance-window.util";

/**
 * B-8（调度域审计）：最近触达扫描的结果缓存。
 *
 * 背景：配置了「维护窗口 + 时区」的任务在每次调度触发（enqueue）都会做
 * 至多 2×10081 次 Intl.formatToParts 的逐分钟回扫——同一名词在同一分钟内
 * 的答案是恒定的，重复扫描是调度热路径的实测 CPU 热点。
 *
 * 本 spec 用 Intl.DateTimeFormat.prototype.formatToParts 的调用计数作为
 * 「真实扫描是否发生」的观测点：
 * - 命中：同一分钟内重复判定，formatToParts 调用数零增长；
 * - 失效：跨分钟（键含分钟截断戳）后重新扫描，调用数增长；
 * - 有界：缓存容量封顶，超限整体清空后重新扫描仍给出正确结果。
 */

const WINDOW = [{ start: "30 2 * * *", end: "4 4 * * *" }] as const;

describe("maintenance-window fire-scan cache (B-8)", () => {
  let formatToPartsSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetFireScanCacheForTest();
    formatToPartsSpy = jest.spyOn(
      Intl.DateTimeFormat.prototype as unknown as {
        formatToParts: (...args: unknown[]) => unknown;
      },
      "formatToParts" as never,
    );
  });

  afterEach(() => {
    formatToPartsSpy.mockRestore();
    __resetFireScanCacheForTest();
  });

  it("同一分钟内的重复判定命中缓存（零新增 formatToParts 调用）", () => {
    const now = new Date("2026-06-01T10:00:30.000Z");
    findActiveMaintenanceWindow([...WINDOW], now, "Asia/Shanghai");
    const callsAfterFirst = formatToPartsSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 同一分钟（+5s）再判定：直接命中缓存，不发生任何新的分区壁钟提取
    const hitAgain = findActiveMaintenanceWindow(
      [...WINDOW],
      new Date(now.getTime() + 5_000),
      "Asia/Shanghai",
    );
    expect(formatToPartsSpy.mock.calls.length).toBe(callsAfterFirst);
    // 命中路径结果与扫描路径一致
    expect(hitAgain).toEqual(
      findActiveMaintenanceWindow([...WINDOW], now, "Asia/Shanghai"),
    );
  });

  it("跨分钟后缓存失效，重新扫描（formatToParts 调用数增长）且结果随时间正确演化", () => {
    const now = new Date("2026-06-01T10:00:30.000Z");
    findActiveMaintenanceWindow([...WINDOW], now, "Asia/Shanghai");
    const callsAfterFirst = formatToPartsSpy.mock.calls.length;

    // +70s → 下一分钟：键含分钟戳，必然重新扫描
    const nextMinute = findActiveMaintenanceWindow(
      [...WINDOW],
      new Date(now.getTime() + 70_000),
      "Asia/Shanghai",
    );
    expect(formatToPartsSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    // 结果等价于无缓存的直接实现（对下一分钟重新判定一次并比对）
    __resetFireScanCacheForTest();
    expect(nextMinute).toEqual(
      findActiveMaintenanceWindow(
        [...WINDOW],
        new Date(now.getTime() + 70_000),
        "Asia/Shanghai",
      ),
    );
  });

  it("未配置时区（本地路径）同样命中缓存，且命中不改变判定结果", () => {
    const now = new Date();
    lastWindowCronFireBefore("*/5 * * * *", now, 60, null);
    const callsAfterFirst = formatToPartsSpy.mock.calls.length;
    const again = lastWindowCronFireBefore(
      "*/5 * * * *",
      new Date(now.getTime() + 20_000),
      60,
      null,
    );
    expect(formatToPartsSpy.mock.calls.length).toBe(callsAfterFirst);
    expect(again).not.toBeNull();
  });

  it("缓存有界：塞满上限后整体清空，重新扫描仍给出正确结果（失效语义）", () => {
    const base = new Date("2026-06-01T10:00:00.000Z");
    // 用不同表达式塞爆缓存（FIRE_SCAN_CACHE_MAX=2048）
    for (let i = 0; i < 2100; i++) {
      lastWindowCronFireBefore(
        `${i % 60} */${(i % 23) + 1} * * *`,
        base,
        5,
        "UTC",
      );
    }
    // 之前缓存过的 (表达式, 分钟) 组合已被整体清空 → 重新扫描仍然正确
    const result = lastWindowCronFireBefore(
      "*/5 * * * *",
      base,
      MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
      "Asia/Shanghai",
    );
    // 10:00 UTC → 上海 18:00，最近一次 */5 触达 = 18:00（即 10:00Z）
    expect(result?.toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });

  it("窗口判定语义不受缓存影响：开窗命中与关窗判定与既有语义一致", () => {
    // 2026-06-01 18:29 上海（窗口 02:30-04:04 未开）→ 不命中
    const closed = findActiveMaintenanceWindow(
      [...WINDOW],
      new Date("2026-06-01T10:29:00.000Z"),
      "Asia/Shanghai",
    );
    expect(closed).toBeNull();
    // 与无缓存的重复调用一致（幂等）
    expect(
      findActiveMaintenanceWindow(
        [...WINDOW],
        new Date("2026-06-01T10:29:00.000Z"),
        "Asia/Shanghai",
      ),
    ).toBeNull();
  });
});
