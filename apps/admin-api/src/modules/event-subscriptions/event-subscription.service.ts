import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { IsNull, Repository } from "typeorm";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { createHash } from "node:crypto";
// D3-B-P1-3: webhook 订阅改向审计落证（@Optional 同 application.service——
// 既有单测装配未提供时降级为仅日志）。
import { AuditService } from "../audit/audit.service";
import { assertSafeHttpUrl } from "../../common/utils/safe-http.util";
// A2-B: 属主校验的运行时证据落点
import { recordOwnershipAssertion } from "../../common/guards/ownership-assertion.store";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "./entities/event-subscription-dead-letter.entity";
import {
  CreateEventSubscriptionDto,
  UpdateEventSubscriptionDto,
} from "./dto/event-subscription.dto";
import {
  generateSubscriptionSecret,
  isSubscribableEvent,
  MAX_EVENT_SUBSCRIPTIONS,
  SECRET_MASK,
} from "./event-subscription.util";

/**
 * FEAT-07: 出站事件订阅 CRUD。
 *
 * 鉴权模型（与平台既有「ADMIN 写面 + 属主可见」形态对齐）：
 * - 建订阅：任何已登录用户可建（userId 记创建者）；非 ADMIN 传 userId=false
 *   归一为自己；ADMIN 可建系统级订阅（userId=null，全体管理员可见可管）。
 * - 列表：ADMIN 看全部；普通用户只看自己的（含系统级，便于排障）。
 * - 单条/更新/删除/死信：ADMIN 或属主（userId 命中）。
 * - secret 永不出读端点（固定占位符）；create 响应一次性回显明文（若用户
 *   未自带 secret）——与「secret 只在创建时可见」的平台惯例一致。
 */
@Injectable()
export class EventSubscriptionService {
  private readonly logger = new Logger(EventSubscriptionService.name);

  constructor(
    @InjectRepository(EventSubscription)
    private readonly subRepo: Repository<EventSubscription>,
    @InjectRepository(EventSubscriptionDeadLetter)
    private readonly deadLetterRepo: Repository<EventSubscriptionDeadLetter>,
    private readonly config: ConfigService,
    // D3-B-P1-3: 审计落证（@Optional 同上——存量 spec 未提供时降级）。
    @Optional()
    private readonly audit: AuditService | null = null,
  ) {}

  /**
   * ARCH-31（2026-09-13）: SSRF 私网豁免开关（创建/更新校验与出站复核共用）。
   * 默认 false = 既有姿态零变化；true 放行 loopback/restricted/private-lan，
   * link-local 云元数据恒拒（语义见 assertSafeHttpUrl opts 注记）。
   */
  private ssrfOpts(): { allowPrivateNetwork: boolean } {
    return {
      allowPrivateNetwork:
        this.config.get<boolean>("eventWebhook.allowPrivateNetwork") === true,
    };
  }

  private isAdmin(user: AuthUser): boolean {
    return user.role === "admin";
  }

  /** D3-B-P1-3: URL 哈希（不落明文 webhook URL，仅落 SHA-256 前 12 字符用于改向比对）。 */
  private urlHash(url: string): string {
    return createHash("sha256").update(url).digest("hex").slice(0, 12);
  }

