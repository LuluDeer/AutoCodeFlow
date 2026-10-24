/**
 * R3-A（部署模型评审 2026-10-23 §4.3）：deployedApps / installedPackages
 * 契约结构校验（deployed-apps.util.ts）。
 *
 * 校验闸口径：
 * - 合法载荷（含 [] 空数组 =「设备无已部署应用」）原样规范化（trim）；
 * - 键值缺省/类型不符/超限/重复 appId/坏时间戳 → 整字段 null（调用方拒绝采纳）；
 * - 上限：deployedApps ≤ 50、retainedVersions 每项 ≤ 20、installedPackages ≤ 100
 *   （超限拒绝而非截断——deployedApps 是全量快照，截断会让整替语义删错行）。
 */
import {
  MAX_DEPLOYED_APPS,
  MAX_INSTALLED_PACKAGES,
  MAX_RETAINED_VERSIONS,
  normalizeDeployedApps,
  normalizeInstalledPackages,
} from "../deployed-apps.util";

const appFact = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  appId: "app-1",
  currentVersion: "1.2.0",
  currentReleaseKey: "1.2.0-deploy-8t4",
  retainedVersions: ["1.2.0", "1.1.0"],
  runMode: "daemon",
  lastDeployedAt: "2026-10-24T08:00:00.000Z",
  ...over,
});

describe("normalizeDeployedApps（R3-A 契约校验）", () => {
  it("合法载荷规范化：字符串 trim、可空字段收 null、枚举收窄", () => {
    const out = normalizeDeployedApps([
      appFact({
        appId: " app-1 ",
        currentVersion: " 1.2.0 ",
        currentReleaseKey: null,
        runMode: null,
        lastDeployedAt: null,
      }),
    ]);
    expect(out).toEqual([
      {
        appId: "app-1",
        currentVersion: "1.2.0",
        currentReleaseKey: null,
        retainedVersions: ["1.2.0", "1.1.0"],
        runMode: null,
        lastDeployedAt: null,
      },
    ]);
  });

  it("空数组合法（设备上没有任何已部署应用——整替 = 清空既有行）", () => {
    expect(normalizeDeployedApps([])).toEqual([]);
  });

  it("非数组 / 项非对象 / 缺 appId → null", () => {
    expect(normalizeDeployedApps(undefined)).toBeNull();
    expect(normalizeDeployedApps("nope")).toBeNull();
    expect(normalizeDeployedApps([42])).toBeNull();
    expect(normalizeDeployedApps([{ currentVersion: "1.0.0" }])).toBeNull();
  });

  it("currentVersion/currentReleaseKey/lastDeployedAt：空串/超长/非字符串 → null", () => {
    expect(normalizeDeployedApps([appFact({ currentVersion: "" })])).toBeNull();
    expect(
      normalizeDeployedApps([appFact({ currentVersion: 123 })]),
    ).toBeNull();
    expect(
      normalizeDeployedApps([appFact({ currentReleaseKey: "x".repeat(256) })]),
    ).toBeNull();
    expect(normalizeDeployedApps([appFact({ lastDeployedAt: 42 })])).toBeNull();
  });

  it("lastDeployedAt 非 ISO 可解析字符串 → null（落 timestamptz 会 500，闸口拒绝）", () => {
    expect(
      normalizeDeployedApps([appFact({ lastDeployedAt: "not-a-date" })]),
    ).toBeNull();
  });

  it("retainedVersions：非数组/超 20 项/项非字符串 → null；恰 20 项合法", () => {
    expect(
      normalizeDeployedApps([appFact({ retainedVersions: "1.0" })]),
    ).toBeNull();
    expect(
      normalizeDeployedApps([appFact({ retainedVersions: ["1.0", 2] })]),
    ).toBeNull();
    const twenty = Array.from(
      { length: MAX_RETAINED_VERSIONS },
      (_, i) => `1.0.${i}`,
    );
    expect(
      normalizeDeployedApps([appFact({ retainedVersions: twenty })]),
    ).not.toBeNull();
    expect(
      normalizeDeployedApps([
        appFact({ retainedVersions: [...twenty, "1.1.0"] }),
      ]),
    ).toBeNull();
  });

  it("runMode 枚举外值 → null；once/daemon/scheduled/null 合法", () => {
    expect(normalizeDeployedApps([appFact({ runMode: "always" })])).toBeNull();
    for (const mode of ["once", "daemon", "scheduled", null]) {
      expect(
        normalizeDeployedApps([appFact({ runMode: mode })]),
      ).not.toBeNull();
    }
  });

  it("同一 appId 重复上报 → null（整替语义无法裁决先后）", () => {
    expect(
      normalizeDeployedApps([appFact(), appFact({ currentVersion: "1.1.0" })]),
    ).toBeNull();
  });

  it(`deployedApps 超 ${MAX_DEPLOYED_APPS} 项 → 整字段 null（拒绝而非截断）`, () => {
    const fifty = Array.from({ length: MAX_DEPLOYED_APPS }, (_, i) =>
      appFact({ appId: `app-${i}` }),
    );
    expect(normalizeDeployedApps(fifty)).not.toBeNull();
    expect(
      normalizeDeployedApps([...fifty, appFact({ appId: "app-extra" })]),
    ).toBeNull();
  });
});

describe("normalizeInstalledPackages（R3-A/P10 契约校验）", () => {
  it("合法载荷规范化（trim）；空数组 = 已上报且无安装包", () => {
    expect(
      normalizeInstalledPackages([
        { name: " python-runtime ", type: "uv", version: "0.7.12" },
      ]),
    ).toEqual([{ name: "python-runtime", type: "uv", version: "0.7.12" }]);
    expect(normalizeInstalledPackages([])).toEqual([]);
  });

  it("name/type/version 任一缺失或非字符串 → null", () => {
    expect(normalizeInstalledPackages(undefined)).toBeNull();
    expect(normalizeInstalledPackages([{ name: "a", type: "uv" }])).toBeNull();
    expect(
      normalizeInstalledPackages([{ name: "a", type: "uv", version: 1 }]),
    ).toBeNull();
  });

  it(`超 ${MAX_INSTALLED_PACKAGES} 项 → 整字段 null`, () => {
    const hundred = Array.from({ length: MAX_INSTALLED_PACKAGES }, (_, i) => ({
      name: `pkg-${i}`,
      type: "uv",
      version: "1.0.0",
    }));
    expect(normalizeInstalledPackages(hundred)).not.toBeNull();
    expect(
      normalizeInstalledPackages([
        ...hundred,
        { name: "extra", type: "uv", version: "1.0.0" },
      ]),
    ).toBeNull();
  });
});
