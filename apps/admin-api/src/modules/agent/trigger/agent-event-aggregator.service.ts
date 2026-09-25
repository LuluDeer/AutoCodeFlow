import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * P4（agent-and-deployment）：事件聚合器（设计文档 02 §5.2）。
 *
 * ## 这是 P4 最容易出事的地方
 * 执行失败事件可能每分钟上百条（一次执行器下线会让它名下所有任务瞬间失败）。
 * 若每条都起一个 Agent 会话：
 *   · 令牌成本爆炸（每次会话都要跑 LLM）；
 *   · `agent-jobs` 队列拥塞（并发上限只有 2，几十条就会排很久）；
 *   · 通知风暴（几十条告警淹没人）。
 *
 * ## 核心语义：聚合，而不是逐条触发
 * ```
 * domain event ──► observe()
 *                     ├─ 过滤：白名单事件类型（不是所有事件都值得 Agent 介入）
 *                     ├─ 去重+累积：相同 (eventType, resourceKey) 在窗口内累加计数
 *                     └─ 判定：窗口内 >= 阈值 → 放行一个「聚合后」的触发
 * ```
 * 产出的是「过去 N 分钟 executions 失败 47 次，集中在 executor-03」这样一条
 * 聚合事件，而不是 47 条。
 *
 * ## 为什么聚合状态在内存
 * 聚合窗口是**秒级到分钟级**的瞬时状态，进程重启后重新累积是可接受的
 * （重启后丢失的只是"重启前那一小段窗口"）。放 Redis 会让每次事件都多一次
 * 网络往返——而事件路径本身是高频的。这是刻意的取舍，与既有的
 * `AgentBoundaryService.consecutiveFailures` 同款判断。
 */

/** 值得 Agent 介入的事件类型（**显式白名单**，不开放式订阅）。 */
export const TRIGGERABLE_EVENTS = [
  "execution.failed",
  "execution.killed",
  "executor.offline",
  "deployment.completed",
] as const;
export type TriggerableEvent = (typeof TRIGGERABLE_EVENTS)[number];

/** 聚合窗口内的累积状态。 */
interface AggregateBucket {
  eventType: string;
  /** 资源键（executorId / taskId 等）——同资源的事件才聚合到一起。 */
  resourceKey: string;
  /** 窗口内累计条数。 */
  count: number;
  /** 窗口起始时刻（毫秒）。 */
  windowStart: number;
  /** 样例载荷（取第一条，用于给 Agent 提供上下文）。 */
  samples: unknown[];
  /** 已因本桶触发过的次数（防同一窗口反复触发）。 */
  fired: boolean;
}

/** 聚合结果——放行一条聚合触发。 */
export interface AggregatedTrigger {
  eventType: string;
  resourceKey: string;
  count: number;
  windowMs: number;
  samples: unknown[];
}

/** 观察结果：是否应放行触发。 */
export type ObserveVerdict =
  | { action: "accumulate"; count: number; needed: number }
  | { action: "ignored"; reason: string }
  | { action: "fire"; trigger: AggregatedTrigger };

@Injectable()
export class AgentEventAggregator {
  private readonly logger = new Logger(AgentEventAggregator.name);

  /** 桶键：`${eventType}::${resourceKey}` */
  private readonly buckets = new Map<string, AggregateBucket>();

  constructor(private readonly config: ConfigService) {}

  /** 聚合窗口（毫秒）。 */
  resolveWindowMs(): number {
    return this.readInt("agent.trigger.windowMs", 5 * 60 * 1000);
  }

  /** 触发阈值：窗口内至少这么多条同类事件才起会话。 */
  resolveThreshold(): number {
    return this.readInt("agent.trigger.threshold", 3);
  }

  /**
   * 观察一条领域事件。
   *
   * @param eventType 事件名（`execution.failed` 等）
   * @param resourceKey 资源标识（用于聚合分组；缺省用 `global`）
   * @param payload 原始载荷（作为样例提供给 Agent）
   * @param thresholdOverride 覆盖阈值。
   *   为什么需要它：不同事件的「噪声水平」差异极大——
   *   `execution.failed` 一次执行器下线就会刷出几十条（阈值 3 合理），
   *   而 `executor.offline` 本身就是单次即重要的事件（阈值应降到 1）。
   *   把它做成参数而不是「不同事件不同配置键」，是为了让阈值语义只有
   *   一处（本方法的 threshold 形参），不散落在配置读取里。
   */
  observe(
    eventType: string,
    resourceKey: string | null,
    payload: unknown,
    thresholdOverride?: number,
  ): ObserveVerdict {
    // ── 白名单过滤 ──
    if (!(TRIGGERABLE_EVENTS as readonly string[]).includes(eventType)) {
      return {
        action: "ignored",
        reason: `事件 ${eventType} 不在触发白名单内`,
      };
    }

    const key = `${eventType}::${resourceKey ?? "global"}`;
    const now = Date.now();
    const windowMs = this.resolveWindowMs();
    const threshold =
      thresholdOverride && thresholdOverride > 0
        ? thresholdOverride
        : this.resolveThreshold();

    let bucket = this.buckets.get(key);

    // 窗口过期 → 重置（新窗口从未触发态开始）
    if (bucket && now - bucket.windowStart >= windowMs) {
      bucket = undefined;
      this.buckets.delete(key);
    }

    if (!bucket) {
      bucket = {
        eventType,
        resourceKey: resourceKey ?? "global",
        count: 0,
        windowStart: now,
        samples: [],
        fired: false,
      };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    // 样例只留前 5 条（够 Agent 理解上下文即可，不留全量避免内存增长）
    if (bucket.samples.length < 5) bucket.samples.push(payload);

    // 已达阈值且本窗口未触发过 → 放行（**每个窗口只触发一次**）
    if (bucket.count >= threshold && !bucket.fired) {
      bucket.fired = true;
      const trigger: AggregatedTrigger = {
        eventType: bucket.eventType,
        resourceKey: bucket.resourceKey,
        count: bucket.count,
        windowMs,
        samples: [...bucket.samples],
      };
      this.logger.log(
        `Event aggregated -> trigger: ${eventType} x${bucket.count} on ${bucket.resourceKey}`,
      );
      return { action: "fire", trigger };
    }

    if (bucket.fired) {
      // 本窗口已触发过：继续累积计数但不重复触发（计数用于最终报告）
      return { action: "accumulate", count: bucket.count, needed: 0 };
    }

    return { action: "accumulate", count: bucket.count, needed: threshold };
  }

  /**
   * 取走并清理一个桶的统计（触发后的收尾，让下个窗口重新累积）。
   * 返回 null 表示桶已不存在。
   */
  drain(eventType: string, resourceKey: string | null): AggregateBucket | null {
    const key = `${eventType}::${resourceKey ?? "global"}`;
    const b = this.buckets.get(key) ?? null;
    this.buckets.delete(key);
    return b;
  }

  /** 清理过期桶（防内存泄漏——桶按 (事件,资源) 增长，资源数可能很多）。 */
  sweep(): number {
    const now = Date.now();
    const windowMs = this.resolveWindowMs();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= windowMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 当前桶数（指标/调试用）。 */
  bucketCount(): number {
    return this.buckets.size;
  }

  /** 仅供测试：清空全部桶。 */
  reset(): void {
    this.buckets.clear();
  }

  private readInt(key: string, fallback: number): number {
    const raw = this.config.get<unknown>(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}
