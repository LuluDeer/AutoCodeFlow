/**
 * R3-A（部署模型评审 2026-10-23 §4.3 / §九 9.3-1）：执行器心跳/注册上报的
 * **设备级应用版本事实**（deployedApps）与**已安装包清单**（installedPackages）
 * 的契约类型与结构校验。
 *
 * 与 interpreter-match.util.ts 的 normalizeInterpreters 同一套纪律：
 * - 字段 `undefined`（旧执行器不传）→ 调用方**完全不动 DB**（fail-honest
 *   「无数据」而非清空——旧执行器绝不能把新执行器已上报的事实擦掉）；
 * - 存在但结构非法 → **整字段拒绝采纳**（返回 null + 调用方 warn，DB 保留
 *   旧值）——deployedApps 是**全量快照**（心跳带 → 整替该执行器全部行，
 *   见 ExecutorService.applyReportedAppVersions），半采纳或部分修复都会让
 *   「整替」语义静默失真，宁可不采纳也不写错事实；
 * - 合法（含 `[]` = 设备上没有任何已部署应用，如刚重装/全部卸载）→ 覆盖。
 */

/**
 * 心跳契约：单条已部署应用事实（appId = 部署时的 applicationId）。
 * 字段语义与 executor-node 侧扫描 app-inventory 的产出逐字段一致。
 */
export interface DeployedAppReport {
  /** 部署时的 applicationId。 */
  appId: string;
  /** 设备 current 软链指向的版本；无 current → null。 */
  currentVersion: string | null;
  /** current 软链指向的 release 目录名（版本 + 部署 ID 后缀）。 */
  currentReleaseKey: string | null;
  /** 设备 releases/ 下仍保留的版本集合（prune 后）。 */
  retainedVersions: string[];
  /** 部署/升级时选择的运行模式；从未部署成功过 → null。 */
  runMode: "once" | "daemon" | "scheduled" | null;
  /** 最近一次部署完成时刻（ISO 8601）；无记录 → null。 */
  lastDeployedAt: string | null;
}

/** 心跳契约：单条已安装执行器包（executor_packages 的设备侧事实，P10 收敛）。 */
export interface InstalledPackageReport {
  name: string;
  type: string;
  version: string;
}

/**
 * 校验闸（防心跳载荷膨胀——心跳是 30s/台的高频面，上限值与
 * DEPLOYMENT_ENV_MAX_KEYS 同一立场的上限防御，不是业务约束）：
 * deployedApps ≤ 50 项 —— 单设备并发部署 50 个应用已远超现实形态；
 *   超限**整字段拒绝**而非截断：deployedApps 是全量快照，截断后
 *   「不在数组中的应用行删除」会把被截掉的应用行删掉 = 把对的事实改错。
 * retainedVersions 每项 ≤ 20 —— 设备侧 KEEP_RELEASES=5 + 少量手工保留，
 *   20 已有 4 倍余量；超限说明上报方异常，同样整字段拒绝。
 * installedPackages ≤ 100 —— 执行器包（node/python runtime 等）现实规模
 *   个位数；超限整字段拒绝（理由同 deployedApps 截断禁止）。
 */
export const MAX_DEPLOYED_APPS = 50;
export const MAX_RETAINED_VERSIONS = 20;
export const MAX_INSTALLED_PACKAGES = 100;

/** 版本号/releaseKey/包名等字符串长度上限：现实值 ≤ 64，128/255 留足余量。 */
export const MAX_VERSION_STRING_LENGTH = 128;
export const MAX_RELEASE_KEY_LENGTH = 255;
export const MAX_APP_ID_STRING_LENGTH = 64;
export const MAX_PACKAGE_NAME_LENGTH = 128;
export const MAX_PACKAGE_TYPE_LENGTH = 32;

const RUN_MODES = new Set(["once", "daemon", "scheduled"]);

/** 可选字符串：null/undefined → null；非空且长度合规的 string → trim 后值；
 *  其余（空串/超长/非字符串）→ undefined 表示「非法」（调用方整字段拒绝）。 */
function optionalString(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

/**
 * 结构校验 + 规范化 deployedApps。返回 null = 非法（整字段拒绝采纳）；
 * 返回数组（含 []）= 合法，调用方可按整替语义落库。
 */
export function normalizeDeployedApps(
  value: unknown,
): DeployedAppReport[] | null {
  if (!Array.isArray(value)) return null;
  // 超限拒绝（不截断）：截断会让整替语义把被截掉的应用行删掉（见常量注释）。
  if (value.length > MAX_DEPLOYED_APPS) return null;
  const out: DeployedAppReport[] = [];
  const seenAppIds = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    // appId：必填（缺 appId 的事实行无法归属到应用，无法落库）。
    if (typeof item.appId !== "string") return null;
    const appId = item.appId.trim();
    if (!appId || appId.length > MAX_APP_ID_STRING_LENGTH) return null;
    // 同一心跳里同一应用出现两次 = 上报方自身矛盾，整替语义无法裁决先后。
    if (seenAppIds.has(appId)) return null;
    const currentVersion = optionalString(
      item.currentVersion,
      MAX_VERSION_STRING_LENGTH,
    );
    const currentReleaseKey = optionalString(
      item.currentReleaseKey,
      MAX_RELEASE_KEY_LENGTH,
    );
    const lastDeployedAt = optionalString(item.lastDeployedAt, 64);
    if (
      currentVersion === undefined ||
      currentReleaseKey === undefined ||
      lastDeployedAt === undefined
    ) {
      return null;
    }
    // lastDeployedAt 非 null 时必须是可解析的 ISO 时刻（落库转 timestamptz，
    // 坏值会在 DB 层爆 500 —— 在校验闸就拒绝）。
    if (lastDeployedAt !== null && Number.isNaN(Date.parse(lastDeployedAt))) {
      return null;
    }
    if (!Array.isArray(item.retainedVersions)) return null;
    if (item.retainedVersions.length > MAX_RETAINED_VERSIONS) return null;
    const retainedVersions: string[] = [];
    for (const rv of item.retainedVersions) {
      const normalized = optionalString(rv, MAX_VERSION_STRING_LENGTH);
      if (normalized === undefined) return null;
      retainedVersions.push(normalized);
    }
    let runMode: DeployedAppReport["runMode"] = null;
    if (item.runMode !== null && item.runMode !== undefined) {
      if (typeof item.runMode !== "string" || !RUN_MODES.has(item.runMode)) {
        return null;
      }
      runMode = item.runMode as DeployedAppReport["runMode"];
    }
    seenAppIds.add(appId);
    out.push({
      appId,
      currentVersion,
      currentReleaseKey,
      retainedVersions,
      runMode,
      lastDeployedAt,
    });
  }
  return out;
}

/**
 * 结构校验 + 规范化 installedPackages。返回 null = 非法（整字段拒绝）；
 * 返回数组（含 []）= 合法（已安装且为空 = 真的没装任何执行器包）。
 */
export function normalizeInstalledPackages(
  value: unknown,
): InstalledPackageReport[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_INSTALLED_PACKAGES) return null;
  const out: InstalledPackageReport[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const name = optionalString(item.name, MAX_PACKAGE_NAME_LENGTH);
    const type = optionalString(item.type, MAX_PACKAGE_TYPE_LENGTH);
    const version = optionalString(item.version, MAX_VERSION_STRING_LENGTH);
    // name/type/version 均必填（三缺一无法构成「装了哪个包的哪一版」事实）。
    if (!name || !type || !version) return null;
    out.push({ name, type, version });
  }
  return out;
}
