/**
 * N20 showback 硬阈值的**纯判定**层：无 Nest、无 DB、无 I/O。
 *
 * 抽出来的理由：quota.service 已经注入 CapabilityActivationService 取 stats，
 * activation.service 若直接注入 QuotaService 会成 DI 环。这里只放「一行 status →
 * 三态」与「一组 status + 一次激活 → 是否硬拦截」的确定性函数，两处消费方各自
 * 负责取数；quota.service.status 与硬阈 gate 共用同一套边界定义，不重复判定。
 */
import type { QuotaConfig, QuotaStatus, QuotaStatusRow } from "./dto/quota.dto";

/** 一次激活参与配额匹配的最小字段面。 */
export interface HardLimitTarget {
  capabilityKey: string;
  projectId?: string | null;
}

/** 命中的硬阈值行（用于审计 detail；不带 webhookUrl 等配置细节）。 */
export interface HardLimitMatch {
  scope: QuotaStatusRow["scope"];
  target: string;
  usage: number;
  hardLimit: number;
  windowDays: number;
}

export interface HardLimitDecision {
  blocked: boolean;
  matched?: HardLimitMatch;
}

/** 三态边界：先判 hard 再判 soft，等值分别落 exceeded / warn。 */
export function classifyQuota(
  cfg: Pick<QuotaConfig, "softLimit" | "hardLimit">,
  usage: number,
): QuotaStatus {
  return usage >= cfg.hardLimit
    ? "exceeded"
    : usage >= cfg.softLimit
      ? "warn"
      : "ok";
}

/**
 * usage>=hardLimit 的匹配行任一命中即拦截。
 *
 * scope='project' 只匹配 dto.projectId（缺席不命中）；scope='capability'
 * 匹配 dto.capabilityKey。rows 由 quota.status(windowDays) 产出，usage 与
 * windowDays 均来自现有统计口径，本函数不再自行计数。
 */
export function evaluateHardLimit(
  rows: QuotaStatusRow[],
  dto: HardLimitTarget,
): HardLimitDecision {
  for (const row of rows) {
    const matched =
      row.scope === "project"
        ? dto.projectId != null && row.target === dto.projectId
        : row.scope === "capability" && row.target === dto.capabilityKey;
    if (!matched || row.usage < row.hardLimit) continue;
    return {
      blocked: true,
      matched: {
        scope: row.scope,
        target: row.target,
        usage: row.usage,
        hardLimit: row.hardLimit,
        windowDays: row.windowDays,
      },
    };
  }
  return { blocked: false };
}
