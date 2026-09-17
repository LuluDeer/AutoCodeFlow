import {
  RUNTIME_VERSION_PATTERN,
  DEFAULT_RUNTIME_VERSION_MIN,
  DEFAULT_RUNTIME_VERSION_MAX,
  ONLINE_DOWNLOAD_MIN,
  RUNTIME_VERSION_MIN_ENV,
  RUNTIME_VERSION_MAX_ENV,
  isValidRuntimeVersionFormat,
  isRuntimeVersionSupported,
  isOnlineDownloadable,
  compareRuntimeVersion,
  getSupportedRange,
  buildUnsupportedVersionMessage,
} from "../runtime-version.util";

/**
 * python_task_multiversion（WS1）：runtime-version.util 的契约判据。
 *
 * 本模块是 DTO 边界 / service 写面 / 提示文案三处共用的**单一事实源**
 * （CONTRACT §3.1），故逐条钉住：
 * - 格式判据（D1 `^\d+\.\d+$`）；
 * - 可声明区间 3.7~3.14 与在线可下载下界 3.8 的**语义区分**（T01 实测修正）；
 * - 数值比较而非字典序（`3.9 < 3.12`——字典序会判反，是这类工具的经典坑）；
 * - env 覆盖的容错（非法配置回退缺省，绝不让写面 500）。
 */
