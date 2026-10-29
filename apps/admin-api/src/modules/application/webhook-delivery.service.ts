import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
// W-22 / ARCH-27：保留期天数是**运维可配的运行期参数**，常规形态应注册进
// configuration.ts（Joi + webhookDelivery.ttlDays）经 ConfigService 读取；本轮
// 写入面不含 config/configuration.ts，故按 ARCH-27 唯一豁免口径走 env helper
// （每次 claim 现读，不是模块求值期快照），待 configuration 登记后一行收敛。
import { getEnvVar } from "../../config/env";
import {
  WebhookDelivery,
  WEBHOOK_DELIVERY_SCOPE_APP_RELEASE,
} from "./entities/webhook-delivery.entity";

// 本期唯一 scope；controller 直接从这里取（消费方不必知道实体文件布局）。
export { WEBHOOK_DELIVERY_SCOPE_APP_RELEASE };

/**
 * SEC-3：应用发布 webhook 的**投递去重**。
 *
 * ## 为什么需要
 * `x-autoflow-delivery` 此前只被 controller 接收、从不参与判定：调用方按 GitHub
 * 惯例拿同一个 delivery id 重试（网络抖动/网关 502/CI 自动重试）时，每次都重新
 * 「更新应用版本 + 可选触发滚动升级」——一次抖动 = 一次重复发布。
 *
 * ## claim 的语义（唯一约束仲裁，不做「先 SELECT 再 INSERT」）
 * 判据是**一条** `INSERT ... ON CONFLICT ("scope","deliveryKey") DO UPDATE ... WHERE
 * "expiresAt" < now() RETURNING`：PG 对并发 INSERT 给出确定的赢家，
 *   · 返回 1 行 ⇒ 本次是首次（或上一个占用者**已过期**被重占）→ `claimed: true`；
 *   · 返回 0 行 ⇒ 已有一个**未过期**的同键投递 → `claimed: false`。
 * 先 SELECT 再 INSERT 在并发下必然双放行（两个请求都读到「不存在」），本仓
 * ADR-026 一族缺陷正是这个形态，故刻意不用。
 *
 * ## 无 key = 今天的行为
 * header 缺席（或 trim 后为空串）→ 直接 `{claimed: true, reason: "no_key"}`，
 * **不落库、不查询**，与改动前逐字节一致：不能因为上了去重把没带 header 的
 * 集成（老 CI 脚本 / curl 手测）判成重复。
 *
 * ## 失败姿态
 * `claim` 自身不吞异常（DB 不可达时由 controller 决定 fail-open——宁可重复执行，
 * 不可让发布链路整体挂掉）。但**报告用**的首次接收时间查询是 best-effort：
 * 它不参与判定，取不到就返回 null。
 */

/** 保留期默认 7 天。 */
export const DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS = 7;

/** 保留期 env 键（天）。 */
export const WEBHOOK_DELIVERY_TTL_ENV = "WEBHOOK_DELIVERY_TTL_DAYS";

export type WebhookDeliveryClaimReason = "no_key" | "first" | "duplicate";

export interface WebhookDeliveryClaim {
  /** true = 继续执行（首次 / 无 key / 已过期重占）；false = 重复投递，应短路。 */
  claimed: boolean;
  reason: WebhookDeliveryClaimReason;
  /** 首次接收时间（duplicate 时为**原投递**的时刻；no_key 时为 null）。 */
  receivedAt: Date | null;
}

export interface WebhookDeliveryClaimInput {
  /** 投递面命名空间（本期固定 app_release）。 */
  scope?: string;
  /** 调用方幂等键（`x-autoflow-delivery`），可缺席。 */
  key?: string | null;
  /** 关联应用 id（可空）。 */
  appId?: string | null;
}

/**
 * 幂等键归一：`trim()` 后为空串一律视为「无 key」。
 * 大小写**不**归一——delivery id 由调用方生成，大小写敏感是既有事实；
 * 归一化大小写会把两个真实不同的投递合并成一次（丢发布），比重复更糟。
 */
