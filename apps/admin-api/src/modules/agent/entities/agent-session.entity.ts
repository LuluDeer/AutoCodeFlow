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
 * S2-A2：折叠账本的一行（**派生审计**，只回答「这一轮模型看到了什么」）。
 *
 * ## 为什么是「派生」而不是事实
 * 事实是 `agent_steps` + `agent_tool_calls`（折叠从不改写它们，见
 * agent-context.ts 头注）。本结构只是**某一轮折叠计划的计算结果快照**：
 * 删掉它，会话仍然可以完整重建、重放、复盘——所以它不参与 `rebuildMessages`，
 * 也不写进 `AgentStep.summary`（那会改变重建语义 ⇒ 双重折叠）。
 *
 * ## 为什么必须落库（不能只留 debug 日志）
 * ① 「长会话反复折叠是否收敛」此前无人可知（只有一条 debug 日志，见
 *    agent-runtime.service.ts 的折叠分支），也无法回答「第 N 轮模型看到什么」；
 * ② 判据「连续不收敛」需要**上一轮**的结论，而仓库纪律明确禁止在
 *    `agent-context.ts` 读上一轮状态（多副本 + 重启下进程内状态必然错误）。
 * 于是「判据在纯函数里算，输入从库里来，结果回库里」。
 *
 * 字段口径（全部来自同一次 `planContextWindow` 调用）：
 *   · `turnSeq`：本次折叠对应的 step 序号（= 该轮 `totalSteps + 1`），
 *     「第 N 轮」的 N 就是它；
 *   · `tokensBefore` / `tokensAfter`：`max(估算, 实测) + 预留` → 折叠后的估算 + 预留；
 *   · `foldedMessages`：折进摘要的消息条数（**0 = 折不动**，即 no-op 路径——
 *     这一行正是「静默 no-op 照原样发请求换 400」的可观测形态）；
 *   · `foldedToolCallIds`：被折、且摘要里仍留 `#id` 句柄的调用（见
 *     ContextWindowPlan.foldedToolCallIds 的交集口径）；
 *   · `digestHash`：摘要全文的 sha256（摘要可达 4k 字符，逐行存全文会让账本
 *     比它记录的 steps 还胖；hash 足以回答「两次折叠是不是同一份摘要」，
 *     全文可由同输入重算）；
 *   · `maxTokens`：当时的窗口上限——判据（`tokensAfter > maxTokens`）是**相对**
 *     配置的，不存它就无法事后复算这一行为什么被记成「不收敛」；
 *   · `streakAfter`：这一行落库后会话的连续不收敛计数（收敛证据本身）。
 */
