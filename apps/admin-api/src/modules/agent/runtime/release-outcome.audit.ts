/**
 * ADR-045 发布结果可见性（第 72 轮）：把「主管批准后系统代理发布」的结果从
 * warn-only 升级为可审计、可诊断、可重试。
 *
 * 本模块刻意做成零 Nest DI 的纯逻辑：controller 只把 ModuleRef / logger /
 * 申请快照传进来，实际的 ReleaseApprovalService / AuditService 全部惰性解析，
 * 与既有 `decideApproval` 的 DI 环规避口径一致。审计写入是旁路：失败只 warn，
 * 绝不回滚已经条件写成 granted 的审批单。
 */
import type { ModuleRef } from "@nestjs/core";

import { AuditService } from "../../audit/audit.service";
import {
  RELEASE_PUBLISHED_BY,
  RELEASE_TOOL_NAME,
  ReleaseApprovalService,
} from "../../workbench/release-approval.service";

export const SOP_RELEASE_AUDIT_ACTIONS = {
  failed: "sop_publish.release_failed",
  succeeded: "sop_publish.release_succeeded",
} as const;

/** 失败时的显式重试入口；不新增 HTTP 端点，也不把发布权交还业务人员。 */
export const SOP_RELEASE_RETRY_HINT =
  "重试方式：主管在收件箱对该 SOP 重新提交发布审批";

export interface ReleaseAuditLogger {
  warn(message: string): void;
}

type ReleaseOutcome = Awaited<
  ReturnType<ReleaseApprovalService["releaseByApprovalKey"]>
>;

interface ReleaseAuditPayload {
  action: string;
  resource: string;
  resourceId: string;
  result: "success" | "failure";
  detail: Record<string, unknown>;
}

function resolveAudit(
  moduleRef: ModuleRef | null | undefined,
  logger: ReleaseAuditLogger,
): AuditService | null {
  try {
    const audit = moduleRef?.get(AuditService, { strict: false }) ?? null;
    if (!audit) {
      logger.warn("sop_publish audit skipped: AuditService unavailable");
    }
    return audit;
  } catch (err: unknown) {
    logger.warn(
      `sop_publish audit resolve failed — ${err instanceof Error ? err.name : "unknown"}`,
    );
    return null;
  }
}

/**
 * fire-and-forget，但把 rejection 显式收口：审计落库失败只 warn，
 * 绝不把一次已经成功的人工批准变成 5xx。
 */
function writeAudit(
  audit: AuditService,
  logger: ReleaseAuditLogger,
  payload: ReleaseAuditPayload,
): void {
  try {
    void Promise.resolve(audit.log(payload)).catch((err: unknown) => {
      logger.warn(
        `sop_publish audit append failed: ${payload.action} — ` +
          `${err instanceof Error ? err.name : "unknown"}`,
      );
    });
  } catch (err: unknown) {
    logger.warn(
      `sop_publish audit append failed: ${payload.action} — ` +
        `${err instanceof Error ? err.name : "unknown"}`,
    );
  }
}

/**
 * 发布结果审计入口。只有 `granted` + `sop_publish` 会触发；其它 decision /
 * toolName 直接返回，不解析依赖、不写审计，保证非发布审批零回归。
 *
 * @returns 永不抛；发布失败与抛错都只落审计 + warn，批准语义保持不变。
 */
export async function auditReleaseOutcome(
  moduleRef: ModuleRef | null | undefined,
  logger: ReleaseAuditLogger,
  sessionId: string,
  approvalKey: string,
  decision: "granted" | "denied",
  toolName: string,
  decidedBy: string,
): Promise<void> {
  if (decision !== "granted" || toolName !== RELEASE_TOOL_NAME) return;

  let outcome: ReleaseOutcome | undefined;
  let threw = false;
  try {
    const release = moduleRef?.get(ReleaseApprovalService, { strict: false });
    outcome = await release?.releaseByApprovalKey(approvalKey, null);
  } catch (err: unknown) {
    threw = true;
    // 原有 warn 保留给日志排障；审计 detail 刻意不带异常文案（可能含密钥）。
    logger.warn(`系统代理发布异常：${approvalKey} ${String(err)}`);
  }

  const audit = resolveAudit(moduleRef, logger);
  if (!audit) return;

  if (outcome?.published === true) {
    writeAudit(audit, logger, {
      action: SOP_RELEASE_AUDIT_ACTIONS.succeeded,
      resource: "agent_approval",
      resourceId: approvalKey,
      result: "success",
      detail: {
        approvalKey,
        sessionId,
        decidedBy,
        toolName: RELEASE_TOOL_NAME,
        published: true,
        publishedBy: RELEASE_PUBLISHED_BY,
      },
    });
    return;
  }

  // 依赖缺席 / 抛错 / reason 缺失都收敛成可枚举 reason；exception 消息不进审计。
  const reason =
    outcome?.reason ?? (threw ? "publish_failed" : "dependency_unavailable");
  logger.warn(`系统代理发布未执行：${approvalKey} ${reason}`);
  writeAudit(audit, logger, {
    action: SOP_RELEASE_AUDIT_ACTIONS.failed,
    resource: "agent_approval",
    resourceId: approvalKey,
    result: "failure",
    detail: {
      approvalKey,
      sessionId,
      decidedBy,
      toolName: RELEASE_TOOL_NAME,
      published: false,
      reason,
      retry: SOP_RELEASE_RETRY_HINT,
    },
  });
}
