import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Not, Repository } from "typeorm";
import { AppError } from "../../../common/errors/app-error";
import {
  AgentApproval,
  type AgentApprovalStatus,
} from "../entities/agent-approval.entity";

/**
 * A1 审批闭环（实施轮 #12）：审批单的落库与状态翻转。
 *
 * 状态迁移只有两条：pending → granted / pending → denied。写路径统一走
 * **条件 UPDATE**（ADR-026 规则 4）：两个管理员同时点批准、或批准与拒绝撞在
 * 同一张单上时，命中 0 行的一方拿到 APPROVAL_ALREADY_DECIDED——审批单的
 * 结论只能有一个，先到者赢。
 */
@Injectable()
export class AgentApprovalsService {
  constructor(
    @InjectRepository(AgentApproval)
    private readonly approvals: Repository<AgentApproval>,
  ) {}

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
   */
  async decide(
    approvalKey: string,
    decision: Exclude<AgentApprovalStatus, "pending">,
    decidedBy: string,
  ): Promise<AgentApproval | null> {
    const updated = await this.approvals.update(
      { approvalKey, status: Not(In(["granted", "denied"])) },
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
}