export interface AgentContextFoldLedgerEntry {
  turnSeq: number;
  tokensBefore: number;
  tokensAfter: number;
  foldedMessages: number;
  foldedToolCallIds: string[];
  digestHash: string;
  maxTokens: number;
  streakAfter: number;
}

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

  /**
   * 发起人（`user:<username>` / `system:<cron|event>`）。G4：审批四眼原则的
   * 数据基础——NULL = 存量行/未知，审批策略按「不可判定」处理（warn）。
   */
  @Column({ type: "varchar", length: 64, nullable: true })
  createdBy: string | null;

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

  /**
   * 终态结论（结构化）：Agent 给出的结论、产出的资源 id 等。
   *
   * **写入点已脱敏**：`conclusion` 这个字符串在 `finish()` 里过
   * `redactSessionResultForStorage`（= `redactForStorage`：只打码、**不截断**）。
   * 本列此前是模型最终结论**原样入库**——这也是「会话行比步骤行更该脱敏」的
   * 由来：`agent_sessions` 行**永不删除**（保留期只清 steps / tool_calls /
   * approvals / events），又会被执行详情与导出 API 原样返回，一旦明文就是
   * 永久留存 + 永久外发。
   *
   * 注意与 `agent_tool_calls.resultJson` 区分：那一列是工具结果，上游
   * `ToolExecutorService` 已过 `sanitizeResult`，本层不再重复脱敏。
   */
  @Column({ type: "jsonb", nullable: true })
  resultJson: Record<string, unknown> | null;

  /**
   * 给通知渠道的一句话摘要（「有事才说话」——无结论的会话不通知）。
   *
   * **写入点已脱敏**（`finish()` 走 `redactNullableText`）。生成顺序是
   * **先脱敏、再截断 200 字**（`AgentRuntimeService.summarize`）：先截后打会
   * 把跨第 200 字的凭据切一半，剩下的半截不匹配任何规则 ⇒ 明文留存。
   * 这条正文会进通知（`AgentNotifyService.sessionFinished`），出口层虽有
   * 兜底，但**库里的原文没有**——本列就是那个「没有兜底」的副本。
   */
  @Column({ type: "text", nullable: true })
  summary: string | null;

  /**
   * 失败/中止原因（含 budget_exceeded 的具体超限项）。
   *
   * **写入点已脱敏**：`finish()` 与陈旧清扫（`sweepStaleRunning`）两处写入都过
   * `redactNullableText`。它会成为 failed / budget_exceeded 通知正文的首选内容
   * ⇒ 同样是「进通知 + 行永不删除」的组合，与步骤行不同，这里没有任何清理窗口。
   */
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
   * GAP-3：自动续跑次数（LLM 瞬态耗尽后的 delayed job 补跑）。
   *
   * 为什么落库而不是进程内 Set：本仓支持多副本且 admin-api 会重启——进程内
   * 计数在 N 个副本上就是 N 次补跑，重启后清零就是无限补跑。条件写
   * `autoResumeCount < 1` 让「每会话最多自动补一次」在多实例下也成立；
   * 需要人工再续时走显式 resume（不被这个计数拦住）。
   */
  @Column({ type: "int", default: 0 })
  autoResumeCount: number;

  /**
   * S2-A2：连续「折了但不收敛」的轮数（0 = 无历史）。
   *
   * 判据口径见 `isContextFoldNonConverging` / `nextContextFoldStreak`
   * （agent-context.ts）：命中 +1，否则清零；连续 ≥2 即把会话收敛为
   * `failed` + `errorMessage=context_not_converging: …`（复用既有终态，
   * **不新增状态枚举**——运维靠 errorMessage 前缀识别，与会话列表的终态
   * 语义、`finish()` 的条件写、陈旧清扫全部保持同一套）。
   *
   * 为什么是列而不是进程内标量：本仓多副本 + admin-api 会重启，进程内计数
   * 在 N 个副本上就是 N 次误判；`agent-context.ts` 头注更逐字禁止纯函数读
   * 上一轮状态。默认 0 让引入本列之前的历史行语义不变（零回填、零猜测）。
   */
  @Column({ type: "int", default: 0 })
  contextFoldStreak: number;

  /**
   * S2-A2：折叠账本（最近若干轮的派生记录，`AgentContextFoldLedgerEntry[]`）。
   *
   * 为什么是**会话行的 jsonb** 而不是新表（这一段就是「不建新表的理由」）：
   *   · 账本行只按 `sessionId` 归属、只服务「这一轮模型看到什么」，没有跨表
   *     查询需求（会话详情页一次读一行即可）；
   *   · 新表必须有清理路径，而清理任务在 `agent-session-retention.service.ts`
   *     （B-10）——账本若独立成表、又没接进那条 cron，就是**永不清理的新表**
   *     （终态会话本身不删，FK 级联等于没有）。挂在会话行上，生命周期与会话
   *     完全一致：行在账本在，行删账本走；
   *   · 无界增长由写入侧封顶（`AGENT_CONTEXT_FOLD_LEDGER_MAX`，只留最近 N 条，
   *     见 AgentSessionService.recordContextFold）：单行体积有界，读会话详情
   *     时也不会一次拖出几千行。
   * 口径：**只落派生、不参与重建**——`rebuildMessages` 从不读这一列。
   */
  @Column({ type: "jsonb", nullable: true })
  contextFoldLedger: AgentContextFoldLedgerEntry[] | null;

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
