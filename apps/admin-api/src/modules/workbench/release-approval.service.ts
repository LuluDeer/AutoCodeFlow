import { Inject as NestInject, Injectable, Optional } from "@nestjs/common";

// 极简框架替身（preview-validator.spec 等）只 mock 了部分装饰器，未导出 Inject；
// 缺席降级为空装饰器，保住这些既有 spec 可加载。生产 NestInject 恒在，语义不变。
const Inject: (...args: any[]) => any =
  typeof NestInject === "function" ? NestInject : () => () => undefined;

import { computeApprovalArgsDigest } from "../agent/runtime/agent-approvals.service";
import { sopContentHash, type SopFrontMatter } from "../sop/sop-frontmatter";

/**
 * ADR-045：方案卡 → 四眼审批 → 系统代理发布。
 *
 * 本文件只是**编排层**：建 sop_review 会话 → request 审批单 → consume → publish。
 * 审批单状态机（request/decide/consume/buildKey/指纹）与发布内部（校验/CAS/版本/
 * audit）逐字复用既有服务，本文件不改其任何一行，也不新增 resource 列/迁移。
 *
 * ## 依赖注入为什么是「结构面 token + 最小接口」
 * workbench ↔ agent/sop 之间存在装配期环（见 tool-binder 的 forwardRef）。若构造函数
 * 直接以对端 class 作为注入令牌并运行时 import，ESM/CJS 互转会拿到 undefined 构造器。
 * 因此这里只声明**最小端口**（本服务实际调用的那些方法），用 Symbol token 注入；
 * 主控在 module.ts 里用 `useExisting` / `useFactory` 把真服务适配到这些端口即可。
 * 所有端口 @Optional：缺席即 fail-closed（requestRelease 抛错、releaseIfApproved 返回
 * published:false），绝不退化成「跳过审批直接 publish」。
 *
 * ## 幂等
 * approvalKey = buildKey(sessionId, 'sop_publish', args) 是确定性的，但 sessionId 来自
 * 真 SessionService.create 的 UUID。为让重复申请命中同一张单，本服务：
 *   ① 进程内按 (createdBy,sopId,cardHash,contentHash,bump) 缓存 sessionId；
 *   ② 端口可选实现 findReviewSession（建议主控用 AgentSessionService.list({kind:
 *      'sop_review'}) 按 createdBy + contextJson 过滤适配），跨进程/重启复用同一会话。
 * 两者都缺席时每次新建会话——approvalKey 不同，但 request 的唯一约束仍保证不会
 * 出现「同一发布被批两次」（只是会多一张待批单，绝不放大发布权）。
 *
 * ADR-045 发布锚点持久化：args 随 sop_review 会话的 contextJson 落库；重启/多实例下
 * 进程内 argsByApprovalKey 丢失时，按 approvalKey → AgentApproval(sessionId,argsDigest)
 * → session.contextJson 重建 args，并**必须先对账 argsDigest 相等**才放行发布。
 * 任一端口缺席、字段缺失或摘要不符一律 fail-closed，不猜内容、不借审批注入。
 */

export const RELEASE_APPROVALS_PORT = Symbol("RELEASE_APPROVALS_PORT");
export const RELEASE_SESSIONS_PORT = Symbol("RELEASE_SESSIONS_PORT");
export const RELEASE_SOPS_PORT = Symbol("RELEASE_SOPS_PORT");
export const RELEASE_POLICY_PORT = Symbol("RELEASE_POLICY_PORT");

/** 与 agent.controller 四眼强化/phrase 禁用共用的契约键，不得改。 */
export const RELEASE_TOOL_NAME = "sop_publish";
/** 系统代理发布身份——不写业务人员/主管个人身份。 */
export const RELEASE_PUBLISHED_BY = "agent:tool-call";
/** session kind 已在 AGENT_SESSION_KINDS（agent-session.entity.ts:39）登记。 */
export const RELEASE_SESSION_KIND = "sop_review";
/** 审批预览 UTF-8 上限，与 tool-executor 的 APPROVAL_PREVIEW_MAX_BYTES 同值。 */
const PREVIEW_MAX_BYTES = 2048;

export interface ReleaseApprovalArgs {
  [key: string]: unknown;
  sopId: string;
  cardHash: string;
  contentHash: string;
  bump?: "patch" | "minor" | "major";
}

