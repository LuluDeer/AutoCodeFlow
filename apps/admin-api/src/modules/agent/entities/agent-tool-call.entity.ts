import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * P2：单次工具调用记录。
 *
 * 为什么与 AgentStep 分表（而不是塞进 step 的 jsonb）：
 *   · **按工具维度的风控与统计**是刚需——「哪个工具失败率最高」
 *     「边界闸门拦了多少次」「某工具被连续熔断几次」都必须能 SQL 聚合；
 *     塞在 jsonb 里就只能全表扫。
 *   · 保留策略不同（见下），分表才能独立清理。
 *
 * 保留策略（设计文档 10 §调整5）：**写/危险 tier 的调用保留 >= 180 天**，
 * 与审计保留期对齐——否则 90-180 天区间的 Agent 动作无法追溯细节。
 * 只读调用可短（30 天），由定时清理任务按 tier + createdAt 分别处理。
 */

/**
 * 工具分级（设计文档 03 §2）。
 * - read：只读，默认全开；
 * - write：有副作用，多数需审批；
 * - dangerous：默认禁用或强制审批（如审批类、删除类）。
 */
export const AGENT_TOOL_TIERS = ["read", "write", "dangerous"] as const;
export type AgentToolTier = (typeof AGENT_TOOL_TIERS)[number];

/**
 * 调用结果状态。
 *
 * `denied` 与 `awaiting_approval` **同样要落库**，不能只在内存丢弃：
 *   · denied 是**安全信号**——被拒的尝试暴露了「Agent 试图越界」，
 *     是攻击检测与调参（scope 是否过紧）的关键输入；
 *   · awaiting_approval 是挂起恢复的锚点（会话 resume 时据此判断该调
 *     是否已获批）。
 */
export const AGENT_TOOL_CALL_STATUSES = [
  "ok",
  /** 被边界闸门拒绝（附 reason）。 */
  "denied",
  /** 需人工审批，会话已挂起。 */
  "awaiting_approval",
  "timeout",
  "error",
  /** 被熔断（同工具连续失败达阈值）。 */
  "circuit_open",
] as const;
export type AgentToolCallStatus = (typeof AGENT_TOOL_CALL_STATUSES)[number];

@Entity("agent_tool_calls")
// 按工具维度统计/风控（失败率、熔断计数）
@Index("idx_agent_tool_calls_toolName_createdAt", ["toolName", "createdAt"])
// 会话内查询（UI 展示 + resume 时检查待审批项）
@Index("idx_agent_tool_calls_sessionId", ["sessionId"])
// 保留策略按 tier + 时间清理
@Index("idx_agent_tool_calls_tier_createdAt", ["tier", "createdAt"])
export class AgentToolCall {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  sessionId: string;

  /** 发起本调用的 step（同一 step 可含多个 tool_calls）。 */
  @Column({ type: "uuid", nullable: true })
  stepId: string | null;

  @Column({ type: "varchar", length: 64 })
  toolName: string;

  @Column({ type: "varchar", length: 16 })
  tier: AgentToolTier;

  /**
   * 调用参数——**已脱敏**。
   *
   * 参数来自 LLM，可能包含它从上下文里抄来的凭据样式串；落库前必须过
   * sanitizeLogs 同款脱敏，并额外剥离凭据类字段名（token/password/secret）。
   */
  @Column({ type: "jsonb", nullable: true })
  argsJson: Record<string, unknown> | null;

  /**
   * 结果——**截断存储**。
   *
   * 大结果（如一次列 500 条执行）只存摘要 + sha256；完整结果留给模型的
   * 上下文窗口（截断后进 messages），需要回读时用 get_tool_call_result
   * 工具按 id 取。这样既避免 DB 膨胀，又保证模型能拿到完整信息。
   */
  @Column({ type: "jsonb", nullable: true })
  resultJson: Record<string, unknown> | null;

  /** 结果是否被截断（供 UI 提示「完整结果需回读」）。 */
  @Column({ type: "boolean", default: false })
  resultTruncated: boolean;

  @Column({ type: "varchar", length: 24, default: "ok" })
  status: AgentToolCallStatus;

  /** denied/circuit_open 的拒绝理由；error 的异常信息。 */
  @Column({ type: "text", nullable: true })
  errorMessage: string | null;

  /** 关联的审批记录 id（status=awaiting_approval 时非空）。 */
  @Column({ type: "uuid", nullable: true })
  approvalId: string | null;

  @Column({ type: "int", default: 0 })
  durationMs: number;

  @CreateDateColumn()
  createdAt: Date;
}
