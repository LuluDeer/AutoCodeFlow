/**
 * N9 生产探测适配器：把 safe-http 的 SSRF 校验结果映射成 ReachabilityProbeService
 * 需要的 ProbeFn 形态（status + ok），不发真实网络请求。
 *
 * 为什么不发 HEAD 请求：resolve/dump 是高频只读端点，每次解析都发外网请求会引入
 * 延迟、副作用与 SSRF 放大面；「目标 URL 能否被安全直连」由 assertAndPinHttpUrl
 * 的 DNS-rebinding 防护 + 分类表确定性回答，已经是足够的可达性证据。真正的内网
 * ERP 实时网络探测与 executor-desktop X11 实跑属 external（见方案 N9 边界），
 * 由部署方按需 override ProbeFn，不在本默认适配器里。
 *
 * 语义：
 * - 非 http(s) 目标（如 capability://<key>）→ unknown（fail-closed，交 classifyReachability）
 * - http(s) 且通过 SSRF 校验（含 DNS pin）→ reachable（白名单能力才会被判 reachable）
 * - SSRF 拒绝（私有/回环/CGNAT/元数据等）/ 校验异常 → denied / error
 */
import {
  assertAndPinHttpUrl,
  type PinnedHttpTarget,
} from "../../common/utils/safe-http.util";
import type { ProbeFn } from "./reachability-probe.service";
import type { ReachabilitySignalStatus } from "./reachability";

export const safeHttpProbe: ProbeFn = async (
  target: string,
): Promise<{ status: ReachabilitySignalStatus; ok?: boolean }> => {
  if (typeof target !== "string" || target.length === 0) {
    return { status: "unknown", ok: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { status: "unknown", ok: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "unknown", ok: false };
  }
  try {
    const pinned: PinnedHttpTarget = await assertAndPinHttpUrl(target);
    return pinned?.pinned
      ? { status: "reachable", ok: true }
      : { status: "unknown" };
  } catch {
    // SSRF 校验拒绝 = 明确不可直连证据 → classifyReachability 判 unreachable，
    // 具备 GUI 的能力降级到 x11+fromVideo；非白名单能力仍 fail-closed 为 unknown。
    return { status: "denied", ok: false };
  }
};
