import { Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * F1（2026-10-27 审计轮 #7）：回调面的 **per-IP 硬顶**。
 *
 * ## 缺陷形态
 *
 * ExecutorAwareThrottlerGuard.getTracker 对执行器机器面路由按
 * executor:{x-executor-address} 分桶（guard:136-139），而该头是**客户端可设**的。
 * 于是任何一个未认证的客户端，只要每个请求换一个地址值，就得到无限个全新计桶：
 * @Throttle(60/min) 只限制"每个伪造地址"，不限制"整体速率"。
 * 而 /api/executions/callback 恰好是全仓唯一 55MB 预认证 body 解析面
 * （main.ts 的 express.json({ limit: "55mb" })，token 在 handler 才校验）
 * ⇒ 攻击者只花带宽，服务端付出 55MB×并发 的缓冲/对象图 + 每请求 bcrypt。
 *
 * ## 为什么修在这里而不是改分桶
 *
 * B-2 当年把回调改成按执行器分桶，是为了解决"大量执行器共用一个 NAT 出口时
 * 叠加超限被误杀"。把分桶改回 IP 会把这个故障原样带回来；而 @nestjs/throttler
 * 的 getTracker 只有一个返回值，无法同时计两个桶（见 OPEN-DECISIONS D7）。
 * 因此这里加一层**独立于分桶**的边界：按来源 IP 的滑动窗口硬顶，
 * 位于 body parser **之前**——超限请求根本不会被解析。
 *
 * ## 语义边界（写清，避免被误读成通用 Defender）
 *
 * - 只对**指定路由**生效（当前仅回调面），不改变任何路由的既有 60/min 语义；
 * - 多副本部署时是**每副本**独立计数（内存态），总量上限 = 副本数 × 限额；
 * - 限额取得比正常机队高得多（默认 12000/min ≈ 200 rps）：目标是压掉"无限放大"，
 *   而不是卡住正常批量回调——100 台执行器 × 60/min 恰好 6000/min，留 2 倍余量；
 * - 拒绝一律 429 + Retry-After，并**限流告警**（同一 IP 10 分钟一条），
 *   避免"打日志本身成为放大器"这个常见翻车点。
 */

interface Bucket {
  /** 窗口内命中的时刻（升序，只 push 当前时间）。 */
  hits: number[];
}

export interface SlidingWindowOptions {
  /** 窗口内允许的最大请求数。 */
  limit: number;
  /** 窗口长度（毫秒），默认 60s。 */
  windowMs?: number;
  /** 时钟注入（测试用），默认 Date.now。 */
  now?: () => number;
  /** 跟踪的键上界（防内存被随机源 IP 撑爆），默认 20000。 */
  maxTrackedKeys?: number;
}

export interface CeilingDecision {
  allowed: boolean;
  /** 被拒时建议的重试等待（毫秒），供 Retry-After 使用。 */
  retryAfterMs: number;
}

/**
 * 极简滑动窗口计数器（纯逻辑 + 可注入时钟 ⇒ 可确定性测试）。
 *
 * 为什么不用固定窗口：固定窗口在边界处允许 2× 突发（窗口末尾 + 下一窗口开头），
 * 对"55MB 解析"这种放大器来说，2× 依然是放大器。
 */
export class SlidingWindowCeiling {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxTrackedKeys: number;

  constructor(private readonly opts: SlidingWindowOptions) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.maxTrackedKeys = opts.maxTrackedKeys ?? 20_000;
  }

  consume(key: string): CeilingDecision {
    const now = this.now();
    const cutoff = now - this.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.buckets.set(key, bucket);
      this.evictIfNeeded();
    }
    // 丢弃窗口外的时刻
    let drop = 0;
    while (drop < bucket.hits.length && bucket.hits[drop] <= cutoff) drop++;
    if (drop > 0) bucket.hits.splice(0, drop);

    if (bucket.hits.length >= this.opts.limit) {
      // 最早那次请求滑出窗口时即可再试
      const oldest = bucket.hits[0] ?? now;
      return {
        allowed: false,
        retryAfterMs: Math.max(1, oldest + this.windowMs - now),
      };
    }
    bucket.hits.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 当前跟踪的键数量（测试与观测用）。 */
  size(): number {
    return this.buckets.size;
  }

  private evictIfNeeded(): void {
    // Map 保持插入序 ⇒ 删最旧的一批（有界策略：宁可少跟踪，也不让随机源 IP 撑爆内存；
    // 被遗忘的 IP 只是重新开始计数）。
    if (this.buckets.size <= this.maxTrackedKeys) return;
    const excess = this.buckets.size - this.maxTrackedKeys;
    let removed = 0;
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      if (++removed >= excess) break;
    }
  }
}

