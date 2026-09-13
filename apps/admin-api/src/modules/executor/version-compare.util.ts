/**
 * EXE-VER-1: 执行器版本比较（零依赖，不引 semver）。
 *
 * 点分数字 1~4 段（"1"、"1.2"、"1.3.0"、"1.3.0.1"）。缺省段按 0 补齐逐段
 * 数值比较（"1.2" === "1.2.0"）。任何一段非数字/负数/越段数 → NaN（调用方
 * 必须把 NaN 视为"无法比较"而不是大小结论——执行器上报面不可信，解析失败
 * 时门禁放行、由 isVersionCompliant 的宽松语义兜底）。
 */
export function compareDottedVersions(a: string, b: string): number {
  const pa = parseSegments(a);
  const pb = parseSegments(b);
  if (!pa || !pb) return NaN;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const segA = pa[i] ?? 0;
    const segB = pb[i] ?? 0;
    if (segA !== segB) return segA < segB ? -1 : 1;
  }
  return 0;
}

/**
 * EXE-VER-1: 合规判定——minVersion 为空（门禁关）或执行器未上报 version
 * （存量旧执行器，无法判定）恒 true；否则按 compareDottedVersions >= 0。
 * 解析失败（NaN）按合规放行：门禁只拦"确定低于下限"，不拦"无法解析"，
 * 避免畸形版本号把执行器整体锁死。
 */
export function isVersionCompliant(
  version: string | null | undefined,
  minVersion: string | null | undefined,
): boolean {
  if (!minVersion || !version) return true;
  const cmp = compareDottedVersions(version, minVersion);
  return Number.isNaN(cmp) ? true : cmp >= 0;
}

function parseSegments(version: string): number[] | null {
  if (typeof version !== "string" || version.length === 0) return null;
  const trimmed = version.trim();
  if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(trimmed)) return null;
  return trimmed.split(".").map((seg) => parseInt(seg, 10));
}
