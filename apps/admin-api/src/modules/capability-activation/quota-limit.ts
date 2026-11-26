/**
 * N20 showback 硬阈值的**纯判定**层：无 Nest、无 DB、无 I/O。
 *
 * 抽出来的理由：quota.service 已经注入 CapabilityActivationService 取 stats，
 * activation.service 若直接注入 QuotaService 会成 DI 环。这里只放「一行 status →
 * 三态」与「一组 status + 一次激活 → 是否硬拦截」的确定性函数，两处消费方各自
 * 负责取数；quota.service.status 与硬阈 gate 共用同一套边界定义，不重复判定。
 */
import type {
  QuotaConfig,
  QuotaStatus,
  QuotaStatusRow,
  QuotaUnit,
} from "./dto/quota.dto";

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
  /** 仅 unit='amount' 的命中行携带，调用方据此写审计 detail。 */
  unit?: QuotaUnit;
  amount?: number | null;
  priceReason?: string;
  /** 命中原因：金额折算/缺价目说明；与 priceReason 同源时为同一字符串。 */
  reason?: string;
  /** 金额阈值副本（配置值），便于 detail 同时给出 amount/threshold。 */
  amountHardLimit?: number;
}

export interface HardLimitDecision {
  blocked: boolean;
  matched?: HardLimitMatch;
  /**
   * 金额不可得时 fail-open 的原因集合。matched 必须缺席，避免把「算不出钱」
   * 伪装成「已算过且未超限」的假绿；调用方可将其写入审计 detail。
   */
  reasons?: string[];
}

/** 金额不可得必须显式说明跳过，不能退化成 usage=0 的「未超限」。 */
function amountUnavailableReason(row: QuotaStatusRow): string {
  return row.priceReason
    ? `unit=amount 金额不可得（${row.priceReason}）：跳过硬闸，未与 0 比较`
    : "unit=amount 金额不可得（零样本或缺价目）：跳过硬闸，未与 0 比较";
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
  const reasons: string[] = [];
  for (const row of rows) {
    const matched =
      row.scope === "project"
        ? dto.projectId != null && row.target === dto.projectId
        : row.scope === "capability" && row.target === dto.capabilityKey;
    if (!matched) continue;

    if (row.unit === "amount") {
      const amount = row.amount;
      // 金额不可得（null / 缺价目 / 零样本 / NaN）必须在任何比较之前跳过：
      // 绝不按 0 比较，也绝不返回带「未超限」暗示的 matched。
      if (
        amount == null ||
        typeof amount !== "number" ||
        !Number.isFinite(amount)
      ) {
        reasons.push(amountUnavailableReason(row));
        continue;
      }
      const threshold = row.amountHardLimit ?? row.hardLimit;
      if (
        typeof threshold !== "number" ||
        !Number.isFinite(threshold) ||
        threshold <= 0
      ) {
        reasons.push("unit=amount 金额阈值非法：跳过硬闸，未与 0 比较");
        continue;
      }
      if (amount >= threshold) {
        return {
          blocked: true,
          matched: {
            scope: row.scope,
            target: row.target,
            usage: row.usage,
            hardLimit: row.hardLimit,
            windowDays: row.windowDays,
            unit: "amount",
            amount,
            ...(row.priceReason
              ? { priceReason: row.priceReason, reason: row.priceReason }
              : {}),
            ...(threshold !== row.hardLimit
              ? { amountHardLimit: threshold }
              : {}),
          },
        };
      }
      continue;
    }

    if (row.usage < row.hardLimit) continue;
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
  return reasons.length === 0
    ? { blocked: false }
    : { blocked: false, reasons };
}
