/**
 * python_task_multiversion（WS1）：Python 解释器**版本声明**的单一事实源。
 *
 * 背景（CONTRACT.md §1.1 / §3.1，T01 实测修正后冻结）：
 * - 任务可声明 `runtimeVersion`（"主.次"，如 `3.7` / `3.12`），语义为**解释器
 *   主.次版本**（D1，无补丁号）。
 * - **可声明区间 = 3.7 ~ 3.14**（默认，可经 env 调整）。
 * - **在线可下载区间 = 3.8 ~ 3.14**；`3.7` 是"离线预填扩展"——uv 在线下载
 *   必然失败（`No download found for request: cpython-3.7-<platform>`，exit 2），
 *   必须由部署方预填解释器缓存卷（UV_PYTHON_INSTALL_DIR）。升级 uv 不能解决。
 * - 3.6 及以下 / 3.15 及以上：拒绝声明（NG-09 修正）。
 *
 * 纪律：
 * - 本模块只做**格式 + 区间**判定（AC-06b）。**刻意不做**执行器缓存预检
 *   （AC-06c：解释器"先下载后有"，首跑获取失败在运行时体现，分因
 *   `interpreter_unavailable`）——写面若能预检就等于把"先下载后有"变成
 *   同步依赖，且多执行器缓存不一致时判定必然失真。
 * - 纯函数 + 常量，零状态零依赖：DTO 边界、service 写面、执行器侧提示三方
 *   共用同一判据，语义永不漂移。
 */

import { getEnvVar } from "../../config/env";

/**
 * 声明格式（D1）：主.次，无补丁号。非法 → 400。
 * 锚定首尾（`^`/`$`）——class-validator 的 `@Matches` 与本常量同源，
 * 保证 DTO 与 service 双层判据逐字节一致。
 */
export const RUNTIME_VERSION_PATTERN: RegExp = /^\d+\.\d+$/;

/** 可声明区间下界缺省值（CONTRACT §1.1：默认 3.7） */
export const DEFAULT_RUNTIME_VERSION_MIN = "3.7";
/** 可声明区间上界缺省值（CONTRACT §1.1：默认 3.14） */
export const DEFAULT_RUNTIME_VERSION_MAX = "3.14";
/**
 * 在线可下载区间下界（CONTRACT §1.1 `ONLINE_DOWNLOAD_MIN`）。
 * `< 3.8` 的版本给"需离线预填缓存卷"提示；执行器侧与 admin 文档/提示共用。
 */
export const ONLINE_DOWNLOAD_MIN = "3.8";

/** env 覆盖键（CONTRACT §1.1：admin-api env） */
export const RUNTIME_VERSION_MIN_ENV = "PYTHON_RUNTIME_VERSION_MIN";
export const RUNTIME_VERSION_MAX_ENV = "PYTHON_RUNTIME_VERSION_MAX";

/**
 * ARCH-27/W-22 豁免说明：本模块是**无 DI 纯函数模块**（同
 * config/throttle-profiles.ts、common/utils/safe-http.util.ts 先例），被 DTO
 * 校验、service 写面、提示文案多处调用，签名注入 ConfigService 会波及全部
 * 调用点及其 spec（超出本次收口边界）。故按"求值期/无 DI"豁免路径经
 * src/config/env.ts 的 getEnvVar() 收口读取。
 *
 * 读取时机：**调用时**（非模块求值期）——与 safe-http.util 的
 * EXECUTOR_ALLOW_PRIVATE_NETWORK 同款，测试可直接操纵 env 后调用。
 */
function resolveBound(envName: string, fallback: string): string {
  const raw = getEnvVar(envName);
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  // 非法配置一律**静默回退缺省值**（不抛错）：env 手滑不应让整个任务写面 500，
  // 而"回退到契约缺省区间"是最保守的可用状态。
  return isValidRuntimeVersionFormat(trimmed) ? trimmed : fallback;
}

/**
 * 解析 "X.Y" 为 [major, minor]。非法（非字符串/格式不符）→ null。
 * 刻意不 trim：DTO 的 `@Matches` 同样不 trim，双层判据必须一致。
 */