export function normalizeDeliveryKey(key?: string | null): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 保留期（天）：`WEBHOOK_DELIVERY_TTL_DAYS`，缺省/非法/空值一律回落 7——
 * 绝不让一个坏配置把去重窗口变成 0（= 去重完全失效）或负数（= 每次都是新投递）。
 */
export function resolveWebhookDeliveryTtlDays(): number {
  const raw = getEnvVar(WEBHOOK_DELIVERY_TTL_ENV);
  if (typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS;
}

/** 一条原子 upsert：冲突且**未过期** ⇒ 0 行；冲突且已过期 ⇒ 重占并返回 1 行。 */
const CLAIM_SQL = `
  INSERT INTO "webhook_deliveries" ("scope", "deliveryKey", "appId", "expiresAt")
  VALUES ($1, $2, $3, $4)
  ON CONFLICT ("scope", "deliveryKey") DO UPDATE
     SET "appId" = EXCLUDED."appId",
         "receivedAt" = now(),
         "expiresAt" = EXCLUDED."expiresAt"
   WHERE "webhook_deliveries"."expiresAt" < now()
  RETURNING "id", "receivedAt"
`;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    @InjectRepository(WebhookDelivery)
    private readonly repo: Repository<WebhookDelivery>,
  ) {}

  /**
   * 占用一次投递。返回 `claimed:false` 时调用方必须短路（不写版本、不触发部署）。
   *
   * 过期语义：同键的上一条账本 `expiresAt < now()` 时，本次 claim 会把该行
   * **原地重占**（刷新 receivedAt/expiresAt，claimed:true）——所以 retention
   * 清理滞后不会让某个 key 永久锁死，也不会因为「清理任务没跑」丢掉发布。
   */
  async claim(input: WebhookDeliveryClaimInput): Promise<WebhookDeliveryClaim> {
    const scope = (input.scope ?? WEBHOOK_DELIVERY_SCOPE_APP_RELEASE).trim();
    const key = normalizeDeliveryKey(input.key);
    if (!key) return { claimed: true, reason: "no_key", receivedAt: null };

    const now = Date.now();
    const expiresAt = new Date(
      now + resolveWebhookDeliveryTtlDays() * 86_400_000,
    );

    let rows: Array<{ id: string; receivedAt: Date | string }> = [];
    try {
      rows =
        (await this.repo.query(CLAIM_SQL, [
          scope,
          key,
          input.appId ?? null,
          expiresAt,
        ])) ?? [];
    } catch (err) {
      // ON CONFLICT 已覆盖常规并发；23505 理论上只剩「事务隔离下的重试」等
      // 边角，一律按「已有投递」处理（宁可少发一次，也不重复发布）。
      if (isUniqueViolation(err)) {
        this.logger.warn(
          `webhook-delivery: claim 撞唯一约束（按重复投递处理）scope=${scope} key=${key}`,
        );
        return {
          claimed: false,
          reason: "duplicate",
          receivedAt: await this.firstReceivedAt(scope, key),
        };
      }
      throw err;
    }

    if (Array.isArray(rows) && rows.length > 0) {
      return {
        claimed: true,
        reason: "first",
        receivedAt: toDate(rows[0].receivedAt),
      };
    }

    return {
      claimed: false,
      reason: "duplicate",
      receivedAt: await this.firstReceivedAt(scope, key),
    };
  }

  /**
   * 报告用的首次接收时间。**不参与判定**（判定已由上面的原子 upsert 完成），
   * 所以取不到不是错误——账本行可能刚被 retention 删掉。
   */
  private async firstReceivedAt(
    scope: string,
    key: string,
  ): Promise<Date | null> {
    try {
      const row = await this.repo.findOne({
        where: { scope, deliveryKey: key },
      });
      return row ? toDate(row.receivedAt) : null;
    } catch (err) {
      this.logger.warn(
        `webhook-delivery: 读取首次接收时间失败（不影响去重判定）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}