export interface ReleaseApprovalsPort {
  buildKey(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown> | null,
  ): string;
  request(input: {
    approvalKey: string;
    sessionId: string;
    toolName: string;
    reason: string;
    argsDigest: string;
    preview: string | null;
    policyFingerprint: string;
  }): Promise<unknown>;
  consume(
    approvalKey: string,
    currentPolicyFingerprint: string | null,
  ): Promise<boolean>;
  /** 可选：按 approvalKey 取回审批单（重启恢复 args 用）；缺席即恢复路径 fail-closed。 */
  findByKey?(approvalKey: string): Promise<{
    sessionId: string;
    argsDigest: string | null;
  } | null>;
}

export interface ReleaseSessionCreateInput {
  kind: "sop_review";
  triggerSource: string;
  title?: string;
  createdBy?: string | null;
  context?: Record<string, unknown> | null;
  scope?: Record<string, unknown> | null;
}

export interface ReleaseSessionsPort {
  create(input: ReleaseSessionCreateInput): Promise<{ id: string }>;
  /** 可选：跨进程/重启复用既有复核会话；缺席时退回进程内缓存。 */
  findReviewSession?(key: {
    createdBy: string;
    sopId: string;
    cardHash: string;
    contentHash: string;
  }): Promise<{ id: string } | null>;
  /** 可选：按 id 读回 sop_review 会话的 contextJson（重启恢复 args 用）。 */
  findById?(
    id: string,
  ): Promise<{ contextJson: Record<string, unknown> | null } | null>;
}

export interface ReleaseSopsPort {
  /** 重读工作副本（draft），用于发布前的 contentHash 锚定比对。 */
  findDraft(id: string): Promise<{
    frontMatterJson: Record<string, unknown> | null;
    bodyMarkdown: string | null;
  } | null>;
  publish(input: {
    sopId: string;
    bump?: "patch" | "minor" | "major";
    publishedBy: string;
    audit?: {
      userId?: number | null;
      username?: string | null;
      ip?: string | null;
    };
  }): Promise<unknown>;
}

/** 当前策略指纹端口：由主控用 AgentBoundaryService 的真求值适配，缺席即 fail-closed。 */
export interface ReleasePolicyPort {
  currentFingerprint(): string | null;
}

export interface RequestReleaseInput {
  sopId: string;
  cardHash: string;
  contentHash: string;
  username: string;
  bump?: "patch" | "minor" | "major";
}

export interface ReleaseIfApprovedInput {
  approvalKey: string;
  sopId: string;
  expectedContentHash: string;
  currentPolicyFingerprint: string | null;
}

export type ReleaseIfApprovedReason =
  | "dependency_unavailable"
  | "policy_fingerprint_unavailable"
  | "sop_not_found"
  | "content_changed"
  | "approval_not_consumed"
  | "publish_failed";

/** 预览信封：与 tool-executor.arg-parse.util.ts 的 previewEnvelope 同形。 */
function previewEnvelope(
  argsJson: string,
  truncated: boolean,
  omittedBytes: number,
): string {
  // mutation-residue-ok: truncated 是预览截断的事实标记，非派生字段钉常量
  return truncated
    ? JSON.stringify({ truncated: true, omittedBytes, args: argsJson }) // mutation-residue-ok: 2KB 截断为 true
    : JSON.stringify({ truncated: false, args: argsJson }); // mutation-residue-ok: 未截断为 false
}

const SECRET_KEY_RE =
  /token|secret|password|credential|authorization|api[-_]?key/i;
const REDACTED = "[REDACTED]";

/** 脱敏 + 2KB 截断的人类可读预览（本服务参数只含 hash/id，仍按统一规则处理）。 */
function buildReleasePreview(args: ReleaseApprovalArgs): string {
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEY_RE.test(k) ? REDACTED : scrub(v);
      }
      return out;
    }
    return value;
  };
  const body = JSON.stringify(scrub(args)) ?? "null";
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (
    Buffer.byteLength(previewEnvelope(body, false, 0), "utf8") <=
    PREVIEW_MAX_BYTES
  ) {
    return previewEnvelope(body, false, 0);
  }
  // 超预算：按 UTF-8 安全切点取最大可放入信封的前缀；信封会把 args 再转义一次，
  // 所以用真实信封长度判定，不用固定预留（与 buildArgsPreview 同型）。
  const hi = Math.min(bodyBytes, PREVIEW_MAX_BYTES);
  let lo = 0;
  let high = hi;
  let best = "";
  while (lo <= high) {
    const mid = (lo + high) >> 1;
    let cut = body.slice(0, mid);
    while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > mid) {
      cut = cut.slice(0, -1);
    }
    if (
      Buffer.byteLength(previewEnvelope(cut, true, bodyBytes), "utf8") <=
      PREVIEW_MAX_BYTES
    ) {
      best = cut;
      lo = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return previewEnvelope(best, true, bodyBytes);
}

