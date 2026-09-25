import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * P5（agent-and-deployment）：SOP 指派（设计文档 04 §2.3 + 11 §4.1）。
 *
 * 指派 = 「SOP 交给哪个执行器 Agent 去做」的工单。P5 先支持**手工 HTTP
 * 模拟执行器**（roadmap P5 验收口径），P7 的执行器 Agent 经 agent-collab
 * poll 通道领取同一份工单——所以 11 §4.1 细化的列（pulledAt /
 * lastProgressAt / progressJson / attempt / capabilitySnapshotJson /
 * permissionProfileAtPull）在 P5 一次建齐，P7 不再加列。
 */

/** 指派状态机。stalled 由超时扫描置位（领取后进度心跳超时）。 */
export const SOP_ASSIGNMENT_STATUSES = [
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "stalled",
] as const;
export type SopAssignmentStatus = (typeof SOP_ASSIGNMENT_STATUSES)[number];

@Entity("sop_assignments")
@Index("idx_sop_assignments_sopId", ["sopId"])
@Index("idx_sop_assignments_targetExecutorId_status", [
  "targetExecutorId",
  "status",
])
// poll 通道按执行器拉待办（只拉 assigned/in_progress 等活跃态）
@Index("idx_sop_assignments_status_createdAt", ["status", "createdAt"])
export class SopAssignment {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  sopId: string;

  /** 指派的 SOP 版本——执行器按**具体版本**执行（contentHash 校验锚）。 */
  @Column({ type: "varchar", length: 32 })
  sopVersion: string;

  /** 目标执行器（uuid，poll 时按 address 反查 executor 再匹配此列）。 */
  @Column({ type: "uuid", nullable: true })
  targetExecutorId: string | null;

  /** 执行器侧 Agent 会话 id（执行器自生成，中台只透传存档）。 */
  @Column({ type: "varchar", length: 128, nullable: true })
  targetAgentSessionId: string | null;

  @Column({ type: "varchar", length: 16, default: "assigned" })
  status: SopAssignmentStatus;

  /** 已完成澄清轮次（对照 maxRounds 硬闸）。 */
  @Column({ type: "int", default: 0 })
  clarificationRound: number;

  /**
   * 澄清轮次上限——**指派时从 SOP front-matter 快照**（事后改 SOP 不追溯
   * 已派工单，与预算快照同款语义）。
   */
  @Column({ type: "int", default: 5 })
  maxRounds: number;

  /** 完成回报（status/acceptanceResults/artifacts/summary）。 */
  @Column({ type: "jsonb", nullable: true })
  resultJson: Record<string, unknown> | null;

  /** 中台编排会话（澄清链 parentSessionId 的锚）。 */
  @Column({ type: "uuid", nullable: true })
  parentSessionId: string | null;

  /** 首次被领取时间（「派出去了但没人接」的判定依据，11 §6）。 */
  @Column({ type: "timestamptz", nullable: true })
  pulledAt: Date | null;

  /** 最后一次进度上报（卡死判定依据）。 */
  @Column({ type: "timestamptz", nullable: true })
  lastProgressAt: Date | null;

  /** 最新进度快照（幂等覆盖写）。 */
  @Column({ type: "jsonb", nullable: true })
  progressJson: Record<string, unknown> | null;

  /** 回报重试计数（幂等键 `(assignmentId, attempt)` 的一部分）。 */
  @Column({ type: "int", default: 0 })
  attempt: number;

  /** 澄清回复投递游标（poll 只投递该时刻之后 resolution 落定的行）。 */
  @Column({ type: "timestamptz", nullable: true })
  lastReplyDeliveredAt: Date | null;

  /** 领取时该机器的能力快照（事后复盘「当时它能做什么」，11 §4.1）。 */
  @Column({ type: "jsonb", nullable: true })
  capabilitySnapshotJson: Record<string, unknown> | null;

  /** 领取时的权限档位（审计：它当时被允许做什么）。 */
  @Column({ type: "varchar", length: 32, nullable: true })
  permissionProfileAtPull: string | null;

  /** 指派人：`agent:<sessionId>` 或 `user:<id>`。 */
  @Column({ type: "varchar", length: 128 })
  assignedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
