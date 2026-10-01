/**
 * DEEP-AUDIT B·1.6: 失败通知聚合窗（digest）。
 *
 * ## 为什么需要它
 *
 * 执行失败告警走 execution-events.listener → notifyFailureWithConfig 逐条
 * 即时发送。对"每分钟都在失败"的坏任务（cron 高频 + 代码源断供 + 执行器
 * 全下线……），这是告警风暴：同一 (taskId, failureReason) 组合每分钟轰炸
 * 全渠道，值守把告警静音，真故障反而被漏看。
 *
 * ## 行为
 *
 * - 聚合键：taskId 为窗、(taskId, failureReason) 为记录维度——同一任务的
 *   失败在窗内累计，并按原因细分计数。窗到期发**一条**汇总：总次数、原因
 *   分布、任务名、最近一次错误。
 * - 升级：同窗累计 ≥ DIGEST_ESCALATION_THRESHOLD（5）条时，标题与内容升级
 *   紧急措辞（原因分布恰恰证明这是持续性故障而非偶发）。
 * - 窗口：`NOTIFICATION_FAILURE_DIGEST_MINUTES`（默认 10；0 = 关闭，回退
 *   逐条即时发送的既有行为）。
 * - 状态存 Redis（hash + TTL），跨实例一致：HSETNX start 恰有一个实例拿到
 *   开窗权并挂 flush 定时器；flush 读 HGETALL + DEL，拿到空集的并发 flush
 *   自然跳过（GETDEL 语义的手工版）。
 * - fail-open 三层：Redis 不可用 / 记录失败 / flush 发送失败，一律降级为
 *   警告日志（flush 路径附 NOTIFICATION_FAILED 审计兜底），绝不影响任务
 *   主链，也绝不让窗口"吞掉"告警（record 失败时调用方回退逐条发送）。
 *
 * ## 与既有通路的关系
 *
 * 汇总发送复用 notifyFailureWithConfig（告警渠道路由 + 静默规则 + 模板
 * 变量全同既有失败告警），仅以 titleOverride 区分"汇总"与"单次失败"。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { NotificationService } from "./notification.service";
import { AuditService } from "../audit/audit.service";

/** 单条失败记录（调用方 execution-events.listener 已持有的全部上下文）。 */
export interface DigestFailureRecord {
  /** 缺省（无法定位任务）→ 不聚合，调用方回退逐条发送。 */
  taskId?: string;
  taskName: string;
  failureReason: string;
  /** 最近一次错误的摘要（窗口内覆盖式更新，汇总只带最新一条详情）。 */
  errorSummary: string;
  executionId: string;
  /** 告警路由上下文（首次记录时快照进窗，flush 时原样回放）。 */
  alarmEmail?: string;
  alarmChannels?: string[];
  runbook?: string | null;
  applicationId?: string;
}

/** recordFailure 的裁决：aggregated=已入窗（调用方跳过即时发送）。 */
export type DigestDecision = "aggregated" | "bypass";

/**
 * flush 时从 hash 还原的窗口状态（纯数据，便于测试断言）。
 */
export interface DigestWindowState {
  taskId: string;
  taskName: string;
  count: number;
  reasons: Record<string, number>;
  lastError: string;
  lastExecutionId: string;
  ctx: {
    alarmEmail?: string;
    alarmChannels?: string[];
    runbook?: string | null;
    applicationId?: string;
  };
}

/** 同窗失败达到该条数即升级紧急措辞。 */
export const DIGEST_ESCALATION_THRESHOLD = 5;

/** Redis key 前缀（hash；TTL = 窗口×2，防实例崩溃后残留）。 */
export const DIGEST_KEY_PREFIX = "acf:notif:digest:win:";

/**
 * flush 所需的 Redis 命令面（结构化类型：ioredis 天然满足，测试用内存替身）。
 * 不直接依赖 Redis 实例类型，单测无需真实连接。
 */
export interface DigestRedisClient {
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<number>;
}

