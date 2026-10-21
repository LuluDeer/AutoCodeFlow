import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import {
  NotificationSilence,
  SILENCE_SCOPES,
  type SilenceScope,
} from "./entities/notification-silence.entity";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

/**
 * FEAT-01: 通知静默规则的 DB 读写层。
 *
 * NotificationService 保留内存 Map 做热路径判定（isSilenced 是同步语义），
 * 本服务负责持久化：create/listActive/remove/cleanExpired。DB 不可用时
 * NotificationService 降级回纯内存语义（NOTIF-003 的既有可接受降级）。
 */
export interface CreateSilenceInput {
  scope: SilenceScope;
  channelType?: string | null;
  taskId?: string | null;
  applicationId?: string | null;
  level?: string | null;
  reason?: string | null;
  durationMinutes?: number | null;
  startTime?: Date | null;
  endTime?: Date | null;
  createdBy?: string | null;
}

@Injectable()
export class NotificationSilenceService {
  private logger = new Logger(NotificationSilenceService.name);
  /** 与 NOTIF-003 内存上限对齐，防 API 滥用打爆表 */
  private static readonly MAX_SILENCES = 1000;

  constructor(
    @InjectRepository(NotificationSilence)
    private readonly repo: Repository<NotificationSilence>,
  ) {}

  async create(input: CreateSilenceInput): Promise<NotificationSilence> {
    if (!SILENCE_SCOPES.includes(input.scope)) {
      throw new AppError(ErrorCode.NOTIFICATION_SILENCE_SCOPE_INVALID, {
        scope: String(input.scope),
        validScopes: SILENCE_SCOPES.join(", "),
      });
    }
    if (input.scope === "task" && !input.taskId) {
      throw new AppError(ErrorCode.NOTIFICATION_SILENCE_TASK_ID_REQUIRED);
    }
    if (input.scope === "application" && !input.applicationId) {
      throw new AppError(
        ErrorCode.NOTIFICATION_SILENCE_APPLICATION_ID_REQUIRED,
      );
    }
    // NETOPT-5①: level 枚举校验（此前任意字符串都落库，静默可能因手误
    // 永不命中）。口径与 AlertLevel 一致（info/warning/error/critical）。
    const VALID_SILENCE_LEVELS = ["info", "warning", "error", "critical"];
    if (
      input.level != null &&
      !VALID_SILENCE_LEVELS.includes(String(input.level))
    ) {
      throw new AppError(ErrorCode.NOTIFICATION_SILENCE_LEVEL_INVALID, {
        level: String(input.level),
        validLevels: VALID_SILENCE_LEVELS.join(", "),
      });
    }
    // NETOPT-5①: durationMinutes 数字校验。运行时 @Body() 无 ValidationPipe
    // 白名单（见 CreateSilenceDto 注释），字符串 "abc" 直达此处——旧逻辑
    // `"abc" > 0` 恒 false 跳过折算，endTime 落 NULL = 永不过期静默。
    if (
      input.durationMinutes != null &&
      (typeof input.durationMinutes !== "number" ||
        !Number.isFinite(input.durationMinutes) ||
        input.durationMinutes <= 0)
    ) {
      throw new AppError(ErrorCode.NOTIFICATION_SILENCE_DURATION_INVALID, {
        durationMinutes: String(input.durationMinutes),
      });
    }
    // R150-A1（出站面审计 · 轴3）：白名单此前是**手写第四份**渠道清单，且停在
    // NF-05 之前的五值——feishu 已进 AlertChannel / 渠道实现 / 管理台，但它作为
    // channelType 建静默会被这里直接 400（"已注册渠道无法被静默"，前后端都
    // 选不出来源）。渠道 id 的单一事实源是 AlertChannel；本文件不 import 它是为了
    // 避免 notification.service ⇄ notification-silence.service 的运行时环，故
    // 保持字面量，并由此处的漂移钉子兜底：
    // __tests__/outbound-audit-r150.spec.ts 逐枚举行断言
    // `Object.values(AlertChannel)` 全部可建 → 新增渠道漏加即红。
    if (
      input.channelType != null &&
      !["email", "slack", "dingtalk", "wecom", "webhook", "feishu"].includes(
        input.channelType,
      )
    ) {
      throw new AppError(ErrorCode.NOTIFICATION_SILENCE_CHANNEL_TYPE_INVALID, {
        channelType: input.channelType,
      });
    }

    const activeCount = await this.repo.count();
    if (activeCount >= NotificationSilenceService.MAX_SILENCES) {
      throw new AppError(ErrorCode.NOTIFICATION_SILENCE_TOO_MANY, {
        max: NotificationSilenceService.MAX_SILENCES,
      });
    }

    const entity = this.repo.create({
      scope: input.scope,
      channelType: input.channelType ?? null,
      taskId: input.taskId ?? null,
      applicationId: input.applicationId ?? null,
      level: input.level ?? null,
      reason: input.reason ?? null,
      startTime: input.startTime ?? new Date(),
      endTime: input.endTime ?? null,
      durationMinutes: input.durationMinutes ?? null,
      createdBy: input.createdBy ?? null,
    });
    // durationMinutes 折算 endTime（与内存 addSilence 语义一致）
    if (
      entity.durationMinutes != null &&
      entity.durationMinutes > 0 &&
      !entity.endTime
    ) {
      entity.endTime = new Date(
        entity.startTime.getTime() + entity.durationMinutes * 60_000,
      );
    }
    return this.repo.save(entity);
  }

  /** 当前生效（startTime<=now<endTime 或无界）的静默，供内存回灌 */
  async listActive(now = new Date()): Promise<NotificationSilence[]> {
    return this.repo
      .createQueryBuilder("s")
      .where("s.startTime IS NULL OR s.startTime <= :now", { now })
      .andWhere("s.endTime IS NULL OR s.endTime > :now", { now })
      .orderBy("s.createdAt", "DESC")
      .take(1000)
      .getMany();
  }

  async listAll(): Promise<NotificationSilence[]> {
    return this.repo.find({ order: { createdAt: "DESC" }, take: 1000 });
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.repo.delete(id);
    return (result.affected ?? 0) > 0;
  }

  /** 清扫已过期行（endTime < now），返回清除数；失败的过期行保留（listActive 已过滤） */
  async cleanExpired(now = new Date()): Promise<number> {
    const result = await this.repo.delete({ endTime: LessThan(now) });
    return result.affected ?? 0;
  }
}
