import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * A1 审批闭环（审计轮 #11 → 实施轮 #12）：Agent 工具调用的审批单。
 *
 * ## 为什么是独立实体而不是会话上的一个 jsonb 字段
 *
 * `agent_tool_calls.approvalId` 早已把「哪次调用在等审批」落了库，缺的只是
 * 审批单本身——挂在 session 的 jsonb 上会让「按状态聚合待审批单」（运营看板
 * 的核心查询）退化成全表扫，且审批的保留期与调用记录不同（审计要求 >= 180 天）。
 * 独立表让 grant/deny 有自己的行锁与条件写竞争面，与 ADR-026 的纪律一致。
 *
 * ## 与 requestApproval 旧实现的关系
 *
 * 旧 `requestApproval()` 只拼 `apr-<sessionId>-<ts>` 字符串推一条通知——
 * 「审批只有申请没有批准」，5 个 approvalRequired 工具因此永久不可执行
 * （审计轮 #11 A1，当时做了如实降级）。本实体是闭环的落库半边：申请落库、
 * grant/deny 端点翻转状态、grant 后由 controller 复用既有 resume 链路恢复会话。
 */
export const AGENT_APPROVAL_STATUSES = [
  /** 已申请，待人工处置（会话此时挂起在 waiting_input）。 */
  "pending",
  /** 已批准——controller 在同事务外触发会话 resume。 */
  "granted",
  /** 已拒绝——会话同样恢复，但该工具调用按 denied 终局。 */
  "denied",
] as const;
export type AgentApprovalStatus = (typeof AGENT_APPROVAL_STATUSES)[number];

@Entity("agent_approvals")
// 运营看板按状态扫待审批单（pending 是唯一需要人看的行）
@Index("idx_agent_approvals_status_createdAt", ["status", "createdAt"])
// 会话详情页按会话列出审批单
@Index("idx_agent_approvals_sessionId", ["sessionId"])
export class AgentApproval {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /**
   * 申请幂等键（= agent_tool_calls.approvalId，`apr-<sessionId>-<ts>`）。
   *
   * 与 tool_call 表的关联是**逻辑外键**（varchar 而非 uuid 列）：键由
   * requestApproval 生成，先落审批单后落调用行（「先落盘后发送」同款纪律），
   * 用 uuid 外键会把写入顺序锁死。唯一约束保证重试不产生第二张单。
   */
  @Column({ type: "varchar", length: 128, unique: true })
  approvalKey: string;

  @Column({ type: "uuid" })
  sessionId: string;

  @Column({ type: "varchar", length: 64 })
  toolName: string;

  /** 边界闸门给出的审批理由（原样透传给审批人）。 */
  @Column({ type: "text" })
  reason: string;

  @Column({ type: "varchar", length: 16, default: "pending" })
  status: AgentApprovalStatus;

  /** 处置人（JWT sub）。NULL = 尚未处置。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  decidedBy: string | null;

  @Column({ type: "timestamptz", nullable: true })
  decidedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