  /** D3-B-P1-3: best-effort 审计落证（fail-open，审计故障不阻断主链）。 */
  private async writeAudit(payload: {
    user: AuthUser;
    action: string;
    resourceId: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        userId: payload.user.id,
        username: payload.user.username,
        action: payload.action,
        resource: "event_subscription",
        resourceId: payload.resourceId,
        detail: payload.detail,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Audit write failed for ${payload.action}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** ADMIN/属主校验；不命中抛 403（防订阅 id 枚举语义与 404 混淆）。 */
  private assertCanManage(sub: EventSubscription, user: AuthUser): void {
    // A2-B: 先落证再判定（同 task/application 的属主守卫）。
    recordOwnershipAssertion("event-subscription", "write");
    if (this.isAdmin(user)) return;
    if (sub.userId !== null && sub.userId === user.id) return;
    throw new ForbiddenException("You do not own this subscription");
  }

  /**
   * O-2（SEC-NEW）: EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK=true 时，任何登录用户
   * 都能让平台向内网 endpoint 发签名 webhook（内网盲探/信息泄露面）。开启该
   * 开关即选择「webhook 可达内网」，故创建/更新订阅收窄为仅 ADMIN 可写——
   * 普通用户仍可读（列表/详情），私网开关的信任半径收回到管理员。
   */
  private assertPrivateNetworkWriteAllowed(user: AuthUser): void {
    if (
      this.config.get<boolean>("eventWebhook.allowPrivateNetwork") === true &&
      !this.isAdmin(user)
    ) {
      throw new ForbiddenException(
        "Creating/updating event subscriptions requires ADMIN while EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK=true",
      );
    }
  }

  async create(
    dto: CreateEventSubscriptionDto,
    user: AuthUser,
  ): Promise<{ subscription: EventSubscription; generatedSecret?: string }> {
    this.assertPrivateNetworkWriteAllowed(user);
    // SSRF 深校验（DNS 解析逐地址拒内网）——形状校验已在 DTO 层完成。
    await assertSafeHttpUrl(dto.url, this.ssrfOpts());

    const count = await this.subRepo.count();
    if (count >= MAX_EVENT_SUBSCRIPTIONS) {
      throw new BadRequestException(
        `Too many event subscriptions (max ${MAX_EVENT_SUBSCRIPTIONS}). Remove unused ones first.`,
      );
    }

    // 事件名最终防线：DTO @IsIn 已挡，这里兜底（service 可被绕过 controller 调）。
    for (const t of dto.eventTypes) {
      if (!isSubscribableEvent(t)) {
        throw new BadRequestException(`Unknown event type: ${t}`);
      }
    }

    let secret = dto.secret;
    let generatedSecret: string | undefined;
    if (!secret) {
      generatedSecret = generateSubscriptionSecret();
      secret = generatedSecret;
    }

    const sub = await this.subRepo.save(
      this.subRepo.create({
        // 非 ADMIN 一律挂自己名下；ADMIN 未传/false 时建系统级（userId=null）。
        userId: this.isAdmin(user) ? null : user.id,
        eventTypes: [...new Set(dto.eventTypes)],
        url: dto.url,
        secret,
        enabled: true,
      }),
    );
    this.logger.log(
      `Event subscription created id=${sub.id} events=[${sub.eventTypes.join(",")}] by user=${user.id}`,
    );
    // D3-B-P1-3: 创建落证（URL 哈希，不落密钥明文）。
    await this.writeAudit({
      user,
      action: "subscription.create",
      resourceId: sub.id,
      detail: { urlHash: this.urlHash(sub.url), eventTypes: sub.eventTypes },
    });
    // 一次性回显：仅当服务端代生成时把明文 secret 带回给调用方。
    return {
      subscription: this.mask(sub),
      ...(generatedSecret ? { generatedSecret } : {}),
    };
  }

  async findAll(user: AuthUser): Promise<EventSubscription[]> {
    const rows = this.isAdmin(user)
      ? await this.subRepo.find({ order: { createdAt: "DESC" }, take: 500 })
      : await this.subRepo.find({
          // TypeORM 1.x：where 里的 `null` 字面量不再编译成 `IS NULL`，而是按
          // invalidWhereValuesBehavior 默认 **抛错**（0.3.x 是静默 IS NULL）。
          // 系统级订阅的 userId 列本就是 NULL，故必须显式写 IsNull()；否则普通
          // 用户拉取订阅列表恒 500（管理员走上面的分支，因此只有非管理员复现）。
          where: [{ userId: user.id }, { userId: IsNull() }],
          order: { createdAt: "DESC" },
          take: 500,
        });
    return rows.map((r) => this.mask(r));
  }

  async findOne(id: string, user: AuthUser): Promise<EventSubscription> {
    const sub = await this.subRepo.findOne({ where: { id } });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);
    this.assertCanManage(sub, user);
    return this.mask(sub);
  }

  async update(
    id: string,
    dto: UpdateEventSubscriptionDto,
    user: AuthUser,
  ): Promise<EventSubscription> {
    const sub = await this.subRepo.findOne({ where: { id } });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);
    this.assertCanManage(sub, user);
    // D3-B-P1-3: 捕获改向前 URL 哈希（用于比对改向）。
    const oldUrlHash = this.urlHash(sub.url);
    // O-2: 私网开关开启时更新（含改 URL）同样收窄为 ADMIN。
    if (dto.url !== undefined && dto.url !== sub.url) {
      this.assertPrivateNetworkWriteAllowed(user);
      await assertSafeHttpUrl(dto.url, this.ssrfOpts());
      sub.url = dto.url;
    }
    if (dto.eventTypes !== undefined) {
      for (const t of dto.eventTypes) {
        if (!isSubscribableEvent(t)) {
          throw new BadRequestException(`Unknown event type: ${t}`);
        }
      }
      sub.eventTypes = [...new Set(dto.eventTypes)];
    }
    if (dto.secret !== undefined) sub.secret = dto.secret;
    if (dto.enabled !== undefined) sub.enabled = dto.enabled;

    const saved = await this.subRepo.save(sub);
    // D3-B-P1-3: 更新落证（新旧 URL 哈希，不落密钥明文）。
    await this.writeAudit({
      user,
      action: "subscription.update",
      resourceId: id,
      detail: {
        oldUrlHash,
        newUrlHash: this.urlHash(saved.url),
        urlChanged: oldUrlHash !== this.urlHash(saved.url),
      },
    });
    return this.mask(saved);
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const sub = await this.subRepo.findOne({ where: { id } });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);
    this.assertCanManage(sub, user);
    await this.subRepo.delete(id);
    // D3-B-P1-3: 删除落证。
    await this.writeAudit({
      user,
      action: "subscription.delete",
      resourceId: id,
      detail: { urlHash: this.urlHash(sub.url) },
    });
    // dead_letters 由 FK ON DELETE CASCADE 级联清理。
  }

  /**
   * 死信列表（属主/ADMIN）。分页上限由 DTO 拦 + service 双重截断（DEP-01 先例）。
   */
  async listDeadLetters(
    id: string,
    user: AuthUser,
    page = 1,
    limit = 20,
  ): Promise<{ data: EventSubscriptionDeadLetter[]; total: number }> {
    const sub = await this.subRepo.findOne({ where: { id } });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);
    this.assertCanManage(sub, user);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safePage = Math.max(1, page);
    const [data, total] = await this.deadLetterRepo.findAndCount({
      where: { subscriptionId: id },
      order: { createdAt: "DESC" },
      take: safeLimit,
      skip: (safePage - 1) * safeLimit,
    });
    return { data, total };
  }

  /** 取一行死信（属主/ADMIN 校验后返回订阅与死信，供 replay 流程）。 */
  async getDeadLetterForReplay(
    id: string,
    deadLetterId: string,
    user: AuthUser,
  ): Promise<{
    subscription: EventSubscription;
    deadLetter: EventSubscriptionDeadLetter;
  }> {
    const sub = await this.subRepo.findOne({ where: { id } });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);
    this.assertCanManage(sub, user);
    const deadLetter = await this.deadLetterRepo.findOne({
      where: { id: deadLetterId, subscriptionId: id },
    });
    if (!deadLetter) {
      throw new NotFoundException(`Dead letter ${deadLetterId} not found`);
    }
    return { subscription: sub, deadLetter };
  }

  async deleteDeadLetter(deadLetterId: string): Promise<void> {
    await this.deadLetterRepo.delete(deadLetterId);
    // D3-B-P1-3: 死信清理落证（系统路径，无操作人）。
    if (this.audit) {
      try {
        await this.audit.log({
          action: "subscription.deadLetter.delete",
          resource: "event_subscription_dead_letter",
          resourceId: deadLetterId,
        });
      } catch (err: unknown) {
        this.logger.warn(
          `Audit write failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  async saveDeadLetter(row: EventSubscriptionDeadLetter): Promise<void> {
    await this.deadLetterRepo.save(row);
  }

  async recordDeliveryFailure(
    sub: EventSubscription,
    error: string,
  ): Promise<void> {
    // NETOPT-1⑨: 原「快照 += 1 后 save」是读-改-写——并发事件同时失败时各自
    // 基于同一快照写回相同值，consecutiveFailures 丢更新（实体无
    // @VersionColumn，save 无乐观锁保护）。改 DB 内原子自增的条件 UPDATE；
    // 列名为 camelCase（实体属性即列名），raw 表达式需带引号防小写折叠。
    await this.subRepo.update(
      { id: sub.id },
      {
        consecutiveFailures: () => '"consecutiveFailures" + 1',
        lastFailureAt: new Date(),
        lastFailureError: error.slice(0, 512),
      },
    );
  }

  async recordDeliverySuccess(sub: EventSubscription): Promise<void> {
    if (sub.consecutiveFailures === 0) return;
    // NETOPT-1⑨: 快照 save 同样有丢更新窗口（快照 2 与 DB 3 并发时写回 2，
    // 把别人的失败计数抹掉）——改显式 UPDATE 0。热路径守卫保持快照判断：
    // 快照为 0 时大概率 DB 也是 0，免一次写库。
    await this.subRepo.update(
      { id: sub.id },
      { consecutiveFailures: 0, lastFailureAt: null, lastFailureError: null },
    );
  }

  /** 读面脱敏：secret 永不出 API。 */
  private mask(sub: EventSubscription): EventSubscription {
    return { ...sub, secret: SECRET_MASK };
  }
}