function parseRuntimeVersion(
  v: string | null | undefined,
): [number, number] | null {
  if (typeof v !== "string" || !RUNTIME_VERSION_PATTERN.test(v)) return null;
  const [major, minor] = v.split(".");
  return [Number(major), Number(minor)];
}

/** 格式判定：必须为 `^\d+\.\d+$`（如 `3.7` / `3.12`）。 */
export function isValidRuntimeVersionFormat(v: string): boolean {
  return typeof v === "string" && RUNTIME_VERSION_PATTERN.test(v);
}

/**
 * 全序比较：a < b → 负数；a === b → 0；a > b → 正数。
 *
 * 数值比较（非字典序）——`"3.9" < "3.12"` 必须成立（字典序会判反）。
 * 非法值参与比较时取**确定性**排序（非法 < 合法，两个非法相等），
 * 使调用方（如 `isRuntimeVersionSupported`）不会因 NaN 产生随机结果。
 */
export function compareRuntimeVersion(a: string, b: string): number {
  const pa = parseRuntimeVersion(a);
  const pb = parseRuntimeVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return pa[0] - pb[0] || pa[1] - pb[1];
}

/**
 * 当前生效的支持区间。env 覆盖非法或 min > max 时回退契约缺省值。
 *
 * `onlineMin` 恒为 `ONLINE_DOWNLOAD_MIN`（3.8，契约常量，不可配置）：
 * 它描述的是 **uv 的能力边界**（T01 实测），不是部署策略。
 */
export function getSupportedRange(): {
  min: string;
  max: string;
  onlineMin: string;
} {
  let min = resolveBound(RUNTIME_VERSION_MIN_ENV, DEFAULT_RUNTIME_VERSION_MIN);
  let max = resolveBound(RUNTIME_VERSION_MAX_ENV, DEFAULT_RUNTIME_VERSION_MAX);
  if (compareRuntimeVersion(min, max) > 0) {
    min = DEFAULT_RUNTIME_VERSION_MIN;
    max = DEFAULT_RUNTIME_VERSION_MAX;
  }
  return { min, max, onlineMin: ONLINE_DOWNLOAD_MIN };
}

/** 是否在**可声明区间**内（格式非法一律 false——AC-06b 的两类拒绝合一）。 */
export function isRuntimeVersionSupported(v: string): boolean {
  if (!isValidRuntimeVersionFormat(v)) return false;
  const { min, max } = getSupportedRange();
  return (
    compareRuntimeVersion(v, min) >= 0 && compareRuntimeVersion(v, max) <= 0
  );
}

/** 是否在**在线可下载区间**内（`>= 3.8`）。仅用于提示文案分流。 */
export function isOnlineDownloadable(v: string): boolean {
  if (!isValidRuntimeVersionFormat(v)) return false;
  return compareRuntimeVersion(v, ONLINE_DOWNLOAD_MIN) >= 0;
}

/**
 * 不支持版本的中文提示（AC-06b / CONTRACT §0 语义定稿）。
 *
 * 三类分流：
 * 1. 格式非法 → 指正 `X.Y` 形态；
 * 2. 区间内但 `< 3.8`（当前即 `3.7`）→ **必须明确指引**"不支持在线下载，
 *    需部署方离线预填解释器缓存卷"（CONTRACT §0 硬要求）；
 * 3. 区间外 → 给出当前生效的可声明区间。
 */
export function buildUnsupportedVersionMessage(v: string): string {
  const { min, max, onlineMin } = getSupportedRange();
  const shown = typeof v === "string" ? `"${v}"` : String(v);
  if (!isValidRuntimeVersionFormat(v)) {
    return `不支持的 Python 版本 ${shown}：格式非法，须为"主.次"版本号（如 3.12）。`;
  }
  if (
    compareRuntimeVersion(v, min) >= 0 &&
    compareRuntimeVersion(v, max) <= 0
  ) {
    // 落在可声明区间但低于在线下载下界（当前配置下即 3.7）。
    return (
      `Python ${v} 不在在线可下载区间（${onlineMin} ~ ${max}）：` +
      `${v} 不支持在线下载，需部署方离线预填解释器缓存卷（UV_PYTHON_INSTALL_DIR）后方可使用。`
    );
  }
  return `不支持的 Python 版本 ${shown}：可声明区间为 ${min} ~ ${max}（当前配置）。`;
}
