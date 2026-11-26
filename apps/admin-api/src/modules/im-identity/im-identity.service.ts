import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { AuditService } from "../audit/audit.service";
import { UsersService } from "../users/users.service";
import {
  isProjectRole,
  type ProjectRole,
} from "../project/entities/project-member.entity";
import { ImIdentity, type ImPlatform } from "./entities/im-identity.entity";
import { VerifyBindDto } from "./dto/verify-bind.dto";
import { scanImMessage, type ImInjectionScanResult } from "./injection-guard";
import { verifyImSender } from "./sender-validator";

/** 审计动作名（N6 要求进 audit.md 登记，由 lead 补）。 */
export const IM_IDENTITY_BIND_ACTION = "im_identity.bind";

/** 绑定入口消费的 Gateway sender 签名头 + 原始体。 */
export interface ImSenderHeaders {
  signature?: string;
  timestamp?: string;
  rawBody?: Buffer;
}

/**
 * N6 / GCO §11.3：IM 身份绑定的服务层。
 *
 * 顺序固定：先验 Gateway sender 签名（含时间窗）→ 再验平台 user 真实存在 →
 * 再验项目角色 → 落库 verified=true → 审计双字段。**任何一步失败都不绑定**。
 * managed 治理不在此层。
 */
@Injectable()
export class ImIdentityService {
  private readonly logger = new Logger(ImIdentityService.name);

  constructor(
    @InjectRepository(ImIdentity)
    private readonly repo: Repository<ImIdentity>,
    private readonly users: UsersService,
    private readonly config: ConfigService,
    @Optional() private readonly audit: AuditService | null = null,
  ) {}

  /**
   * Gateway sender 校验通过后把 (platform, imSenderId) 绑定到平台 user。
   * 签名密钥走 ConfigService（ARCH-27：不直读 process.env）。
   */
  async verifyAndBind(
    dto: VerifyBindDto,
    headers: ImSenderHeaders,
    actor?: { id: number; username: string },
  ): Promise<ImIdentity> {
    const secret = this.config?.get<string>("IM_SIGNING_SECRET") ?? "";
    const verification = verifyImSender(
      {
        platform: dto.platform,
        imSenderId: dto.imSenderId,
        signature: headers?.signature,
        timestamp: headers?.timestamp,
        rawBody: headers?.rawBody,
      },
      secret,
    );
    if (!verification.ok) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: `IM sender verification failed: ${verification.reason ?? "unknown"}`,
      });
    }

    // 绑定目标必须是平台真实 user（UsersService.findByIdOrNull，存在即返回）。
    const user = await this.users.findByIdOrNull(dto.platformUserId);
    if (!user) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: `platform user ${dto.platformUserId} not found`,
      });
    }

    if (dto.projectRole !== undefined && !isProjectRole(dto.projectRole)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: `invalid projectRole: ${String(dto.projectRole)}`,
      });
    }

    let row = await this.repo.findOne({
      where: {
        platform: dto.platform as ImPlatform,
        imSenderId: dto.imSenderId,
      },
    });
    if (!row) {
      row = this.repo.create({
        platform: dto.platform as ImPlatform,
        imSenderId: dto.imSenderId,
      });
    }
    row.platformUserId = user.id;
    row.projectId = dto.projectId ?? null;
    row.projectRole = (dto.projectRole as ProjectRole | undefined) ?? null;
    row.verified = true;
    row.createdBy = row.createdBy ?? (actor ? `user:${actor.id}` : null);

    const saved = await this.repo.save(row);
    await this.writeAudit(actor, saved);
    return saved;
  }

  /** 列表（ADMIN 管理面）。 */
  list(): Promise<ImIdentity[]> {
    return this.repo.find({ order: { createdAt: "DESC" } });
  }

  /**
   * 按 (platform, imSenderId) 返回绑定关系，供后续 IM adapter 消费。
   * 本轮只提供方法，不接任何真实 Gateway / adapter。
   */
  resolveIdentity(
    platform: string,
    imSenderId: string,
  ): Promise<ImIdentity | null> {
    return this.repo.findOne({
      where: { platform: platform as ImPlatform, imSenderId },
    });
  }

  /** IM adapter 接入前的消息自检（纯规则扫描，不调 LLM）。 */
  scan(text: string): ImInjectionScanResult {
    return scanImMessage(text);
  }

  /** 审计落证（best-effort，失败只 warn，不阻断主链）。 */
  private async writeAudit(
    actor: { id: number; username: string } | undefined,
    row: ImIdentity,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        userId: actor?.id,
        username: actor?.username,
        action: "im_identity.bind",
        resource: "im_identity",
        resourceId: row.id,
        // 双字段：绑定的平台 user id + IM sender id 同进 detail。
        detail: {
          userId: row.platformUserId,
          imSenderId: row.imSenderId,
          platform: row.platform,
          projectId: row.projectId,
          projectRole: row.projectRole,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Audit write failed for ${IM_IDENTITY_BIND_ACTION}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
