import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "node:crypto";
import { Repository } from "typeorm";
import { AppError } from "../../../common/errors/app-error";
import {
  AgentApproval,
  type AgentApprovalStatus,
} from "../entities/agent-approval.entity";

/**
 * A1 审批闭环（实施轮 #12 → 执行侧闭环 #14）：审批单的落库、状态翻转与领取。
 *
 * 状态迁移：pending → granted / pending → denied（人工处置，条件写）；
 * granted → consumed（执行体在副作用之前**原子领取**，一张单只能用一次）。
 * 写路径统一走**条件 UPDATE**（ADR-026 规则 4）：两个管理员同时点批准、或批准
 * 与拒绝撞在同一张单上时，命中 0 行的一方拿到 APPROVAL_ALREADY_DECIDED——
 * 审批单的结论只能有一个，先到者赢。
 */
@Injectable()
export class AgentApprovalsService {
  constructor(
    @InjectRepository(AgentApproval)
    private readonly approvals: Repository<AgentApproval>,
  ) {}

  /**
   * 申请键的**确定性**构造（实施轮 #14）。
   *
   * 键 = `apr-<sessionId>-<sha256(toolName|规范化参数) 前 16 位>`。同一会话里
   * 「同一工具 + 同一参数」的重试必须命中同一行（幂等），否则：
   *   · 模型每重试一次就多一张 pending 单（运营看板只增不减）；
   *   · 管理员批准的那张与模型正在等的调用不是同一行，「批准后重放即执行」
   *     这条链根本接不上。
   *
   * 参数规范化：对象按键名排序递归序列化，数组保持顺序（顺序是语义），
   * undefined 掉键（JSON 语义一致）。同一逻辑参数的不同书写（键序不同）
   * 得到同一键。
   */
  buildKey(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown> | null,
  ): string {
    const digest = createHash("sha256")
      .update(`${toolName}|${canonicalJson(args)}`)
      .digest("hex")
      .slice(0, 16);
    return `apr-${sessionId}-${digest}`;
  }

  /** 申请落库。approvalKey 唯一约束保证重试不产生第二张单（幂等）。 */
  async request(input: {
    approvalKey: string;
    sessionId: string;
    toolName: string;
    reason: string;
  }): Promise<AgentApproval> {
    const row = this.approvals.create({
      approvalKey: input.approvalKey,
      sessionId: input.sessionId,
      toolName: input.toolName,
      reason: input.reason,
      status: "pending",
    });
    try {
      return await this.approvals.save(row);
    } catch (err: unknown) {
      // 唯一约束冲突 = 同一 approvalKey 已申请过（重试/重放）：返回既有单，
      // 让幂等语义对调用方透明。
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        const existing = await this.approvals.findOne({
          where: { approvalKey: input.approvalKey },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  async findByKey(approvalKey: string): Promise<AgentApproval | null> {
    return this.approvals.findOne({ where: { approvalKey } });
  }

  async listForSession(sessionId: string): Promise<AgentApproval[]> {
    return this.approvals.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 处置（批准/拒绝）。条件写钉住 status='pending'——终态竞争由数据库行锁
   * 仲裁，撞上的调用方收 APPROVAL_ALREADY_DECIDED（409）。
   * 返回 null = 单不存在；返回行 = 本次调用完成了处置。
   *
   * 谓词必须是 `status = 'pending'`（而不是「非 granted/denied」）：新增
   * `consumed` 后，否定式谓词会把**已执行过**的单重新翻回 granted，等于给
   * 一次副作用发第二张通行证。
   */
  async decide(
    approvalKey: string,
    decision: Exclude<AgentApprovalStatus, "pending">,
    decidedBy: string,
  ): Promise<AgentApproval | null> {
    const updated = await this.approvals.update(
      { approvalKey, status: "pending" },
      { status: decision, decidedBy, decidedAt: new Date() },
    );
    if (!updated.affected) {
      const row = await this.findByKey(approvalKey);
      if (!row) return null;
      throw new AppError("AGENT_APPROVAL_ALREADY_DECIDED", {
        approvalKey,
        status: row.status,
      });
    }
    const row = await this.findByKey(approvalKey);
    if (!row) return null;
    return row;
  }

  /** 会话还有没有未处置的审批单（resume 前置校验用）。 */
  async hasPendingForSession(sessionId: string): Promise<boolean> {
    const pending = await this.approvals.find({
      where: { sessionId, status: "pending" },
      take: 1,
    });
    return pending.length > 0;
  }

  /**
   * **领取**一张已批准的审批单（granted → consumed，条件写）。
   *
   * 为什么必须先领取再执行：批准是「放行一次」，不是「长期开闸」。若只看
   * `status === 'granted'` 就放行，同一会话后续任何同参调用（甚至模型刷循环）
   * 都会无限复用这一次点头——审批从门退化成通知。
   *
   * 为什么在**副作用之前**领取：领取成功才允许执行；反过来（先执行再领取）
   * 并发下会出现「两次执行、一次领取」，副作用双份。领取失败 = 已被别处用掉，
   * 调用方必须按拒绝处理（fail-closed）。
   *
   * @returns true = 本次调用持有这张单的执行权
   */
  async consume(approvalKey: string): Promise<boolean> {
    const updated = await this.approvals.update(
      { approvalKey, status: "granted" },
      { status: "consumed" },
    );
    return (updated.affected ?? 0) > 0;
  }
}

/**
 * 规范化 JSON：对象键排序（递归）、数组保序、undefined 掉键。
 *
 * 只为「同参重试命中同一审批键」服务——不做通用序列化器，因此不处理
 * Date/Buffer 等特殊类型（工具参数来自 JSON.parse，本来就只有 JSON 类型）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}
