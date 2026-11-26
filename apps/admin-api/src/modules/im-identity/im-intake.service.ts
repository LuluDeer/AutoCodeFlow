import { Injectable } from "@nestjs/common";

import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { ProjectAccessService } from "../project/project-access.service";
import {
  buildPreview,
  computePolicyGeneration,
  currentPolicySnapshot,
} from "../workbench/preview-validator";
import type { ImIntakeDto, ImIntakeResultDto } from "./dto/im-intake.dto";
import { ImIdentityService } from "./im-identity.service";
import { scanImMessage, type ImInjectionScanResult } from "./injection-guard";

/**
 * N6 · IM 一等入口 Intake 编排核心。
 *
 * 一条已验签的 IM 消息 → 注入扫描 → 身份解析与绑定校验 → ProjectRole 校验 →
 * 生成方案卡预览（或 fail-closed 拒绝）。四步顺序固定，任一步失败立即抛
 * AppError，不进入后续、不部分执行、不落 SOP / activation（提交仍走 workbench）。
 *
 * 纯编排：注入扫描与方案卡复用现有确定性纯函数（scanImMessage / buildPreview），
 * 身份与角色走既有 service 注入。跨模块只 import workbench 的纯函数文件，
 * 不 import WorkbenchModule（workbench 不反向依赖 im-identity，无循环）。
 */
@Injectable()
export class ImIntakeService {
  constructor(
    private readonly imIdentity: ImIdentityService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async intake(dto: ImIntakeDto): Promise<ImIntakeResultDto> {
    // ── 1. 注入扫描：CRITICAL 命中即拒绝，且不进入身份解析 ──────────────
    const scan: ImInjectionScanResult = scanImMessage(dto.message);
    if (!scan.safe) {
      const rules = scan.findings
        .filter((f) => f.severity === "CRITICAL")
        .map((f) => `${f.rule}（${f.evidence}）`)
        .join("、");
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: `IM 消息命中注入防护规则，已拒绝入站：${rules || "存在 CRITICAL 命中"}`,
      });
    }

    // ── 2. 身份解析与绑定校验：无绑定 / 未验签 / 未分配 user 一律拒绝 ──
    const identity = await this.imIdentity.resolveIdentity(
      dto.platform,
      dto.imSenderId,
    );
    if (
      !identity ||
      identity.verified !== true ||
      identity.platformUserId == null
    ) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail:
          "IM 发送方未绑定平台用户或验签未通过，禁止生成方案卡（请先完成 verify-bind）",
      });
    }

    // ── 3. ProjectRole 校验：项目级绑定需 ≥viewer；平台级绑定（projectId=null）跳过 ──
    if (identity.projectId != null) {
      const allowed = await this.projectAccess.hasProjectRole(
        identity.platformUserId,
        identity.projectId,
        "viewer",
      );
      if (!allowed) {
        throw new AppError(ErrorCode.PROJECT_ACCESS_DENIED, {
          detail: `IM 绑定用户 ${identity.platformUserId} 在项目 ${identity.projectId} 上不具备 viewer 角色，禁止生成方案卡`,
        });
      }
    }

    // ── 4. 生成方案卡预览：message 作为 goal 直接复用 workbench 纯函数 ──
    const preview = buildPreview({ goal: dto.message, cadence: dto.cadence });
    return {
      checks: preview.checks,
      card: preview.card,
      eligible: preview.eligible,
      cardHash: preview.cardHash,
      policyGeneration: computePolicyGeneration(currentPolicySnapshot()),
      identity: {
        platformUserId: identity.platformUserId,
        projectId: identity.projectId,
        projectRole: identity.projectRole,
      },
      scan: { safe: scan.safe, findings: scan.findings },
    };
  }
}
