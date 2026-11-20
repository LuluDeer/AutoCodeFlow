/**
 * R289 · SOP 单条指派处置服务（从「可见」推进到「可处置」）。
 *
 * ## 为什么独立建服务而不挂进 `SopService`
 *
 * ① `sop.service.ts` 在 `check:size-caps` 基线上已顶格（1708/1708），新增方法必破顶；
 * ② 职责单一：专注管理面对单条 `SopAssignment` 的显式人工处置（与 R280
 *    `SopClarificationInboxService`、R286 `SopAssignmentLagService` 同款外提模式）。
 *
 * ## 状态机与并发纪律（ADR-026）
 *
 * - 可取消前置状态集合与 `SopService.cancelOpenAssignments` / `deprecate` 逐字对齐：
 *   `assigned | in_progress | blocked | stalled`（全部 4 个非终态）。
 * - 终态（`completed | failed | cancelled`）或并发 CAS 败北后重读确认已终态，统一抛
 *   既有 `AppError(ErrorCode.SOP_ASSIGNMENT_TERMINAL, { status })`（HTTP 400），
 *   绝不覆写终态、绝不伪造成功、绝不落审计。
 * - 只写 `status: "cancelled"` 一列（禁用 `.save()` 整行回写），保留 `resultJson` /
 *   `progressJson` 与澄清历史完整可追溯。
 * - 审计复用既有 `action: "sop.assignment.cancel"`（`resource: "sop_assignment"` +
 *   `detail.sopId` 兼容审计页深链 `/sops?sop=<sopId>`），非空 `reason` 必经共享
 *   `sanitizeSecrets` 脱敏后再入 `detail.reason` + `detail.reasonLength`。
 */
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { sanitizeSecrets } from "../../common/utils/sanitize-secrets.util";
import { AuditService } from "../audit/audit.service";
import {
  SopAssignment,
  SopAssignmentStatus,
} from "./entities/sop-assignment.entity";
import type { SopAuditContext } from "./sop.service";
import {
  CANCEL_ASSIGNMENT_REASON_MAX_LENGTH,
  SopCancelAssignmentResponseDto,
} from "./sop-assignment-actions.dto";

/** 允许单条取消的前置状态（全部非终态，与 `cancelOpenAssignments` / `deprecate` 一致）。 */
export const CANCELLABLE_ASSIGNMENT_STATUSES: readonly SopAssignmentStatus[] = [
  "assigned",
  "in_progress",
  "blocked",
  "stalled",
] as const;

export interface CancelSingleAssignmentInput {
  assignmentId: string;
  reason?: string;
  actor?: string;
  audit?: SopAuditContext;
}

@Injectable()
export class SopAssignmentActionsService {
  private readonly logger = new Logger(SopAssignmentActionsService.name);

  constructor(
    @Optional()
    @InjectRepository(SopAssignment)
    private readonly assignments?: Repository<SopAssignment> | null,
    @Optional()
    @Inject(AuditService)
    private readonly auditService?: AuditService,
  ) {}

  /**
   * 取消单条未结束的 SOP 指派（ADR-026 条件写）。
   *
   * 取消后该指派将自动从 `GET /sop/assignments/lagging`（`status = 'blocked'`）
   * 与 `GET /sop/clarifications/pending`（`status NOT IN ('completed','cancelled')`）
   * 两个收件箱读面消失；执行器后续 `poll` 不再下发该单、`progress` 收 400、
   * `complete` 收 `{ accepted: false }`。
   */
  async cancelAssignment(
    input: CancelSingleAssignmentInput,
  ): Promise<SopCancelAssignmentResponseDto> {
    this.requireWiring();

    const existing = await this.assignments.findOne({
      where: { id: input.assignmentId },
    });
    if (!existing) {
      throw new AppError(ErrorCode.SOP_ASSIGNMENT_NOT_FOUND, {
        assignmentId: input.assignmentId,
      });
    }

    if (!CANCELLABLE_ASSIGNMENT_STATUSES.includes(existing.status)) {
      throw new AppError(ErrorCode.SOP_ASSIGNMENT_TERMINAL, {
        status: existing.status,
      });
    }

    const previousStatus = existing.status;
    // ADR-026 条件写：只匹配非终态四态，且只更新 status 一列（保留 resultJson 等历史）。
    const updated = await this.assignments.update(
      {
        id: existing.id,
        status: In([...CANCELLABLE_ASSIGNMENT_STATUSES]),
      },
      { status: "cancelled" },
    );

    if (updated.affected !== 1) {
      const fresh = await this.assignments.findOne({
        where: { id: existing.id },
      });
      if (!fresh) {
        throw new AppError(ErrorCode.SOP_ASSIGNMENT_NOT_FOUND, {
          assignmentId: input.assignmentId,
        });
      }
      this.logger.warn(
        `SOP assignment cancel lost the race: id=${existing.id} snapshot=${previousStatus} current=${fresh.status}`,
      );
      throw new AppError(ErrorCode.SOP_ASSIGNMENT_TERMINAL, {
        status: fresh.status,
      });
    }

    // 读回落库后的最新快照（拿到真实 DB updatedAt，避免返回陈旧快照）。
    const saved =
      (await this.assignments.findOne({ where: { id: existing.id } })) ??
      ({ ...existing, status: "cancelled" } as SopAssignment);

    const trimmedReason =
      typeof input.reason === "string" ? input.reason.trim() : "";
    const sanitizedReason =
      trimmedReason.length > 0
        ? sanitizeSecrets(trimmedReason, {
            maxLength: CANCEL_ASSIGNMENT_REASON_MAX_LENGTH,
          })
        : null;

    await this.safeAudit({
      userId: input.audit?.userId ?? null,
      username: input.audit?.username ?? null,
      ip: input.audit?.ip ?? null,
      action: "sop.assignment.cancel",
      resource: "sop_assignment",
      resourceId: existing.id,
      detail: {
        sopId: existing.sopId,
        sopVersion: existing.sopVersion,
        executorId: existing.targetExecutorId,
        from: previousStatus,
        to: "cancelled",
        scope: "single",
        ...(sanitizedReason !== null
          ? {
              reason: sanitizedReason,
              reasonLength: trimmedReason.length,
            }
          : {}),
        actor: input.actor ?? null,
      },
    });

    this.logger.log(
      `SOP assignment cancelled: id=${existing.id} sopId=${existing.sopId} from=${previousStatus} by=${input.actor ?? "?"}`,
    );

    return {
      assignment: saved,
      previousStatus,
    };
  }

  private requireWiring(): void {
    if (!this.assignments) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
  }

  /** fail-open 审计落库：不阻断主流程，但失败必须 `logger.error` 留痕。 */
  private async safeAudit(
    payload: Parameters<AuditService["log"]>[0],
  ): Promise<void> {
    if (!this.auditService) return;
    try {
      await this.auditService.log(payload);
    } catch (err) {
      this.logger.error(
        "sop assignment cancel audit write failed: resourceId=" +
          (payload.resourceId ?? "-") +
          " err=" +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
