/**
 * N9 — 能力可达性探测信号生产者（把探测结果喂给纯判定层）。
 *
 * 边界：本文件只负责「拿到一次探测结果 → 组信号 → 调用 reachability 纯函数」，
 * 不重写分级/降级判据，不发放网络请求本身；真实 HTTP 探测由注入的 ProbeFn
 * 完成（生产用 safe-http 适配做 SSRF 防护，测试注假 probe）。
 *
 * fail-open：timeout / denied / 抛错一律留在分级层处理，探测异常不外溢到
 * resolve / dump 主链。
 */
import { Injectable, Optional } from "@nestjs/common";
import {
  classifyReachability,
  degradePath as computeDegradePath,
  type DegradePath,
  type Reachability,
  type ReachabilityCapability,
  type ReachabilitySignal,
  type ReachabilitySignalStatus,
} from "./reachability";

/** 注入式探测口：只回状态，不碰能力注册表和编排。 */
export type ProbeFn = (
  url: string,
) => Promise<{ status: ReachabilitySignalStatus; ok?: boolean }>;

/** 一次探测的完整判定结果；degradePath / degradationHint 直接进 resolve/dump 响应。 */
export interface ReachabilityAssessment {
  signal: ReachabilitySignal;
  reachability: Reachability;
  degradePath: DegradePath;
  degradationHint: string;
}

/**
 * 探测目标：显式 ref / manifest 中的 URL 优先；没有就给确定性的 capability://
 * 目标，由注入的 ProbeFn 决定如何映射（本地 X11 / 文件数据源不需要真实 HTTP）。
 */
export function probeTargetFor(
  capability: ReachabilityCapability | null | undefined,
): string {
  const candidates: unknown[] = [
    capability?.source?.ref,
    capability?.manifest?.url,
    capability?.manifest?.endpoint,
    capability?.manifest?.probeUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  const id = capability?.key ?? capability?.id ?? "unknown";
  return `capability://${encodeURIComponent(id)}`;
}

@Injectable()
export class ReachabilityProbeService {
  /**
   * probeFn 为可选构造参数：生产由 CapabilityModule 的 useFactory 注入 safe-http
   * 适配器；尚未接线或缺依赖时只产生 unknown 信号，绝不吞掉 resolve/dump。
   */
  constructor(@Optional() private readonly probeFn?: ProbeFn) {}

  async assess(
    capability: ReachabilityCapability | null | undefined,
  ): Promise<ReachabilityAssessment> {
    const id = capability?.key ?? capability?.id ?? "";
    let status: ReachabilitySignalStatus = "unknown";
    let ok: boolean | undefined;

    if (this.probeFn) {
      try {
        const result = await this.probeFn(probeTargetFor(capability));
        status = result?.status ?? "unknown";
        ok = result?.ok;
      } catch {
        // 探测失败按明确失败证据处理：classifyReachability("error") → unreachable。
        status = "error";
        ok = false;
      }
    }

    const signal: ReachabilitySignal = {
      capabilityId: id,
      capabilityKey: id,
      status,
      ok,
    };
    // 分级与降级一律复用既有纯函数（幽灵能力 / 白名单 / GUI 判据不在此重写）。
    const reachability = classifyReachability(signal);
    const path = computeDegradePath(capability, reachability);
    return {
      signal,
      reachability,
      degradePath: path,
      degradationHint: `${reachability}:${path}`,
    };
  }
}
