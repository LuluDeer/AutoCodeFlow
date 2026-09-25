import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * P2（agent-and-deployment）：Agent 会话。
 *
 * 一个会话 = 一次完整的 Agent 任务（一次巡检、一次事件处置、一次 SOP 编排…），
 * 由多轮「推理 → 调工具 → 观察」的 step 组成（见 AgentStep）。
 *
 * 与既有 `Task`/`TaskExecution` 的关系：**刻意不塞进既有执行模型**。
 * 理由是语义与生命周期都不同——
 *   · Task 是「确定性的业务逻辑单元」，Execution 是一次运行；
 *   · AgentSession 是「不确定的多轮推理过程」，轮次/工具调用/令牌消耗才是
 *     它的核心度量，而 Execution 的 status/exitCode/日志模型装不下这些。
 * 两者通过 `task_executions.agentSessionId`（P2 同批新增，可空）关联：
 * Agent 触发的任务其执行行会带上会话 id，用户在执行详情页能看出「这是
 * Agent 干的」。这复用了项目既有的 `triggerType` 惯例（同 approval/dependency）。
 *
 * `parentSessionId` 是**多 Agent 协作的关键**（P6）：执行器 Agent 发起澄清
 * 时，中台会为这次澄清新开一个 `sop_review` 会话，其 parent 指向原编排会话，
 * 从而保留完整因果链（「这个应用是怎么从零到上线的」）。
 */

/** 会话类型——决定可用工具集（见设计文档 03 §2 的白名单映射）。 */
export const AGENT_SESSION_KINDS = [
  /** 运维值守：定时巡检、健康体检（只读工具集）。 */
  "ops_watch",
  /** 事件处置：执行失败风暴、执行器离线等（只读 + 有限写）。 */
  "incident",
  /** SOP 起草：产出应用骨架与 SOP 草稿。 */
  "sop_authoring",
  /** SOP 复核：处理执行器 Agent 的澄清（P6）。 */
  "sop_review",
  /** 应用脚手架：AI 写应用的编排（P5/P7）。 */
  "app_scaffold",
  /** 人工对话：管理员直接提问。 */
  "chat",
] as const;
export type AgentSessionKind = (typeof AGENT_SESSION_KINDS)[number];

/**
 * 会话状态机。
 *
 * `waiting_input` 是**挂起态**而非阻塞态：审批等待、等执行器 Agent 回问都
 * 可能耗时很久，绝不能让 BullMQ worker 阻塞等待（worker 会因此占满）。
 * 挂起时释放 worker，由外部事件触发 resume 重新入队（见 AgentRuntimeService）。
 */
export const AGENT_SESSION_STATUSES = [
  "pending",
  "running",
  /** 等待外部输入：人工审批 / 执行器澄清回复。 */
  "waiting_input",
  "succeeded",
  "failed",
  "aborted",
  /** 触达预算闸门（轮次/令牌/墙钟/工具调用数任一超限）。 */
  "budget_exceeded",
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** 终态集合——用于「是否需要继续调度」的判定。 */
export const AGENT_TERMINAL_STATUSES: readonly AgentSessionStatus[] = [
  "succeeded",
  "failed",
  "aborted",
  "budget_exceeded",
];

/**
 * 会话预算（P2 §5.3 闸门）。
 *
 * 为什么每个会话都要落一份而不是全局读配置：预算是**创建时快照**语义——
 * 管理员事后调小全局上限，不应该追溯性地让正在跑的会话突然超限失败；
 * 反之调大也不该让旧会话"复活"。快照同时让事后审计能看到"当时允许多少"。
 */
export interface AgentBudget {
  maxSteps: number;
  maxTokens: number;
  wallClockMs: number;
  maxToolCalls: number;
}

@Entity("agent_sessions")
// 列表页默认按状态 + 时间倒序（Admin Web 的「智能运维」页）
@Index("idx_agent_sessions_status_createdAt", ["status", "createdAt"])
@Index("idx_agent_sessions_kind_createdAt", ["kind", "createdAt"])
// P6：按父会话反查子会话（执行器 Agent 的澄清链）
@Index("idx_agent_sessions_parentSessionId", ["parentSessionId"])
export class AgentSession {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 32 })
  kind: AgentSessionKind;

  @Column({ type: "varchar", length: 32, default: "pending" })
  status: AgentSessionStatus;

  /** 人可读标题，用于列表展示（如「executor-03 离线排查」）。 */
  @Column({ type: "varchar", length: 255, nullable: true })
  title: string | null;

  /**
   * 触发来源：`cron` / `event:<name>` / `user:<id>` / `agent:<sessionId>`。
   *
   * 存字符串而非外键：触发源是**描述性元数据**（供审计与列表筛选），
   * 且类型会随 P4 触发器扩展——做成外键会让每次新增触发源都要迁移。
   */
  @Column({ type: "varchar", length: 128 })
  triggerSource: string;

  /** 子会话指回父会话（P6 澄清链）。NULL = 顶层会话。 */
  @Column({ type: "uuid", nullable: true })
  parentSessionId: string | null;

  /**
   * 会话上下文：目标、涉及的应用/任务/执行器 id、SOP 引用、作用域约束。
   *
   * 用 jsonb 而非独立列：结构随会话类型差异很大（ops_watch 关心执行器、
   * sop_authoring 关心应用与 SOP），拉平会得到大量稀疏列。
   */
  @Column({ type: "jsonb", nullable: true })
  contextJson: Record<string, unknown> | null;

  /**
   * 作用域约束（设计文档 03 §5.3）：本会话允许操作哪些 application /
   * executor / project。边界闸门用它做越界判定——**即使工具 tier 允许，
   * 越出 scope 也拒**。默认由触发源推导（事件触发的会话绑定到该事件资源）。
   */
  @Column({ type: "jsonb", nullable: true })
  scopeJson: Record<string, unknown> | null;

  /** 创建时的预算快照。 */
  @Column({ type: "jsonb", nullable: true })
  budgetJson: AgentBudget | null;

  /** 终态结论（结构化）：Agent 给出的结论、产出的资源 id 等。 */
  @Column({ type: "jsonb", nullable: true })
  resultJson: Record<string, unknown> | null;

  /** 给通知渠道的一句话摘要（「有事才说话」——无结论的会话不通知）。 */
  @Column({ type: "text", nullable: true })
  summary: string | null;

  /** 失败/中止原因（含 budget_exceeded 的具体超限项）。 */
  @Column({ type: "text", nullable: true })
  errorMessage: string | null;

  /** 累计用量（每步累加，供预算闸门与成本看板读取）。 */
  @Column({ type: "int", default: 0 })
  totalSteps: number;

  @Column({ type: "int", default: 0 })
  totalTokensIn: number;

  @Column({ type: "int", default: 0 })
  totalTokensOut: number;

  @Column({ type: "int", default: 0 })
  totalToolCalls: number;

  /**
   * 等待外部输入时的说明（waiting_input 状态下给用户看「在等什么」）。
   * 如「等待审批 approval-xxx」「等待执行器 asg-123 澄清回复」。
   */
  @Column({ type: "varchar", length: 255, nullable: true })
  waitingFor: string | null;

  @Column({ type: "timestamptz", nullable: true })
  startedAt: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
