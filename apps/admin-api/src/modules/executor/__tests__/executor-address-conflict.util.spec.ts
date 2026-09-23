import {
  ExecutorAddressConflictTracker,
  MAX_DISPLACED_PER_ADDRESS,
  MAX_TRACKED_ADDRESSES,
  ADDRESS_ENTRY_TTL_MS,
  CONFLICT_ALERT_THROTTLE_MS,
} from "../executor-address-conflict.util";

/**
 * ARCH-34 P0（生产事故 2026-09-23）：address 冲突检测判据。
 *
 * 核心不变量（本文件即该不变量的可执行规格）：
 *   1. 真实重启（新 startupId 顶替旧的，旧的一去不返）**绝不**告警；
 *   2. 被顶替的进程生命**复活**（同 address 上两个活进程并存）**必须**告警；
 *   3. startupId 缺省的旧执行器**零影响**（不跟踪、不判定、不告警）。
 *
 * 判据 1 是防误报的红线：把"不同 startupId"直接当冲突会让每次执行器重启都
 * 告警，告警很快被运维忽略（狼来了），等于没有检测。
 */

const ADDR = "192.168.1.100:8002";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

describe("ExecutorAddressConflictTracker", () => {
  let tracker: ExecutorAddressConflictTracker;
  let now: number;

  beforeEach(() => {
    tracker = new ExecutorAddressConflictTracker();
    now = 1_700_000_000_000;
  });

  /** 首次见到某地址：登记为 current，无冲突。 */
  it("首次上报不判冲突并登记为当前进程", () => {
    const obs = tracker.observe(ADDR, A, now);
    expect(obs).toMatchObject({
      conflict: false,
      startupId: A,
      displacedStartupId: null,
      throttled: false,
    });
  });

  /** 心跳主路径：同一进程生命重复上报，恒不冲突。 */
  it("同一 startupId 重复上报（心跳主路径）不判冲突", () => {
    tracker.observe(ADDR, A, now);
    for (let i = 1; i <= 5; i++) {
      const obs = tracker.observe(ADDR, A, now + i * 30_000);
      expect(obs?.conflict).toBe(false);
    }
  });

  /**
   * 防误报红线：B 顶替 A 是**正常重启**的形状（旧进程死掉、新进程新 id），
   * 不得告警。
   */
  it("真实重启（新 startupId 接管）不判冲突", () => {
    tracker.observe(ADDR, A, now);
    const obs = tracker.observe(ADDR, B, now + 1_000);
    expect(obs).toMatchObject({
      conflict: false,
      startupId: B,
      displacedStartupId: A,
    });
  });

  /**
   * 核心判据：A 被 B 顶替后又回来上报 → A 本该已死却仍在说话 → 两个活进程
   * 并存于同一 address（正是串台场景）。
   */
  it("被顶替的进程生命复活 → 判冲突（A/B 并存）", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000); // B 顶替 A（正常）
    const obs = tracker.observe(ADDR, A, now + 2_000); // A 复活 → 冲突
    expect(obs).toMatchObject({
      conflict: true,
      startupId: A,
      displacedStartupId: B,
      throttled: false,
    });
  });

  /**
   * 冲突必须**持续可判**，不能是一次性的：A、B 并存时 A 的每一轮心跳都应
   * 命中冲突（由节流控制外发频率），否则并存会在一轮之后静默。
   */
  it("并存期间冲突持续可判（非一次性）", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    expect(tracker.observe(ADDR, A, now + 2_000)?.conflict).toBe(true);
    expect(tracker.observe(ADDR, A, now + 32_000)?.conflict).toBe(true);
    expect(tracker.observe(ADDR, A, now + 62_000)?.conflict).toBe(true);
  });

  /**
   * 判据**刻意非对称**：只有「非最新持有者」的复活被计为冲突，最新持有者的
   * 上报恒为稳态。这不是疏漏，而是防**陈旧误报**的必要设计——
   *
   * 反例推演：若双向都判冲突，则 A 被 B 顶替、A 随后正常下线后，B 仍会因
   * 「A 曾存在」被永久判为冲突，产生无法自愈的假告警。当前语义下，一旦
   * 最新持有者成为唯一存活者，冲突自然消失（见下一个用例）。
   */
  it("最新持有者的上报恒为稳态（非对称判据，防陈旧误报）", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000); // B 成为最新持有者
    expect(tracker.observe(ADDR, B, now + 2_000)?.conflict).toBe(false);
  });

  /**
   * 冲突**自愈**：A 复活被检出后 A 真正下线，B 单独存活 → 冲突消失，
   * 不得留下永久告警。
   */
  it("冲突可自愈：败者下线后不再告警", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    expect(tracker.observe(ADDR, A, now + 2_000)?.conflict).toBe(true);
    // A 下线，此后只有 B 上报。
    for (let i = 1; i <= 5; i++) {
      expect(tracker.observe(ADDR, B, now + 2_000 + i * 30_000)?.conflict).toBe(
        false,
      );
    }
  });

  /**
   * 三方争用：A→B→C 后 A 复活仍须命中。只记"上一个被顶替者"的实现会在此漏报
   * （A 在 B→C 顶替时被遗忘）——这正是 displaced 用整表而非单值的原因。
   */
  it("三方争用后最早的进程复活仍判冲突（不因中间顶替而遗忘）", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    tracker.observe(ADDR, C, now + 2_000);
    const obs = tracker.observe(ADDR, A, now + 3_000);
    expect(obs?.conflict).toBe(true);
    expect(obs?.otherStartupIds).toBeGreaterThanOrEqual(2);
  });

  /** 兼容性红线：未上报 startupId 的旧执行器零影响。 */
  it("startupId 缺省/空白 → 返回 null，不跟踪不判定", () => {
    expect(tracker.observe(ADDR, null, now)).toBeNull();
    expect(tracker.observe(ADDR, undefined, now)).toBeNull();
    expect(tracker.observe(ADDR, "   ", now)).toBeNull();
    expect(tracker.size).toBe(0);
  });

  /** 空地址不跟踪（防御性：地址缺失时无从判定）。 */
  it("空 address 返回 null", () => {
    expect(tracker.observe("", A, now)).toBeNull();
  });

  /** 首尾空白应被规范化，避免 " a " 与 "a" 被当成两个进程生命。 */
  it("startupId 首尾空白被规范化（同一进程不因空白误判）", () => {
    tracker.observe(ADDR, A, now);
    expect(tracker.observe(ADDR, `  ${A}  `, now + 1_000)?.conflict).toBe(
      false,
    );
  });

  /** 不同地址互不干扰（避免把两台无关机器的重启误判为冲突）。 */
  it("不同 address 的进程生命互不影响", () => {
    tracker.observe("10.0.0.1:8002", A, now);
    const obs = tracker.observe("10.0.0.2:8002", B, now + 1_000);
    expect(obs?.conflict).toBe(false);
  });

  /** 告警节流：同一 (address, startupId) 窗口内只应告警一次。 */
  it("同一组合在节流窗口内只告警一次", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    const first = tracker.observe(ADDR, A, now + 2_000);
    expect(first).toMatchObject({ conflict: true, throttled: false });
    const second = tracker.observe(ADDR, A, now + 3_000);
    expect(second).toMatchObject({ conflict: true, throttled: true });
  });

  /** 节流窗口过后应再次告警（持续并存不能被永久静默）。 */
  it("节流窗口过后重新告警", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    expect(tracker.observe(ADDR, A, now + 2_000)?.throttled).toBe(false);
    const later = tracker.observe(
      ADDR,
      A,
      now + 2_000 + CONFLICT_ALERT_THROTTLE_MS + 1,
    );
    expect(later).toMatchObject({ conflict: true, throttled: false });
  });

  /** 节流按 (address, startupId) 分键：不同地址的同名进程互不压制。 */
  it("节流按地址分键，互不压制", () => {
    const addr2 = "10.0.0.9:8002";
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    tracker.observe(addr2, A, now + 1_000);
    tracker.observe(addr2, C, now + 2_000);
    expect(tracker.observe(ADDR, A, now + 3_000)?.throttled).toBe(false);
    expect(tracker.observe(addr2, A, now + 4_000)?.throttled).toBe(false);
  });

  /** 有界性：每地址被顶替表不超过上限（FIFO 淘汰最旧）。 */
  it("每地址 displaced 表有界（超限 FIFO 淘汰，仍保留近期者）", () => {
    tracker.observe(ADDR, "sid-0", now);
    for (let i = 1; i <= MAX_DISPLACED_PER_ADDRESS + 5; i++) {
      tracker.observe(ADDR, `sid-${i}`, now + i * 1_000);
    }
    // 最早被顶替的 sid-0 应已被淘汰（不再判冲突）……
    const ancient = tracker.observe(
      ADDR,
      "sid-0",
      now + (MAX_DISPLACED_PER_ADDRESS + 6) * 1_000,
    );
    expect(ancient?.conflict).toBe(false);
    // ……但近期被顶替者仍在表内，复活仍可判。
    const recent = tracker.observe(
      ADDR,
      `sid-${MAX_DISPLACED_PER_ADDRESS}`,
      now + (MAX_DISPLACED_PER_ADDRESS + 7) * 1_000,
    );
    expect(recent?.conflict).toBe(true);
  });

  /** 有界性：地址表不超过上限（不因攻击者刷地址而无界增长）。 */
  it("地址表有界（超限淘汰最久未更新者）", () => {
    for (let i = 0; i < MAX_TRACKED_ADDRESSES + 10; i++) {
      tracker.observe(
        `10.0.${Math.floor(i / 250)}.${i % 250}:8002`,
        A,
        now + i,
      );
    }
    expect(tracker.size).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
  });

  /** 惰性 TTL：过期地址被清除，重新出现视为首次（不残留陈旧冲突状态）。 */
  it("超过 TTL 未上报的地址被惰性清除", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    expect(tracker.size).toBe(1);

    // 另一地址的写入触发清扫；此时 ADDR 已过期。
    tracker.observe("10.0.0.5:8002", C, now + ADDRESS_ENTRY_TTL_MS + 10_000);
    expect(tracker.size).toBe(1);

    // ADDR 重新出现 = 首次见到，不判冲突（陈旧 displaced 已被清除）。
    const obs = tracker.observe(ADDR, A, now + ADDRESS_ENTRY_TTL_MS + 20_000);
    expect(obs).toMatchObject({ conflict: false, displacedStartupId: null });
  });

  /** reset() 清空全部状态（测试隔离用）。 */
  it("reset 清空状态", () => {
    tracker.observe(ADDR, A, now);
    tracker.observe(ADDR, B, now + 1_000);
    expect(tracker.size).toBe(1);
    tracker.reset();
    expect(tracker.size).toBe(0);
    expect(tracker.observe(ADDR, A, now + 2_000)?.conflict).toBe(false);
  });
});
