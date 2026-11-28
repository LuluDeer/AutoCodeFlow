/**
 * 切片 E1：工作台会话 → SOP 管线直连（「审批 → SOP 化执行」的最后一跳）。
 *
 * 语义：把一个 **commit 锚定的工作台会话**（createSession 写入
 * context.goal / sopId / cardHash 的 sop_authoring 会话）转写为一份
 * **业务人自己名下的新 SOP 草稿**：
 *   · slug 由 goal 归一化生成（冲突自动 -2/-3…，绝不覆盖既有 SOP）；
 *   · title = 方案卡标题（服务端按 goal/cadence/params 确定性重建，防篡改）；
 *   · bodyMarkdown = goal + cadence + 会话步骤序列 + acceptance 文案；
 *   · front-matter 沿用 buildDraftPayloadFromCard 的草稿档契约
 *     （capabilities 白名单内 + platform/task_status 占位验收）。
 *
 * ## 校验链（任一不达即 409/404，绝不静默降级）
 *   ① 会话存在 + 归属（USER 仅本人，ADMIN 任意）→ 否则 404（防枚举同码）；
 *   ② commit 已成功：contextJson 携带 goal + sopId + cardHash 三锚点；
 *   ③ 卡未漂移：按入参重建 cardHash 必须与 context 锚点一致；
 *   ④ 审批已 consumed：该 sop 的 sop_publish 审批单（sop_review 会话上）
 *      status === "consumed"（主管批准 + 系统代理执行均已完成）。
 *
 * ## 硬边界
 *   · **绝不调用 publish**——转换只产 draft；发布仍走人工闸（publish 端点）。
 *   · **不修改 commit 落库的原 workbench-<hash> 草稿**——那份行的生命周期
 *     归 ADR-045 发布链管；转换产出的是一份全新的用户草稿。
 *   · 与 SOP 管线复用同一入口：sops.draft（POST /api/sop 同源），草稿档
 *     校验（strict:false）逐字复用，不新开旁路。
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional as NestOptional,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";

import { normalizeSopSlug } from "../ai/ai-json";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { UserRole } from "../users/entities/user.entity";
import { SopService } from "../sop/sop.service";
import { AgentSessionService } from "../agent/runtime/agent-session.service";
import { AgentApprovalsService } from "../agent/runtime/agent-approvals.service";
import { AuditService } from "../audit/audit.service";
import {
  buildDraftPayloadFromCard,
  rebuildCardFromInput,
} from "./preview-validator";
import type {
  WorkbenchConvertSessionInput,
  WorkbenchConvertSessionResult,
} from "./workbench-convert.port";

/** 极简框架替身可能缺 Optional/Inject 装饰器；缺席降级 no-op。 */
const Optional: (...args: any[]) => any =
  typeof NestOptional === "function" ? NestOptional : () => () => undefined;
const InjectDecorator: (...args: any[]) => any =
  typeof Inject === "function" ? Inject : () => () => undefined;

/** slug 冲突消解的最大尝试次数（base-2 … base-50；再多即视为参数异常）。 */
const SLUG_MAX_SUFFIX = 50;

/** body 内步骤列表的收录上限：会话步骤可能很长，草稿正文只收录前 N 条。 */
const BODY_STEPS_MAX = 20;

/** 单条步骤正文在草稿中的截断长度（完整正文仍留在会话时间线里）。 */
const BODY_STEP_CLIP = 200;

export type {
  WorkbenchConvertSessionInput,
  WorkbenchConvertSessionResult,
} from "./workbench-convert.port";

@Injectable()
export class ConvertToSopService {
  private readonly logger = new Logger(ConvertToSopService.name);

  constructor(
    private readonly sops: SopService,
    // ModuleRef 惰性解析 AgentSessionService / AgentApprovalsService /
    // AuditService（与 workbench.module 的 RELEASE_* 端口同一时机纪律：
    // 模块实例化期 provider 可能还是空壳，调用时才 get）。
    @Optional()
    @InjectDecorator(ModuleRef)
    private readonly moduleRef?: ModuleRef | null,
  ) {}

  private sessionsRef(): AgentSessionService | null {
    try {
      return (
        this.moduleRef?.get(AgentSessionService, { strict: false }) ?? null
      );
    } catch {
      return null;
    }
  }

  private approvalsRef(): AgentApprovalsService | null {
    try {
      return (
        this.moduleRef?.get(AgentApprovalsService, { strict: false }) ?? null
      );
    } catch {
      return null;
    }
  }

