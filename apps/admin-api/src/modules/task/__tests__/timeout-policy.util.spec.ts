import {
  normalizeTimeoutAction,
  normalizeTimeoutWarnRatio,
  timeoutWarnThresholdMs,
  DEFAULT_TIMEOUT_ACTION,
  DEFAULT_TIMEOUT_WARN_RATIO,
  TIMEOUT_ACTIONS,
  TIMEOUT_WARN_RATIO_MAX,
  TIMEOUT_WARN_RATIO_MIN,
} from "../timeout-policy.util";

/**
 * CORE-04: 超时策略分级——纯决策逻辑单测。覆盖：
 *  - timeoutAction 归一化（缺省 kill、非法值兜底、大小写/空白容忍）；
 *  - timeoutWarnRatio 归一化（0-90 有效、非法 → null=未启用）；
 *  - 预警阈值判定（80% 阈值命中/未命中、timeout=0 不限时、负 elapsed）。
 */

describe("timeout-policy.util（CORE-04）", () => {
  describe("normalizeTimeoutAction", () => {
    it("缺省/未知/null → kill（与既有单级树杀行为一致）", () => {
      expect(normalizeTimeoutAction(undefined)).toBe(DEFAULT_TIMEOUT_ACTION);
      expect(normalizeTimeoutAction(null)).toBe(DEFAULT_TIMEOUT_ACTION);
      expect(normalizeTimeoutAction("")).toBe(DEFAULT_TIMEOUT_ACTION);
      expect(normalizeTimeoutAction("nonsense")).toBe(DEFAULT_TIMEOUT_ACTION);
      expect(normalizeTimeoutAction(42)).toBe(DEFAULT_TIMEOUT_ACTION);
      expect(DEFAULT_TIMEOUT_ACTION).toBe("kill");
    });

    it("合法三值原样返回，大小写/空白容忍", () => {
      expect(normalizeTimeoutAction("kill")).toBe("kill");
      expect(normalizeTimeoutAction("kill_retry")).toBe("kill_retry");
      expect(normalizeTimeoutAction("notify_only")).toBe("notify_only");
      expect(normalizeTimeoutAction(" KILL ")).toBe("kill");
      expect(normalizeTimeoutAction("Notify_Only")).toBe("notify_only");
      expect(normalizeTimeoutAction("KILL_RETRY")).toBe("kill_retry");
    });

    it("值域表完整且含三动作", () => {
      expect(TIMEOUT_ACTIONS).toEqual(["kill", "kill_retry", "notify_only"]);
    });
  });

  describe("normalizeTimeoutWarnRatio", () => {
    it("0..90 整数原样返回（0 = 入队即预警的边界值）", () => {
      expect(normalizeTimeoutWarnRatio(0)).toBe(0);
      expect(normalizeTimeoutWarnRatio(80)).toBe(80);
      expect(normalizeTimeoutWarnRatio(TIMEOUT_WARN_RATIO_MAX)).toBe(90);
      expect(TIMEOUT_WARN_RATIO_MIN).toBe(0);
      expect(DEFAULT_TIMEOUT_WARN_RATIO).toBe(80);
    });

    it("非法形态一律归 null（未启用预警）", () => {
      expect(normalizeTimeoutWarnRatio(null)).toBeNull();
      expect(normalizeTimeoutWarnRatio(undefined)).toBeNull();
      expect(normalizeTimeoutWarnRatio(-1)).toBeNull();
      expect(normalizeTimeoutWarnRatio(91)).toBeNull();
      expect(normalizeTimeoutWarnRatio(80.5)).toBeNull();
      expect(normalizeTimeoutWarnRatio("80" as unknown)).toBeNull();
    });
  });

  describe("timeoutWarnThresholdMs", () => {
    it("运行时长达到 timeout×ratio/100 即命中并返回阈值毫秒", () => {
      // timeout=60s, ratio=80 → 阈值 48000ms
      expect(timeoutWarnThresholdMs(60, 80, 48_000)).toBe(48_000);
      expect(timeoutWarnThresholdMs(60, 80, 60_000)).toBe(48_000);
      expect(timeoutWarnThresholdMs(60, 50, 30_001)).toBe(30_000);
    });

    it("未达阈值 → null", () => {
      expect(timeoutWarnThresholdMs(60, 80, 47_999)).toBeNull();
      expect(timeoutWarnThresholdMs(60, 80, 0)).toBeNull();
    });

    it("timeout<=0（不限时）/比例无效/负时长 → 永不预警", () => {
      expect(timeoutWarnThresholdMs(0, 80, 1_000_000)).toBeNull();
      expect(timeoutWarnThresholdMs(null, 80, 1_000)).toBeNull();
      expect(timeoutWarnThresholdMs(undefined, 80, 1_000)).toBeNull();
      expect(timeoutWarnThresholdMs(60, null, 1_000_000)).toBeNull();
      expect(timeoutWarnThresholdMs(60, 200, 1_000_000)).toBeNull();
      expect(timeoutWarnThresholdMs(60, 80, -1)).toBeNull();
    });
  });
});
