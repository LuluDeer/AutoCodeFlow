import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import {
  NotificationSilence,
  SILENCE_SCOPES,
  type SilenceScope,
} from "./entities/notification-silence.entity";

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
      throw new BadRequestException(
        `invalid scope ${String(input.scope)}; expected one of ${SILENCE_SCOPES.join(", ")}`,
      );
    }
    if (input.scope === "task" && !input.taskId) {
      throw new BadRequestException("scope=task requires taskId");
    }
    if (input.scope === "application" && !input.applicationId) {
      throw new BadRequestException("scope=application requires applicationId");
    }
    if (
      input.channelType != null &&
      !["email", "slack", "dingtalk", "wecom", "webhook"].includes(
        input.channelType,
      )
    ) {
      throw new BadRequestException(
        `invalid channelType ${input.channelType}`,
      );
    }

    const activeCount = await this.repo.count();
    if (activeCount >= NotificationSilenceService.MAX_SILENCES) {
      throw new BadRequestException(
        `Too many alert silences (max ${NotificationSilenceService.MAX_SILENCES}). Remove expired ones first.`,
      );
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