  private auditRef(): AuditService | null {
    try {
      return this.moduleRef?.get(AuditService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  /** 测试/极简装配缺口统一 fail-closed：端口缺席即 503，绝不半执行。 */
  private requireSessions(): AgentSessionService {
    const ref = this.sessionsRef();
    if (!ref) throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    return ref;
  }

  private requireApprovals(): AgentApprovalsService {
    const ref = this.approvalsRef();
    if (!ref) throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    return ref;
  }

  /**
   * slug 是否已被占用。SopService.getBySlug 是既有公共读面（不存在抛
   * SOP_NOT_FOUND），这里借它做存在性判定，不在 sop 模块加新查询面。
   */
  private async slugExists(slug: string): Promise<boolean> {
    try {
      await this.sops.getBySlug(slug);
      return true;
    } catch (err: unknown) {
      // ⚠️ 不能用 `err instanceof AppError`：AppError 构造时会按状态码
      // setPrototypeOf 到 NestJS 内置异常类（NotFoundException 等），
      // instanceof AppError 恒为 false（app-error.ts 顶部注释的既有坑）。
      // 这里按 errorCode 字段做鸭子判定。
      const code = (err as { errorCode?: unknown } | null)?.errorCode;
      if (code === ErrorCode.SOP_NOT_FOUND) {
        return false;
      }
      throw err;
    }
  }

  /**
   * 会话步骤 → 有序列表片段（收录前 BODY_STEPS_MAX 条、单条截断）。
   * 步骤缺省（尚未开始运行）不阻断转换——正文里如实留一行占位说明。
   */
  private buildStepsSection(
    steps: Array<{ seq: number; role: string; content?: string | null }>,
  ): string {
    const usable = steps
      .filter(
        (s) => typeof s.content === "string" && s.content.trim().length > 0,
      )
      .slice(0, BODY_STEPS_MAX);
    if (usable.length === 0) {
      return "（本次会话尚无可收录的步骤记录；请结合时间线补齐步骤后发布）";
    }
    return usable
      .map(
        (s, i) =>
          `${i + 1}. [step ${s.seq} · ${s.role}] ${String(s.content).slice(0, BODY_STEP_CLIP).trim()}`,
      )
      .join("\n");
  }

  /** 主转换流程。所有闸门 fail-closed；成功只产 draft，绝不发布。 */
  async convert(
    input: WorkbenchConvertSessionInput,
  ): Promise<WorkbenchConvertSessionResult> {
    const sessions = this.requireSessions();
    const approvals = this.requireApprovals();

    // ① 会话存在 + 归属（防枚举：不存在与越权统一 404，与交互面 assertOwner 同码）。
    const session = await sessions.findById(input.sessionId);
    const userId = Number(input.user?.id);
    if (!session) {
      throw new AppError("AGENT_SESSION_NOT_FOUND", {
        sessionId: input.sessionId,
      });
    }
    const identities = [
      Number.isFinite(userId) ? `user:${userId}` : null,
      input.user?.username ? `user:${input.user.username}` : null,
    ].filter((value): value is string => value !== null);
    const isAdmin =
      (input.user as { role?: string } | undefined)?.role === UserRole.ADMIN;
    if (
      !isAdmin &&
      (!session.createdBy || !identities.includes(session.createdBy))
    ) {
      throw new AppError("AGENT_SESSION_NOT_FOUND", {
        sessionId: input.sessionId,
      });
    }

    // ② commit 已成功：contextJson 携带三锚点（createSession 在 commit 成功后写入）。
    const context = (session.contextJson ?? {}) as Record<string, unknown>;
    const goal = String(context.goal ?? "").trim();
    const sourceSopId = String(context.sopId ?? "");
    const cardHash = String(context.cardHash ?? "").toLowerCase();
    if (!goal || !sourceSopId || !/^[0-9a-f]{16}$/.test(cardHash)) {
      throw new AppError("WORKBENCH_CONVERT_NO_COMMIT", {
        sessionId: input.sessionId,
      });
    }

    // ③ 卡未漂移：入参重建 hash 必须与会话锚点一致（客户端声称的任何 hash 不参与判定）。
    const rebuilt = rebuildCardFromInput({
      goal,
      cadence: input.cadence,
      params: input.params,
    });
    if (rebuilt.cardHash !== cardHash) {
      throw new AppError("WORKBENCH_CONVERT_CARD_DRIFT", {
        sessionId: input.sessionId,
      });
    }

    // ④ 审批已 consumed：定位该 sop 的 sop_review 会话 → 其 sop_publish 审批单
    //    必须 status === "consumed"（pending/granted/denied/expired 一律不算）。
    const review = await this.findReviewSessionBySop(sessions, sourceSopId);
    if (!review) {
      throw new AppError("WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED", {
        sessionId: input.sessionId,
        sopId: sourceSopId,
      });
    }
    const approvalRows = await approvals.listForSession(review.id);
    const consumed = approvalRows.some(
      (row) =>
        row.toolName === "sop_publish" &&
        row.status === "consumed" &&
        row.scope === "once",
    );
    if (!consumed) {
      throw new AppError("WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED", {
        sessionId: input.sessionId,
        sopId: sourceSopId,
      });
    }

    // ⑤ 源 SOP 存在性：commit 落库的行被删除/不存在即拒绝（404 走 SOP_NOT_FOUND 既有码）。
    const sourceSop = await this.sops.getSop(sourceSopId);

    // ⑥ slug：goal 归一化（复用 ai-json.normalizeSopSlug——与 SOP slug 校验正则
    //    ^[a-z0-9][a-z0-9-]{0,127}$ 同契约）；纯中文 goal 得空串时回落 cardHash 前缀。
    const base = normalizeSopSlug(goal) || `workbench-${cardHash.slice(0, 8)}`;
    let slug = base;
    for (let suffix = 2; await this.slugExists(slug); suffix += 1) {
      if (suffix > SLUG_MAX_SUFFIX) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: `goal 归一化 slug「${base}」的冲突后缀已用尽（-${SLUG_MAX_SUFFIX}），请调整 goal 后重试`,
        });
      }
      slug = `${base}-${suffix}`;
    }

    // ⑦ 映射：front-matter 沿用 buildDraftPayloadFromCard 的草稿档契约
    //    （capabilities 白名单过滤 + platform/task_status 占位验收，strict:false 校验在
    //    该函数内部完成）；正文按任务规格 = goal + cadence + steps + acceptance。
    const payload = buildDraftPayloadFromCard(rebuilt.card, rebuilt.cardHash);
    const bodyMarkdown = [
      `# ${payload.title}`,
      "",
      "## 目标",
      goal,
      "",
      "## 触发",
      `${rebuilt.card.triggerText}（cadence: ${input.cadence}）`,
      "",
      "## 步骤",
      this.buildStepsSection(
        await this.readSessionSteps(sessions, input.sessionId),
      ),
      "",
      "## 目标与验收",
      rebuilt.card.acceptanceText,
      "",
      "## 预算",
      `最大轮次：${rebuilt.card.budget.maxTurns}`,
      "",
      "## 方案卡留痕",
      `cardHash: ${rebuilt.cardHash}`,
      `sourceSop: ${sourceSop.slug}（commit 落库的 ${sourceSopId}）`,
      `workbenchSession: ${input.sessionId}`,
      "",
      "> 本草稿由工作台会话 convert-to-sop 生成，尚未发布；发布与指派仍需管理员在 SOP 页完成。",
    ].join("\n");

    // ⑧ 草稿落库：与 POST /api/sop 完全同源（同一 draft 方法、同一校验、同一审计）。
    //    归属当前用户；绝不调 publish——status 恒为 draft。
    const saved = await this.sops.draft({
      slug,
      title: payload.title,
      frontMatterYaml: payload.frontMatterYaml,
      bodyMarkdown,
      applicationId: null,
      createdBy: `user:${userId}`,
      audit: {
        userId: Number.isFinite(userId) ? userId : null,
        username: input.user?.username ?? null,
        ip: input.ip ?? null,
      },
    });

    // ⑨ 转换留痕（旁路纪律：审计失败只 warn，绝不把一次已成功的转换升级成 5xx）。
    try {
      await this.auditRef()?.log({
        action: "workbench.convert_to_sop",
        resource: "workbench",
        resourceId: saved.id,
        userId: Number.isFinite(userId) ? userId : undefined,
        username: input.user?.username,
        ip: input.ip ?? undefined,
        result: "success",
        detail: {
          sessionId: input.sessionId,
          sourceSopId,
          sourceSopSlug: sourceSop.slug,
          slug: saved.slug,
          cardHash: rebuilt.cardHash,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `workbench.convert_to_sop audit skipped (bypass): sopId=${saved.id} — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(
      JSON.stringify({
        event: "workbench.convert_to_sop",
        sessionId: input.sessionId,
        sourceSopId,
        slug: saved.slug,
        sopId: saved.id,
      }),
    );

    return {
      slug: saved.slug,
      sopId: saved.id,
      status: "draft",
      published: false,
      // SopsPage 现行深链契约是 ?sop=<id>（resolveSopDeepLink 只解析 sop 参数）。
      deeplink: `/sops?sop=${encodeURIComponent(String(saved.id))}`,
    };
  }

  /** 在 sop_review 会话中定位该 sop 的发布复核会话（contextJson.sopId 匹配）。 */
  private async findReviewSessionBySop(
    sessions: AgentSessionService,
    sopId: string,
  ): Promise<{ id: string } | null> {
    const page = await sessions.list({
      kind: "sop_review",
      page: 1,
      pageSize: 100,
    });
    const hit = page.items.find(
      (row) =>
        row.contextJson &&
        typeof row.contextJson === "object" &&
        !Array.isArray(row.contextJson) &&
        String((row.contextJson as Record<string, unknown>).sopId ?? "") ===
          sopId,
    );
    return hit ? { id: hit.id } : null;
  }

  /** 读会话步骤（转换正文用）；读取失败不阻断转换（正文留占位说明）。 */
  private async readSessionSteps(
    sessions: AgentSessionService,
    sessionId: string,
  ): Promise<Array<{ seq: number; role: string; content?: string | null }>> {
    try {
      return await sessions.listSteps(sessionId);
    } catch (err: unknown) {
      this.logger.warn(
        `readSessionSteps failed (bypass): sessionId=${sessionId} — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