describe("runtime-version.util", () => {
  const originalMin = process.env[RUNTIME_VERSION_MIN_ENV];
  const originalMax = process.env[RUNTIME_VERSION_MAX_ENV];

  afterEach(() => {
    // env 直读在 spec 内合法（.eslintrc.js 的 ARCH-27 豁免覆盖 **/*.spec.ts）。
    if (originalMin === undefined) delete process.env[RUNTIME_VERSION_MIN_ENV];
    else process.env[RUNTIME_VERSION_MIN_ENV] = originalMin;
    if (originalMax === undefined) delete process.env[RUNTIME_VERSION_MAX_ENV];
    else process.env[RUNTIME_VERSION_MAX_ENV] = originalMax;
  });

  describe("格式判据（D1：主.次，无补丁号）", () => {
    it("RUNTIME_VERSION_PATTERN 与契约 §1.1 逐字节一致", () => {
      expect(RUNTIME_VERSION_PATTERN.source).toBe("^\\d+\\.\\d+$");
    });

    it.each(["3.7", "3.8", "3.12", "3.13", "3.14", "10.0", "3.10"])(
      "接受合法版本 %s",
      (v) => {
        expect(isValidRuntimeVersionFormat(v)).toBe(true);
      },
    );

    it.each([
      // 补丁号：D1 明确禁止（"3.7.9" 是执行器**探测**所得，不是**声明**形态）
      "3.7.9",
      // 前后缀
      "v3.7",
      " 3.7",
      "3.7 ",
      "3",
      "3.",
      ".7",
      "3.7a",
      "python3.7",
      // 通配/区间
      "^3.7",
      "~3.7",
      ">=3.7",
      "3.x",
      // 空值
      "",
      // 多段
      "3.7.9.1",
    ])("拒绝非法版本 %j", (v) => {
      expect(isValidRuntimeVersionFormat(v)).toBe(false);
    });

    it("非字符串输入不抛错（运行态兜底）", () => {
      expect(isValidRuntimeVersionFormat(null as unknown as string)).toBe(
        false,
      );
      expect(isValidRuntimeVersionFormat(undefined as unknown as string)).toBe(
        false,
      );
      expect(isValidRuntimeVersionFormat(37 as unknown as string)).toBe(false);
    });
  });

  describe("compareRuntimeVersion（数值比较，非字典序）", () => {
    // 这是本工具最容易写错的地方：字符串比较下 "3.9" > "3.12"，而正确语义
    // 恰好相反。区间判定完全建立在比较之上，判反会让 3.9 被误判为"超出上界"。
    it("3.9 < 3.12（字典序会判反）", () => {
      expect(compareRuntimeVersion("3.9", "3.12")).toBeLessThan(0);
      expect(compareRuntimeVersion("3.12", "3.9")).toBeGreaterThan(0);
      expect("3.9" < "3.12").toBe(false); // 反证：字符串比较确实判反
    });

    it("3.10 介于 3.9 与 3.11 之间", () => {
      expect(compareRuntimeVersion("3.10", "3.9")).toBeGreaterThan(0);
      expect(compareRuntimeVersion("3.10", "3.11")).toBeLessThan(0);
    });

    it("相等返回 0（含主版本相同、次版本数值相同）", () => {
      expect(compareRuntimeVersion("3.7", "3.7")).toBe(0);
      expect(compareRuntimeVersion("3.07", "3.7")).toBe(0); // 数值等价
    });

    it("主版本优先于次版本", () => {
      expect(compareRuntimeVersion("4.0", "3.99")).toBeGreaterThan(0);
      expect(compareRuntimeVersion("2.99", "3.0")).toBeLessThan(0);
    });

    it("非法值参与比较时结果确定（非法 < 合法，不产生 NaN 随机序）", () => {
      expect(compareRuntimeVersion("bad", "3.7")).toBeLessThan(0);
      expect(compareRuntimeVersion("3.7", "bad")).toBeGreaterThan(0);
      expect(compareRuntimeVersion("bad", "worse")).toBe(0);
    });
  });

  describe("支持区间（CONTRACT §0.1 / §1.1）", () => {
    it("缺省区间 = 3.7 ~ 3.14，在线下界 3.8", () => {
      delete process.env[RUNTIME_VERSION_MIN_ENV];
      delete process.env[RUNTIME_VERSION_MAX_ENV];
      expect(getSupportedRange()).toEqual({
        min: "3.7",
        max: "3.14",
        onlineMin: "3.8",
      });
      expect(DEFAULT_RUNTIME_VERSION_MIN).toBe("3.7");
      expect(DEFAULT_RUNTIME_VERSION_MAX).toBe("3.14");
      expect(ONLINE_DOWNLOAD_MIN).toBe("3.8");
    });

    it.each(["3.7", "3.8", "3.9", "3.10", "3.11", "3.12", "3.13", "3.14"])(
      "接受区间内版本 %s（含上下界）",
      (v) => {
        expect(isRuntimeVersionSupported(v)).toBe(true);
      },
    );

    it.each(["3.6", "3.5", "2.7", "3.15", "3.16", "4.0"])(
      "拒绝区间外版本 %s（NG-09 修正：3.6 及以下拒绝）",
      (v) => {
        expect(isRuntimeVersionSupported(v)).toBe(false);
      },
    );

    it("格式非法一律不支持（两类拒绝合一）", () => {
      expect(isRuntimeVersionSupported("3.7.9")).toBe(false);
      expect(isRuntimeVersionSupported("")).toBe(false);
    });

    it("在线可下载区间下界为 3.8：3.7 不在其中（T01 实测修正）", () => {
      expect(isOnlineDownloadable("3.7")).toBe(false);
      expect(isOnlineDownloadable("3.8")).toBe(true);
      expect(isOnlineDownloadable("3.14")).toBe(true);
      expect(isOnlineDownloadable("3.15")).toBe(true); // 仅格式/下界判定
    });

    it("env 覆盖生效（可声明区间可配置）", () => {
      process.env[RUNTIME_VERSION_MIN_ENV] = "3.9";
      process.env[RUNTIME_VERSION_MAX_ENV] = "3.13";
      expect(getSupportedRange()).toEqual({
        min: "3.9",
        max: "3.13",
        onlineMin: "3.8",
      });
      expect(isRuntimeVersionSupported("3.8")).toBe(false);
      expect(isRuntimeVersionSupported("3.13")).toBe(true);
      expect(isRuntimeVersionSupported("3.14")).toBe(false);
    });

    it("onlineMin 恒为契约常量 3.8（描述 uv 能力边界，不可配置）", () => {
      process.env[RUNTIME_VERSION_MIN_ENV] = "3.10";
      process.env[RUNTIME_VERSION_MAX_ENV] = "3.12";
      expect(getSupportedRange().onlineMin).toBe(ONLINE_DOWNLOAD_MIN);
    });

    it("env 非法值静默回退缺省（手滑配置不得让写面 500）", () => {
      process.env[RUNTIME_VERSION_MIN_ENV] = "not-a-version";
      process.env[RUNTIME_VERSION_MAX_ENV] = "3.7.9";
      expect(getSupportedRange()).toEqual({
        min: "3.7",
        max: "3.14",
        onlineMin: "3.8",
      });
    });

    it("env 空白容忍（trim 后合法即生效）", () => {
      process.env[RUNTIME_VERSION_MIN_ENV] = "  3.9  ";
      delete process.env[RUNTIME_VERSION_MAX_ENV];
      expect(getSupportedRange().min).toBe("3.9");
    });

    it("min > max 时整体回退缺省区间（不产生空区间）", () => {
      process.env[RUNTIME_VERSION_MIN_ENV] = "3.13";
      process.env[RUNTIME_VERSION_MAX_ENV] = "3.9";
      expect(getSupportedRange()).toEqual({
        min: "3.7",
        max: "3.14",
        onlineMin: "3.8",
      });
    });
  });

  describe("buildUnsupportedVersionMessage（AC-06b 中文提示）", () => {
    beforeEach(() => {
      delete process.env[RUNTIME_VERSION_MIN_ENV];
      delete process.env[RUNTIME_VERSION_MAX_ENV];
    });

    // CONTRACT §0 硬要求：声明 3.7 必须**明确指引**"不支持在线下载，需部署方
    // 离线预填解释器缓存卷"——这是运维唯一能采取的动作，缺失等于让人无从下手。
    it("3.7 明确指引离线预填缓存卷（不得只报'不支持'）", () => {
      const msg = buildUnsupportedVersionMessage("3.7");
      expect(msg).toContain("3.7");
      expect(msg).toContain("不支持在线下载");
      expect(msg).toContain("离线预填");
      expect(msg).toContain("UV_PYTHON_INSTALL_DIR");
    });

    it("区间外版本给出当前生效区间", () => {
      expect(buildUnsupportedVersionMessage("3.6")).toContain("3.6");
      expect(buildUnsupportedVersionMessage("3.6")).toContain("3.7 ~ 3.14");
      expect(buildUnsupportedVersionMessage("3.15")).toContain("3.7 ~ 3.14");
    });

    it("格式非法给出 X.Y 形态指正", () => {
      const msg = buildUnsupportedVersionMessage("3.7.9");
      expect(msg).toContain("格式非法");
      expect(msg).toContain("主.次");
    });

    it("提示文案随 env 区间变化（不硬编码缺省区间）", () => {
      process.env[RUNTIME_VERSION_MIN_ENV] = "3.9";
      process.env[RUNTIME_VERSION_MAX_ENV] = "3.12";
      expect(buildUnsupportedVersionMessage("3.8")).toContain("3.9 ~ 3.12");
    });

    it("非字符串输入不抛错", () => {
      expect(() =>
        buildUnsupportedVersionMessage(undefined as unknown as string),
      ).not.toThrow();
    });
  });
});
