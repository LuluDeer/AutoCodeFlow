import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * P5/P6（agent-and-deployment）：SOP 澄清对话（设计文档 04 §2.4 + 11 §3.2）。
 *
 * 这是「执行器 Agent 回问 → 中台 Agent 复核 → 循环直到合格」链路的落点。
 * 三种处置（04 §3 ④）：
 *   answered            —— 直接答复，SOP 不变
 *   sop_amended         —— SOP 确有缺失 → 修订 → 发新版本（不可变快照）
 *   escalated_to_human  —— 超出 Agent 能力（或 maxRounds 触顶强制）→ 通知人
 *
 * ## 提示注入面（11 §5.3——本表最重要的安全属性）
 * `question` 来自执行器 Agent，**不可信**：长度上限 + 脱敏后入库；进中台
 * Agent 上下文时明确标注为「不可信的对方陈述」。它只能作为事实输入，
 * 不能成为指令——修订/升级的安全决策由代码层闸门（maxRounds、白名单）
 * 兜底，不靠模型自觉。
 *
 * ## 幂等
 * `clientClarificationId` 由执行器生成（UUID），网络重试重发同请求时按它
 * 去重——与既有 triggerId/executionId 的去重思路一致（11 §3.2）。
 */

export const SOP_CLARIFICATION_RESOLUTIONS = [
  "answered",
  "sop_amended",
  "escalated_to_human",
] as const;
export type SopClarificationResolution =
  (typeof SOP_CLARIFICATION_RESOLUTIONS)[number];

/** 媒体引用（截图/录屏）。URL 必须指向平台 artifacts，绝不接受任意 URL。 */
export interface SopClarificationMediaRef {
  kind: "video" | "screenshot" | "other";
  /** 平台内路径（/api/... 形态）或 artifactId——不接受外网 URL。 */
  url: string;
  note?: string;
}

@Entity("sop_clarifications")
@Index("idx_sop_clarifications_assignmentId_round", ["assignmentId", "round"])
// 幂等去重：客户端生成的 UUID 唯一（PG 唯一索引允许多行 NULL——中台侧
// 自建的澄清行该列为 NULL，不参与去重）
@Index("uq_sop_clarifications_clientId", ["clientClarificationId"], {
  unique: true,
})
export class SopClarification {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 执行器生成的幂等键（UUID）。NULL = 中台/人工侧创建。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  clientClarificationId: string | null;

  @Column({ type: "uuid" })
  assignmentId: string;

  /** 澄清轮次（1 起；对照指派的 maxRounds 硬闸）。 */
  @Column({ type: "int" })
  round: number;

  /** 执行器的疑问（不可信——入库前长度钳位 + 脱敏）。 */
  @Column({ type: "text" })
  question: string;

  /** 疑问发生时的上下文（当前步骤、已尝试动作——同样不可信）。 */
  @Column({ type: "jsonb", nullable: true })
  questionContextJson: Record<string, unknown> | null;

  /** 中台 Agent（或人）的回复。 */
  @Column({ type: "text", nullable: true })
  answer: string | null;

  /** 处置结果。NULL = 待中台 Agent 复核。 */
  @Column({ type: "varchar", length: 32, nullable: true })
  resolution: SopClarificationResolution | null;

  /** 若 sop_amended，记录发的新版本。 */
  @Column({ type: "varchar", length: 32, nullable: true })
  newSopVersion: string | null;

  /** 视频/截图引用（多模态入口，04 §5）。 */
  @Column({ type: "jsonb", nullable: true })
  mediaRefsJson: SopClarificationMediaRef[] | null;

  /** 处理本次澄清的 sop_review 会话（因果链）。 */
  @Column({ type: "uuid", nullable: true })
  reviewSessionId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