@Injectable()
export class ReleaseApprovalService {
  /** 进程内幂等缓存：同一发布申请复用同一 sessionId ⇒ 同一 approvalKey。 */
  private readonly sessionByRequestKey = new Map<string, string>();
  /** ADR-045：approvalKey → 本次发布的锚定参数（系统代理发布时取回）。进程内快路径；
   *  未命中时走审批单 + 会话 contextJson 持久化恢复，并做 argsDigest 对账。 */
  private readonly argsByApprovalKey = new Map<string, ReleaseApprovalArgs>();

  constructor(
    @Optional()
    @Inject(RELEASE_APPROVALS_PORT)
    private readonly approvals: ReleaseApprovalsPort | null = null,
    @Optional()
    @Inject(RELEASE_SESSIONS_PORT)
    private readonly sessions: ReleaseSessionsPort | null = null,
    @Optional()
    @Inject(RELEASE_SOPS_PORT)
    private readonly sops: ReleaseSopsPort | null = null,
    @Optional()
    @Inject(RELEASE_POLICY_PORT)
    private readonly policy: ReleasePolicyPort | null = null,
  ) {}

  /** 建单：sop_review 会话（申请人口径 user:${username}）+ once 发布审批单。 */
  async requestRelease(
    input: RequestReleaseInput,
  ): Promise<{ approvalKey: string; sessionId: string }> {
    if (!this.approvals || !this.sessions || !this.policy) {
      throw new Error(
        "release-approval: approvals/sessions/policy 端口未装配，申请被拒绝",
      );
    }
    const createdBy = `user:${input.username}`;
    const args: ReleaseApprovalArgs = {
      sopId: input.sopId,
      cardHash: input.cardHash,
      contentHash: input.contentHash,
      ...(input.bump !== undefined ? { bump: input.bump } : {}),
    };
    const fingerprint = this.policy.currentFingerprint();
    if (!fingerprint) {
      throw new Error(
        "release-approval: 当前策略指纹不可读，发布申请被拒绝（fail-closed）",
      );
    }

    const key = JSON.stringify([
      createdBy,
      input.sopId,
      input.cardHash,
      input.contentHash,
      input.bump ?? null,
    ]);
    let sessionId = this.sessionByRequestKey.get(key);
    if (!sessionId && this.sessions.findReviewSession) {
      const found = await this.sessions.findReviewSession({
        createdBy,
        sopId: input.sopId,
        cardHash: input.cardHash,
        contentHash: input.contentHash,
      });
      if (found?.id) sessionId = found.id;
    }
    if (!sessionId) {
      const session = await this.sessions.create({
        kind: RELEASE_SESSION_KIND,
        triggerSource: "workbench.release-approval",
        createdBy,
        title: `方案卡发布复核 ${input.cardHash}`,
        scope: { sops: [input.sopId] },
        context: {
          sopId: input.sopId,
          cardHash: input.cardHash,
          contentHash: input.contentHash,
          ...(input.bump !== undefined ? { bump: input.bump } : {}),
        },
      });
      sessionId = session.id;
    }
    this.sessionByRequestKey.set(key, sessionId);

    const approvalKey = this.approvals.buildKey(
      sessionId,
      RELEASE_TOOL_NAME,
      args,
    );
    this.argsByApprovalKey.set(approvalKey, args);
    await this.approvals.request({
      approvalKey,
      sessionId,
      toolName: RELEASE_TOOL_NAME,
      reason:
        `方案卡发布四眼审批：SOP ${input.sopId}，` +
        `方案卡 ${input.cardHash}，内容 ${input.contentHash}`,
      argsDigest: computeApprovalArgsDigest(args),
      preview: buildReleasePreview(args),
      policyFingerprint: fingerprint,
    });
    return { approvalKey, sessionId };
  }

  /**
   * 从持久化的 session.contextJson 重建发布锚点；只取 requestRelease 写入的四个字段，
   * context 里的任何额外键都不参与 args/digest（防止借 context 注入）。
   */
  private rebuildArgsFromContext(
    context: Record<string, unknown>,
  ): ReleaseApprovalArgs | null {
    const { sopId, cardHash, contentHash, bump } = context;
    if (
      typeof sopId !== "string" ||
      sopId.length === 0 ||
      typeof cardHash !== "string" ||
      cardHash.length === 0 ||
      typeof contentHash !== "string" ||
      contentHash.length === 0
    ) {
      return null;
    }
    if (bump === undefined) return { sopId, cardHash, contentHash };
    if (bump !== "patch" && bump !== "minor" && bump !== "major") return null;
    return { sopId, cardHash, contentHash, bump };
  }