@Injectable()
export class NotificationDigestService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationDigestService.name);
  private client: Redis | null = null;
  /** taskId → flush 定时器（仅持有开窗权的实例挂表）。 */
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
    // flush 发送失败与 record 兜底同语义：warn + NOTIFICATION_FAILED 审计
    // （@Optional 与 listener 同先例——存量测试模块未提供时降级为仅日志）。
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  /**
   * 测试/特殊部署注入外部客户端（如复用既有连接池）。生产路径走 ensureClient
   * 惰性建连（redis-lock.service 同款：不依赖 onModuleInit 顺序）。
   */
  setRedisClientForTesting(client: DigestRedisClient | null): void {
    if (this.client) {
      // ioredis disconnect() 返回 void（同步断开），无 promise 可 catch。
      this.client.disconnect();
      this.client = null;
    }
    // 结构化注入：测试替身不满足 Redis 完整类型，仅存 flush/record 用面。
    (this as { testClient?: DigestRedisClient | null }).testClient = client;
  }

  /** 聚合窗（分钟）。0 或非法值 = 关闭。 */
  getDigestWindowMs(): number {
    const minutes = this.configService.get<number>(
      "notification.failureDigestMinutes",
    );
    if (
      typeof minutes !== "number" ||
      !Number.isFinite(minutes) ||
      minutes <= 0
    ) {
      return 0;
    }
    return minutes * 60_000;
  }

  private rawClient(): DigestRedisClient | null {
    const injected = (this as { testClient?: DigestRedisClient | null })
      .testClient;
    if (injected) return injected;
    return this.ensureClient();
  }

  /**
   * 惰性建连（N3 同款：不依赖 onModuleInit 生命周期顺序）。Redis 不可达时
   * 返回 null——调用方按 bypass 处理，绝不阻塞任务主链。
   */
  private ensureClient(): DigestRedisClient | null {
    if (this.client) return this.client;
    try {
      this.client = new Redis({
        host: this.configService.get<string>("redis.host"),
        port: this.configService.get<number>("redis.port"),
        password: this.configService.get<string>("redis.password"),
        db: this.configService.get<number>("redis.db", 0),
        commandTimeout: 3000,
        // 告警聚合是纯增强面：连接失败安静重试即可，不打扰主链日志。
        retryStrategy: (times) => Math.min(times * 100, 3000),
        lazyConnect: true,
      });
      this.client.on("error", (err: Error) => {
        this.logger.warn(`digest redis error: ${err.message}`);
      });
      this.client.connect().catch(() => undefined);
      return this.client;
    } catch (err: unknown) {
      this.logger.warn(
        `digest redis unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.client) {
      await this.client.quit().catch(() => undefined);
      this.client = null;
    }
    (this as { testClient?: DigestRedisClient | null }).testClient = null;
  }

  /**
   * 记录一次失败。返回 "aggregated" 表示已入窗（调用方**跳过**逐条发送，
   * 汇总在窗到期时发出）；"bypass" 表示聚合不适用/不可用（调用方回退逐条
   * 即时发送——既有行为）。本方法绝不抛错。
   */
  async recordFailure(rec: DigestFailureRecord): Promise<DigestDecision> {
    const windowMs = this.getDigestWindowMs();
    if (windowMs <= 0) return "bypass"; // 显式关闭
    if (!rec.taskId) return "bypass"; // 无法定位任务，聚合无意义

    const key = `${DIGEST_KEY_PREFIX}${rec.taskId}`;
    try {
      const client = this.rawClient();
      if (!client) return "bypass";

      // 开窗：HSETNX 原子裁决——恰好一个实例拿到 1 并挂 flush 定时器
      // （跨实例唯一 flusher；实例崩溃则该窗静默过期，下一窗自愈）。
      const opened = await client.hsetnx(key, "start", String(Date.now()));
      if (opened === 1) {
        this.scheduleFlush(rec.taskId, windowMs);
      }
      // TTL 兜底：flush 丢失（实例崩溃）时残留窗最多活 2 个窗口期。
      await client.expire(key, Math.ceil((windowMs * 2) / 1000));

      await client.hincrby(key, "count", 1);
      await client.hincrby(key, `r:${rec.failureReason}`, 1);
      // 上下文快照：首条记录定路由（后续覆盖无妨——同任务配置本就一致）。
      await client.hset(
        key,
        "ctx",
        JSON.stringify({
          taskName: rec.taskName,
          alarmEmail: rec.alarmEmail,
          alarmChannels: rec.alarmChannels,
          runbook: rec.runbook,
          applicationId: rec.applicationId,
        }),
      );
      await client.hset(key, "lastError", rec.errorSummary.slice(0, 500));
      await client.hset(key, "lastExecutionId", rec.executionId);
      return "aggregated";
    } catch (err: unknown) {
      this.logger.warn(
        `digest record failed for task ${rec.taskId}（回退逐条发送）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "bypass";
    }
  }

  /** 挂窗到期 flush 定时器（unref：绝不拖住进程退出）。 */
  private scheduleFlush(taskId: string, windowMs: number): void {
    const existing = this.timers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      void this.flush(taskId);
    }, windowMs);
    timer.unref?.();
    this.timers.set(taskId, timer);
  }

  /**
   * 窗到期：读窗 → 删窗 → 发一条汇总。HGETALL+DEL 非原子，但 flush 定时器
   * 仅存在于开窗实例，双 flush 只在多实例同时手工触发时理论可达——拿到空集
   * 的一方自然跳过（最坏情况是两条并发都读到同一窗，重复一条汇总，可接受）。
   */
  async flush(taskId: string): Promise<DigestWindowState | null> {
    const key = `${DIGEST_KEY_PREFIX}${taskId}`;
    try {
      const client = this.rawClient();
      if (!client) return null;
      const raw = await client.hgetall(key);
      if (raw && Object.keys(raw).length > 0) {
        await client.del(key);
      } else {
        return null; // 空窗（被并发 flush 抢先）→ 静默跳过
      }
      const state = this.parseWindowState(taskId, raw);
      await this.sendDigest(state);
      return state;
    } catch (err: unknown) {
      this.logger.warn(
        `digest flush failed for task ${taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // 汇总发送是告警链路的一部分，失败落 NOTIFICATION_FAILED 审计兜底
      // （与 listener 的直接发送失败同款处置）。
      try {
        await this.auditService?.log({
          action: "NOTIFICATION_FAILED",
          resource: "notification_digest",
          resourceId: taskId,
          detail: {
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch {
        /* audit is best-effort */
      }
      return null;
    }
  }

  /** 从 HGETALL 原始字段还原窗口状态（纯函数，单测直测）。 */
  parseWindowState(
    taskId: string,
    raw: Record<string, string>,
  ): DigestWindowState {
    let ctx: DigestWindowState["ctx"] = {};
    try {
      const parsed = raw.ctx ? (JSON.parse(raw.ctx) as DigestWindowState["ctx"] & { taskName?: string }) : {};
      ctx = parsed;
    } catch {
      // 上下文损坏（不应发生）→ 退化为无路由信息，任务名用 taskId 兜底。
    }
    const reasons: Record<string, number> = {};
    for (const [field, value] of Object.entries(raw)) {
      if (field.startsWith("r:")) {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) {
          reasons[field.slice(2)] = n;
        }
      }
    }
    return {
      taskId,
      taskName: (ctx as { taskName?: string }).taskName || taskId,
      count: parseInt(raw.count ?? "0", 10) || 0,
      reasons,
      lastError: raw.lastError ?? "",
      lastExecutionId: raw.lastExecutionId ?? "",
      ctx: {
        alarmEmail: ctx.alarmEmail,
        alarmChannels: ctx.alarmChannels,
        runbook: ctx.runbook,
        applicationId: ctx.applicationId,
      },
    };
  }

  /**
   * 汇总发送（复用既有失败告警通路：渠道路由 + 静默 + 模板变量同口径）。
   * count ≥ 阈值时升级紧急措辞。
   */
  private async sendDigest(state: DigestWindowState): Promise<void> {
    if (state.count <= 0) return;
    const escalated = state.count >= DIGEST_ESCALATION_THRESHOLD;
    const reasonDist = Object.entries(state.reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}×${n}`)
      .join(", ");
    const summaryLines = [
      `窗口内共失败 ${state.count} 次。`,
      reasonDist ? `原因分布: ${reasonDist}。` : "",
      state.lastError ? `最近错误: ${state.lastError}` : "",
    ].filter(Boolean);
    const summary = escalated
      ? `【紧急】同窗口失败已达 ${state.count} 次（阈值 ${DIGEST_ESCALATION_THRESHOLD}），已升级为紧急告警，请立即处理。${summaryLines.join("\n")}`
      : summaryLines.join("\n");

    try {
      await this.notificationService.notifyFailureWithConfig(
        state.taskName,
        state.lastExecutionId,
        summary,
        "",
        state.ctx.alarmEmail,
        state.ctx.alarmChannels,
        undefined,
        state.taskId,
        state.ctx.runbook,
        state.ctx.applicationId,
        escalated
          ? `【紧急】任务连续失败: ${state.taskName}`
          : `任务失败汇总: ${state.taskName}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `digest summary send failed for task ${state.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      try {
        await this.auditService?.log({
          action: "NOTIFICATION_FAILED",
          resource: "notification_digest",
          resourceId: state.taskId,
          detail: {
            error: err instanceof Error ? err.message : String(err),
            count: state.count,
          },
        });
      } catch {
        /* audit is best-effort */
      }
    }
  }
}
