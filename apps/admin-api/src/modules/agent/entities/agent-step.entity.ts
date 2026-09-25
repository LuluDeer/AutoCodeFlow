import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * P2：Agent 的一步（一次「消息 → 模型响应」）。
 *
 * 为什么**全量落库**而不是只在内存里维护 messages 数组：推理循环必须
 * **可重入**。会话会在两种情况下中断并从数据库重建上下文——
 *   ① `waiting_input` 挂起（等审批 / 等澄清）后 resume；
 *   ② admin-api 重启（进程内 state 全丢）。
 * 没有全量 steps，重启后会话就只能作废；有了它，`run()` 每次从 DB 重建
 * messages 再继续，语义与中断前一致。
 *
 * 这也是「审计与复盘」的基础：出问题时要能完整回放 Agent 看过什么、
 * 每一步想了什么。
 */

/** 消息角色（对齐 LLM chat 协议的四种角色）。 */
export const AGENT_STEP_ROLES = [
  "system",
  "user",
  "assistant",
  "tool",
] as const;
export type AgentStepRole = (typeof AGENT_STEP_ROLES)[number];

@Entity("agent_steps")
// 会话内按 seq 顺序读取是唯一高频访问模式（重建 messages / UI 时间线）
@Index("idx_agent_steps_sessionId_seq", ["sessionId", "seq"], { unique: true })
@Index("idx_agent_steps_createdAt", ["createdAt"])
export class AgentStep {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  sessionId: string;

  /** 会话内序号（从 1 开始）。唯一约束 (sessionId, seq) 保证顺序不歧义。 */
  @Column({ type: "int" })
  seq: number;

  @Column({ type: "varchar", length: 16 })
  role: AgentStepRole;

  /**
   * 消息正文。**已脱敏**（复用 AiService.sanitizeLogs 的脱敏口径）——
   * 工具结果可能含凭据样式串，落库前必须过一遍。
   */
  @Column({ type: "text", nullable: true })
  content: string | null;

  /** 模型的思考过程（若 provider 返回 reasoning_content）。 */
  @Column({ type: "text", nullable: true })
  reasoning: string | null;

  /**
   * 本步请求的工具调用（可能多个）。
   *
   * 存 jsonb 数组而非拆成 tool_calls 表：它们只在「重建 messages」时被
   * 整体读回（LLM 协议要求 assistant 消息带上完整的 tool_calls 数组），
   * 不需要按单个调用查询。按工具维度的统计走 AgentToolCall 表。
   */
  @Column({ type: "jsonb", nullable: true })
  toolCallsJson: unknown[] | null;

  /** role=tool 时，关联回请求它的 tool_call.id（LLM 协议要求）。 */
  @Column({ type: "varchar", length: 128, nullable: true })
  toolCallId: string | null;

  @Column({ type: "int", default: 0 })
  tokensIn: number;

  @Column({ type: "int", default: 0 })
  tokensOut: number;

  @Column({ type: "int", default: 0 })
  latencyMs: number;

  /**
   * 实际路由到的 provider / model。
   *
   * 为什么必须逐条记录：Agent 可能**混合模型**（日常推理用便宜的，
   * 看录屏时切 qwen-vl）。出问题时「这一步是谁答的」直接决定排查方向；
   * 成本归因也依赖它。
   */
  @Column({ type: "varchar", length: 32, nullable: true })
  provider: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  model: string | null;

  /**
   * 上下文压缩后留下的阶段性小结（P2 §4.3）。
   * 非空表示这一步已被折叠——重建 messages 时用摘要替代原文，
   * 避免长会话把上下文窗口撑爆。
   */
  @Column({ type: "text", nullable: true })
  summary: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