  /**
   * ADR-045 系统代理发布入口：主管 approve 后由审批 controller 调本方法，
   * 按 approvalKey 取回本次发布的锚定参数，再走 contentHash 比对 + consume + publish。
   * 内存命中沿用原语义；未命中时从审批单 + 会话 context 恢复，argsDigest 对账相等
   * 才放行。任何一步失败/缺席 ⇒ fail-closed，不猜内容、不抛异常给调用方。
   */
  async releaseByApprovalKey(
    approvalKey: string,
    currentPolicyFingerprint: string | null,
  ): Promise<{ published: boolean; reason?: ReleaseIfApprovedReason }> {
    const cached = this.argsByApprovalKey.get(approvalKey);
    if (cached) {
      if (!this.policy) {
        return { published: false, reason: "dependency_unavailable" };
      }
      return this.releaseIfApproved({
        approvalKey,
        sopId: cached.sopId,
        expectedContentHash: cached.contentHash,
        currentPolicyFingerprint:
          currentPolicyFingerprint ?? this.policy.currentFingerprint(),
      });
    }

    try {
      if (
        !this.approvals?.findByKey ||
        !this.sessions?.findById ||
        !this.policy
      ) {
        return { published: false, reason: "dependency_unavailable" };
      }
      const approval = await this.approvals.findByKey(approvalKey);
      if (!approval?.sessionId || !approval.argsDigest) {
        return { published: false, reason: "dependency_unavailable" };
      }
      const session = await this.sessions.findById(approval.sessionId);
      const context = session?.contextJson;
      if (!context || typeof context !== "object" || Array.isArray(context)) {
        return { published: false, reason: "dependency_unavailable" };
      }
      const args = this.rebuildArgsFromContext(context);
      if (!args) {
        return { published: false, reason: "dependency_unavailable" };
      }
      // 安全闸：context 可被越权改写，digest 必须与审批时落库的值逐字相等。
      if (computeApprovalArgsDigest(args) !== approval.argsDigest) {
        return { published: false, reason: "dependency_unavailable" };
      }
      return this.releaseIfApproved({
        approvalKey,
        sopId: args.sopId,
        expectedContentHash: args.contentHash,
        currentPolicyFingerprint:
          currentPolicyFingerprint ?? this.policy.currentFingerprint(),
      });
    } catch {
      return { published: false, reason: "dependency_unavailable" };
    }
  }

  /**
   * 消耗发布：先重读 draft 锚定内容，再 consume，最后系统代理 publish。
   * 任一步失败/缺席一律 fail-closed，不调用 publish。
   */
  async releaseIfApproved(
    input: ReleaseIfApprovedInput,
  ): Promise<{ published: boolean; reason?: ReleaseIfApprovedReason }> {
    if (!this.approvals || !this.sops) {
      return { published: false, reason: "dependency_unavailable" };
    }
    if (!input.currentPolicyFingerprint) {
      return { published: false, reason: "policy_fingerprint_unavailable" };
    }
    try {
      // 内容锚定必须在 consume 之前：主管批后业务人员改 draft ⇒ 不发布。
      const draft = await this.sops.findDraft(input.sopId);
      if (!draft) return { published: false, reason: "sop_not_found" };
      if (!draft.frontMatterJson || draft.bodyMarkdown == null) {
        return { published: false, reason: "content_changed" };
      }
      const currentHash = sopContentHash(
        draft.frontMatterJson as unknown as SopFrontMatter,
        draft.bodyMarkdown,
      );
      if (currentHash !== input.expectedContentHash) {
        return { published: false, reason: "content_changed" };
      }

      // consume 的 WHERE 含 policyFingerprint：非 pending / 自批 / 指纹变更 / 已消费
      // 全部命中 0 行，返回 false。service 不碰 decide，不自行判自批（由 controller 挡）。
      const consumed = await this.approvals.consume(
        input.approvalKey,
        input.currentPolicyFingerprint,
      );
      if (!consumed) {
        return { published: false, reason: "approval_not_consumed" };
      }

      await this.sops.publish({
        sopId: input.sopId,
        publishedBy: RELEASE_PUBLISHED_BY,
        audit: {
          userId: null,
          username: RELEASE_PUBLISHED_BY,
          ip: null,
        },
      });
      return { published: true };
    } catch {
      return { published: false, reason: "publish_failed" };
    }
  }
}
