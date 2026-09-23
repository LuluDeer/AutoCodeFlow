import {
  DEVICE_FINGERPRINT_HEX_LENGTH,
  FINGERPRINT_ALERT_THROTTLE_MS,
  FINGERPRINT_ENTRY_TTL_MS,
  MAX_FINGERPRINTS_PER_ADDRESS,
  MAX_TRACKED_ADDRESSES,
  createDeviceFingerprintTracker,
  normalizeDeviceFingerprint,
} from "../executor-fingerprint.util";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const FP_C = "c".repeat(64);
const ADDR_1 = "192.168.1.100:8002";
const ADDR_2 = "192.168.4.54:8003";

describe("ARCH-36 normalizeDeviceFingerprint（ADR-017 阶段 2）", () => {
  it("接受 64 位十六进制（大小写不限）并规范化为小写", () => {
    expect(normalizeDeviceFingerprint(FP_A)).toBe(FP_A);
    expect(normalizeDeviceFingerprint("A".repeat(64))).toBe(FP_A);
    expect(
      normalizeDeviceFingerprint(
        "3F2A1C9D8B7E6F504132A5B6C7D8E9F00A1B2C3D4E5F60718293A4B5C6D7E8F9",
      ),
    ).toBe("3f2a1c9d8b7e6f504132a5b6c7d8e9f00a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("剥离首尾空白（执行器侧常见 \\n 收尾）", () => {
    expect(normalizeDeviceFingerprint(`  ${FP_A}\n`)).toBe(FP_A);
  });

  it.each([
    ["长度不足", "a".repeat(63)],
    ["长度超出", "a".repeat(65)],
    ["非十六进制字符", `${"z".repeat(63)}a`],
    ["空串", ""],
    ["纯空白", "   "],
    ["带冒号的非法形态", `${FP_A.slice(0, 63)}:`],
  ])("拒绝非法形态：%s", (_label, value) => {
    expect(normalizeDeviceFingerprint(value)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["数字", 12345],
    ["对象", { fingerprint: FP_A }],
    ["数组", [FP_A]],
    ["布尔", true],
  ])("拒绝非字符串：%s", (_label, value) => {
    expect(normalizeDeviceFingerprint(value)).toBeNull();
  });

  it("长度常量与 sha256 十六进制契约一致（admin 列宽同源）", () => {
    expect(DEVICE_FINGERPRINT_HEX_LENGTH).toBe(64);
    expect(FP_A).toHaveLength(DEVICE_FINGERPRINT_HEX_LENGTH);
  });
});

describe("ARCH-36 DeviceFingerprintTracker", () => {
  const t0 = 1_700_000_000_000;

  it("首次上报：无冲突无漂移", () => {
    const tracker = createDeviceFingerprintTracker();
    const obs = tracker.observe(ADDR_1, FP_A, t0);
    expect(obs).toMatchObject({
      fingerprint: FP_A,
      address: ADDR_1,
      fingerprintsOnAddress: 1,
      addressesForFingerprint: 1,
      addressSharedByMultipleInstalls: false,
      addressDrifted: false,
      throttled: false,
    });
  });

  it("同一指纹反复上报（心跳主路径）：零冲突零误报", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    for (let i = 1; i <= 10; i++) {
      const obs = tracker.observe(ADDR_1, FP_A, t0 + i * 30_000);
      expect(obs?.addressSharedByMultipleInstalls).toBe(false);
      expect(obs?.throttled).toBe(false);
      expect(obs?.fingerprintsOnAddress).toBe(1);
    }
  });

  it("**正常重启**（同指纹、换 startupId）不产生冲突——这是判据优于 P0 时序法的核心", () => {
    // deviceFingerprint 跨重启不变：重启只换 startupId，指纹不动。
    // 因此本判据不会像「同 address 出现不同 startupId」那样把每次重启当冲突。
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    const afterRestart = tracker.observe(ADDR_1, FP_A, t0 + 60_000);
    expect(afterRestart?.addressSharedByMultipleInstalls).toBe(false);
  });

  it("同一地址出现第二个指纹 → 硬冲突，且**持续**可检出（不会第二次心跳就痊愈）", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    const first = tracker.observe(ADDR_1, FP_B, t0 + 1000);
    expect(first).toMatchObject({
      addressSharedByMultipleInstalls: true,
      fingerprintsOnAddress: 2,
    });

    // 两台机器并存会持续交替上报：冲突必须一直为真（与 P0 的持续检出语义一致）
    const later = tracker.observe(ADDR_1, FP_A, t0 + 2000);
    expect(later?.addressSharedByMultipleInstalls).toBe(true);
    const laterB = tracker.observe(ADDR_1, FP_B, t0 + 3000);
    expect(laterB?.addressSharedByMultipleInstalls).toBe(true);
  });

  it("冲突观测带出并存双方的完整指纹清单（运维处置面，不只是计数）", () => {
    // 只报"有 2 台机器共用这一行"而不说是哪两台，运维仍要手工翻日志关联；
    // 清单是「给每台机器分配唯一 EXECUTOR_ADDRESS_PUBLIC」的直接输入。
    const tracker = createDeviceFingerprintTracker();
    const single = tracker.observe(ADDR_1, FP_A, t0);
    expect(single?.distinctFingerprintsOnAddress).toEqual([FP_A]);

    const conflicted = tracker.observe(ADDR_1, FP_B, t0 + 1000);
    // 按首次出现先后排列：A 先进，B 后进。
    expect(conflicted?.distinctFingerprintsOnAddress).toEqual([FP_A, FP_B]);
    expect(conflicted?.distinctFingerprintsOnAddress).toHaveLength(
      conflicted!.fingerprintsOnAddress,
    );

    // 重复上报不产生重复条目（是"并存安装集合"，不是上报流水）。
    const repeated = tracker.observe(ADDR_1, FP_A, t0 + 2000);
    expect(repeated?.distinctFingerprintsOnAddress).toEqual([FP_A, FP_B]);
  });

  it("冲突告警按 (address, fingerprint) 节流：窗口内只应外发一次", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    // 第一次带 B 上报 → 应告警（throttled=false）
    expect(tracker.observe(ADDR_1, FP_B, t0 + 1000)?.throttled).toBe(false);
    // 窗口内重复 → 节流
    expect(
      tracker.observe(
        ADDR_1,
        FP_B,
        t0 + 1000 + FINGERPRINT_ALERT_THROTTLE_MS - 1,
      )?.throttled,
    ).toBe(true);
    // 超出窗口 → 重新外发一次（冲突仍在，不能被永久静音）
    expect(
      tracker.observe(
        ADDR_1,
        FP_B,
        t0 + 1000 + FINGERPRINT_ALERT_THROTTLE_MS + 1,
      )?.throttled,
    ).toBe(false);
  });

  it("节流按 fingerprint 分键：A 被节流不影响 B 的告警", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    tracker.observe(ADDR_1, FP_B, t0 + 1000); // B 首次告警
    tracker.observe(ADDR_1, FP_B, t0 + 2000); // B 被节流
    tracker.observe(ADDR_1, FP_C, t0 + 3000); // C 是新指纹 → 应告警
    // 注意：C 的上报把 fingerprintsOnAddress 变为 3，但节流按 fingerprint 键控
    expect(tracker.observe(ADDR_1, FP_C, t0 + 4000)?.throttled).toBe(true);
  });

  it("地址漂移：同一指纹换成新地址 → drift 为真，且**不是**冲突", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    const drifted = tracker.observe(ADDR_2, FP_A, t0 + 1000);
    expect(drifted).toMatchObject({
      addressDrifted: true,
      addressSharedByMultipleInstalls: false,
      addressesForFingerprint: 2,
    });
  });

  it("漂移只在**新地址首次出现**那一刻为真（持续为真会让日志没有信息量）", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    expect(tracker.observe(ADDR_2, FP_A, t0 + 1000)?.addressDrifted).toBe(true);
    expect(tracker.observe(ADDR_2, FP_A, t0 + 2000)?.addressDrifted).toBe(
      false,
    );
    expect(tracker.observe(ADDR_1, FP_A, t0 + 3000)?.addressDrifted).toBe(
      false,
    );
  });

  it("存量执行器（指纹缺省/非法）：不算冲突、不计入统计分母、不动日志面", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    expect(tracker.observe(ADDR_1, undefined, t0 + 1)).toBeNull();
    expect(tracker.observe(ADDR_1, null, t0 + 2)).toBeNull();
    expect(tracker.observe(ADDR_1, "not-a-fingerprint", t0 + 3)).toBeNull();
    expect(tracker.observe("", FP_A, t0 + 4)).toBeNull();
    // 缺省上报不产生第二个"指纹"，因此不制造假冲突
    expect(
      tracker.observe(ADDR_1, FP_A, t0 + 5)?.addressSharedByMultipleInstalls,
    ).toBe(false);
    // 但 reports 计数包含它们（覆盖率口径的分母：reportsWithFingerprint / reports
    // 就是"v3 执行器里到底有多少台真的采集到了"这个指标）。
    // 本用例共 6 次 observe：2 次带合法指纹（t0、t0+5），4 次缺省/非法。
    expect(tracker.stats().reports).toBe(6);
    expect(tracker.stats().reportsWithFingerprint).toBe(2);
  });

  it("stats(): 冲突率口径 = 多指纹地址数 / 已登记地址数", () => {
    const tracker = createDeviceFingerprintTracker();
    expect(tracker.stats().conflictRate).toBe(0); // 分母为 0 不得除零

    tracker.observe(ADDR_1, FP_A, t0); // 干净地址
    tracker.observe(ADDR_2, FP_A, t0 + 1); // 同指纹换址 → 漂移，不是冲突
    expect(tracker.stats()).toMatchObject({
      trackedAddresses: 2,
      addressesWithMultipleFingerprints: 0,
      conflictRate: 0,
      trackedFingerprints: 1,
      fingerprintsOnMultipleAddresses: 1,
    });

    tracker.observe(ADDR_2, FP_B, t0 + 2); // 地址 2 出现第二个指纹 → 冲突
    expect(tracker.stats()).toMatchObject({
      trackedAddresses: 2,
      addressesWithMultipleFingerprints: 1,
      conflictRate: 0.5,
    });
  });

  it("每地址指纹表有界：超过上限按最旧 FIFO 淘汰（长跑内存不无界）", () => {
    const tracker = createDeviceFingerprintTracker();
    const distinct = MAX_FINGERPRINTS_PER_ADDRESS + 4;
    for (let i = 0; i < distinct; i++) {
      tracker.observe(ADDR_1, i.toString(16).padStart(64, "0"), t0 + i);
    }
    const obs = tracker.observe(ADDR_1, "f".repeat(64), t0 + distinct);
    expect(obs?.fingerprintsOnAddress).toBeLessThanOrEqual(
      MAX_FINGERPRINTS_PER_ADDRESS,
    );
  });

  it("惰性 TTL 清扫：过期地址条目与其反向索引一并清除", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    expect(tracker.size).toBe(1);
    // 触发一次清扫（下一条上报的时刻已越过 TTL）
    tracker.observe(ADDR_2, FP_B, t0 + FINGERPRINT_ENTRY_TTL_MS + 1);
    expect(tracker.size).toBe(1); // ADDR_1 已过期被清，只剩 ADDR_2
    expect(tracker.stats().trackedFingerprints).toBe(1);
  });

  it("地址表满时淘汰最久未更新条目（有界，不无界增长）", () => {
    const tracker = createDeviceFingerprintTracker();
    for (let i = 0; i < MAX_TRACKED_ADDRESSES; i++) {
      tracker.observe(`10.0.${Math.floor(i / 256)}.${i % 256}:1`, FP_A, t0 + i);
    }
    expect(tracker.size).toBe(MAX_TRACKED_ADDRESSES);
    // 再插一个新地址 → 触发淘汰，规模不增长
    tracker.observe("10.9.9.9:1", FP_A, t0 + MAX_TRACKED_ADDRESSES);
    expect(tracker.size).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
  });

  it("reset() 清空全部状态（防用例间隐性顺序依赖）", () => {
    const tracker = createDeviceFingerprintTracker();
    tracker.observe(ADDR_1, FP_A, t0);
    tracker.observe(ADDR_1, FP_B, t0 + 1);
    expect(tracker.size).toBe(1);
    tracker.reset();
    expect(tracker.size).toBe(0);
    expect(tracker.stats()).toMatchObject({
      reports: 0,
      trackedAddresses: 0,
      conflictRate: 0,
    });
  });

  it("每个跟踪器实例状态独立（实例字段而非模块级单例）", () => {
    const a = createDeviceFingerprintTracker();
    const b = createDeviceFingerprintTracker();
    a.observe(ADDR_1, FP_A, t0);
    // b 未观测过 ADDR_1，因此"第二个指纹"对 b 而言是首个
    expect(b.observe(ADDR_1, FP_B, t0)?.addressSharedByMultipleInstalls).toBe(
      false,
    );
    expect(a.stats().trackedAddresses).toBe(1);
    expect(b.stats().trackedAddresses).toBe(1);
  });
});