/**
 * 解析客户端 IP。express 的 trust proxy 是 opt-in（见 main.ts F-6）：
 * 没开时 req.ip 就是直连地址，开了才是 X-Forwarded-For 的受信值。
 * 因此这里只读 express 已经算好的 req.ip，**不自己解析头**——自己解析等于把
 * "可伪造的判定"重新引入（那条路上已经踩过一次：SEC-THROTTLE-BUCKET）。
 */
export function resolveClientIp(req: Partial<Request>): string {
  const anyReq = req as unknown as {
    ip?: string;
    ips?: string[];
    socket?: { remoteAddress?: string };
  };
  const first =
    Array.isArray(anyReq.ips) && anyReq.ips.length > 0
      ? anyReq.ips[0]
      : undefined;
  return first || anyReq.ip || anyReq.socket?.remoteAddress || "unknown";
}

export interface IpCeilingOptions {
  /** 窗口内允许的请求数上限。 */
  limit: number;
  windowMs?: number;
  /** 日志标签（区分不同路由的告警）。 */
  label?: string;
  /** 测试注入点。 */
  now?: () => number;
  logger?: Pick<Logger, "warn">;
}

const WARN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 构造 express 中间件：超限直接 429，**不进入后续解析**。
 *
 * 注册顺序很重要：必须挂在目标路由的 body parser **之前**。
 */
export function createIpCeilingMiddleware(opts: IpCeilingOptions) {
  const ceiling = new SlidingWindowCeiling({
    limit: opts.limit,
    windowMs: opts.windowMs,
    now: opts.now,
  });
  const logger = opts.logger ?? new Logger("IpCeiling");
  const label = opts.label ?? "callback";
  const lastWarnAt = new Map<string, number>();
  const now = opts.now ?? (() => Date.now());
  const windowSeconds = Math.round((opts.windowMs ?? 60_000) / 1000);

  return function ipCeiling(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip = resolveClientIp(req);
    const decision = ceiling.consume(ip);
    if (decision.allowed) {
      next();
      return;
    }

    // 告警节流：被攻击时最容易放大的就是日志本身（同一 IP 10 分钟一条）。
    const at = now();
    const last = lastWarnAt.get(ip);
    if (last === undefined || at - last >= WARN_INTERVAL_MS) {
      lastWarnAt.set(ip, at);
      if (lastWarnAt.size > 1000) lastWarnAt.clear();
      logger.warn(
        "[" +
          label +
          "] per-IP ceiling hit for " +
          ip +
          " (limit=" +
          opts.limit +
          "/" +
          windowSeconds +
          "s) — rejected before body parsing. The per-executor rate limit is keyed " +
          "by the client-supplied x-executor-address header, so this ceiling is what " +
          "bounds the aggregate.",
      );
    }

    res.setHeader(
      "Retry-After",
      String(Math.ceil(decision.retryAfterMs / 1000)),
    );
    res.status(429).json({
      statusCode: 429,
      error: "Too Many Requests",
      message:
        "Too many requests from this source; retry after the Retry-After window. " +
        "Per-executor throttling is additionally applied.",
    });
  };
}
