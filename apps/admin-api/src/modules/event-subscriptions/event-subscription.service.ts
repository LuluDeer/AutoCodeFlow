import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { assertSafeHttpUrl } from "../../common/utils/safe-http.util";
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
  ) {}

  private isAdmin(user: AuthUser): boolean {
    return user.role === "admin";
  }

  /** ADMIN/属主校验；不命中抛 403（防订阅 id 枚举语义与 404 混淆）。 */
  private assertCanManage(sub: EventSubscription, user: AuthUser): void {
    if (this.isAdmin(user)) return;
    if (sub.userId !== null && sub.userId === user.id) return;
    throw new ForbiddenException("You do not own this subscription");
  }

  async create(
    dto: CreateEventSubscriptionDto,
    user: AuthUser,
  ): Promise<{ subscription: EventSubscription; generatedSecret?: string }> {
    // SSRF 深校验（DNS 解析逐地址拒内网）——形状校验已在 DTO 层完成。
    await assertSafeHttpUrl(dto.url);

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
          where: [{ userId: user.id }, { userId: null }],
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

    if (dto.url !== undefined && dto.url !== sub.url) {
      await assertSafeHttpUrl(dto.url);
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
    return this.mask(saved);
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const sub = await this.subRepo.findOne({ where: { id } });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);
    this.assertCanManage(sub, user);
    await this.subRepo.delete(id);
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
  }

  async saveDeadLetter(row: EventSubscriptionDeadLetter): Promise<void> {
    await this.deadLetterRepo.save(row);
  }

  async recordDeliveryFailure(
    sub: EventSubscription,
    error: string,
  ): Promise<void> {
    sub.consecutiveFailures += 1;
    sub.lastFailureAt = new Date();
    sub.lastFailureError = error.slice(0, 512);
    await this.subRepo.save(sub);
  }

  async recordDeliverySuccess(sub: EventSubscription): Promise<void> {
    if (sub.consecutiveFailures === 0) return;
    sub.consecutiveFailures = 0;
    sub.lastFailureAt = null;
    sub.lastFailureError = null;
    await this.subRepo.save(sub);
  }

  /** 读面脱敏：secret 永不出 API。 */
  private mask(sub: EventSubscription): EventSubscription {
    return { ...sub, secret: SECRET_MASK };
  }
}
