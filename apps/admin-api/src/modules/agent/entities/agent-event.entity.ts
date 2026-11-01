import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * S7-G1（第一阶段）：Agent 会话的**取证型事件日志**（`agent_events`）。
 *
 * ## 为什么需要它（与既有表的分工）
 * 既有三张表回答的是「**现在**是什么」：
 *   · `agent_steps` —— 当前的消息序列（`rebuildMessages` 的唯一数据源）；
 *   · `agent_tool_calls` —— 工具台账，但 `status` 是**就地更新**的
 *     （`in_flight` → `ok`/`error`），**历史状态不保留**；
 *   · `agent_sessions.stateChangedAt`（迁移 0083）—— **一个**时间戳，**不是序列**。
 * 于是「这行变成 `in_flight` 之后、变成 `error` 之前，模型看到了什么」这个问题
 * 在今天**答不出来**：回答它需要的是「按时间排列的事实序列」，而上面三张表都
 * 只存最后一个快照。事件日志补的就是这个维度。
 *
 * ## 为什么**只写不读**（本阶段的核心纪律）
 * 事件日志的价值有两半：
 *   ① **取证**：「当时到底发生了什么」的完备载体；
 *   ② **重算**：拿事件流重放出一个等价状态（Temporal 式 replay）。
 * 我们只拿 ①，**不做** ②：Agent 的每一步里都夹着 LLM 调用与带副作用的工具
 * （写文件、跑 bash、发外部 HTTP），重放一遍得到的是**另一个答案**与**第二次
 * 副作用**，不是恢复。Temporal 的 replay 成立于「重放的是确定性代码」，而我们
 * 的步骤不是确定性代码——这一点是死结论，不是权衡（见
 * `02_cross_analysis/S7-orchestration-cross-analysis.md` §1）。
 * 所以本阶段**不**接入读取路径：`rebuildMessages` 继续用「当前行快照重建」，
 * 事件表只写。这样做还有一个正面理由——**只有一份真相源**。若现在就让上下文
 * 重建改读事件流，我们会同时拥有「事件投影」和「snapshot 重建」两套语义，
 * 它们一旦漂移，排查时不知道该信谁；而取证用途**不需要**它们一致，只需要事件
 * 本身忠实。读取/投影（`projectSession`）留到下一阶段，届时用「双跑对账」
 * （同一会话两份输出逐条比对）来证明投影等价，而不是先切换再祈祷。
 *
 * ## 为什么不抄 Temporal 的另外两条不变量（`temporal-main.md` §M1）
 * 我们落实了适用的两条（见 `AgentSessionService.appendEvents`：同批 `seq`
 * 连续 + 超批量上限整批拒，不许部分写入）。另外两条**刻意不抄**：
 *   · **同批版本必须一致**：那是**分片**（RangeID）语义——一个批次必须落在
 *     同一分片、同一历史节点上，版本号用来发现「分片分裂/迁移期间的事件错位」。
 *     我们是**单库单表**，没有 RangeID、没有分片分裂，版本号只能是永远相等的
 *     常量（一条永真断言 = 零保护，却让每次写入多带一个字段）。
 *   · **`node_id = 首批事件 ID`**：那是**重放锚点**（回放从哪一批开始、指纹
 *     对齐用）。既然我们不做重放（见上），锚点没有消费方；留下它只会变成
 *     「一个没人读的列」，而本仓对「加了列 ≠ 有了能力」已有明确教训。
 *
 * ## 载体形态：一行一事件（而不是 Temporal 的「一行一事务批次 blob」）
 * Temporal 把一批事件压成一行 blob，是因为它的历史要**整批**参与重放、且要
 * 严格控制行数。我们的消费方是「按会话、按时间翻页取证」，一行一事件让
 * `(sessionId, seq)` 唯一约束直接充当「不跳号/不重复」的硬闸，也让保留期清理
 * 能按 `createdAt` 直接删——不需要解包 blob。代价是行数更多，由保留期封顶。
 *
 * ## payload 里**不放**什么（与 `agent_steps` 的脱敏纪律同源）
 * 不放 LLM 正文、不放工具参数、不放工具结果：
 *   · 正文可能几 MB（长工具输出），且是 `agent_steps` 已有的副本；
 *   · 参数/结果可能含凭据样式串，事件表是**长期保留**的审计面，宁可少记；
 *   · 「当时看到什么」用**指纹**回答（见 `prompt_fingerprint` 事件），需要
 *     全文时按 `stepId`/`toolCallId` 回读既有表。
 *
 * ## 保留期
 * 本表是**新表**，必须有清理路径，否则就是一张永不清理的表（会话行永不删除，
 * `ON DELETE CASCADE` 等于没有）。清理在
 * `agent-session-retention.service.ts` 的 `cleanupExpiredEvents`（B-10 的同一
 * 条 cron），判据与 steps 同款：只清**终态会话**的超期事件。
 */
@Entity("agent_events")
// 会话内按 seq 翻页是唯一读模式；同时它是「同 seq 不许写两行」的硬闸
@Index("uq_agent_events_sessionId_seq", ["sessionId", "seq"], { unique: true })
// 保留期清理的唯一挑选条件（DELETE ... WHERE "createdAt" < cutoff）
@Index("idx_agent_events_createdAt", ["createdAt"])
export class AgentEvent {
  /**
   * 代理主键（uuid）。
   *
   * 为什么不是 bigserial：`(sessionId, seq)` 才是事件的**真身份**，主键只是
   * 给「单条事件」一个可引用的句柄（未来做「取某条事件做标注/导出」时不必
   * 携带两列）。uuid 与同域 `agent_steps` / `agent_sessions` 一致，且不会像
   * 全局自增那样把「全库事件总数」编码进一个可被外部看到的 id 里（事件数
   * 跨会话可推断）。代价是每行多 8 字节，对一张有保留期的取证表可忽略。
   */
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 归属会话（FK → agent_sessions，ON DELETE CASCADE，见迁移 1790000000089）。 */
  @Column({ type: "uuid" })
  sessionId: string;

  /**
   * 会话内**单调递增**序号（从 1 开始，无空洞）。
   *
   * 由 `INSERT ... SELECT COALESCE(MAX(seq),0)+ord` **单语句**分配（见
   * `AgentSessionService.appendEvents` 的注释），`(sessionId, seq)` 唯一约束
   * 是并发下「同 seq 写两行」的硬闸。
   */
  @Column({ type: "int" })
  seq: number;

  /**
   * 事件类型（闭集，见 `AGENT_EVENT_KINDS`）。
   *
   * 为什么 DB 侧**不加** CHECK 约束：闭集在代码侧（写入口只有 `appendEvents`
   * 一处）已经收敛，而取证表的价值恰恰包含「后来补记一种新事实」——每次新增
   * kind 都要一张迁移，会让「补记」这件事被结构性劝退。varchar(32) 留够长度。
   */
  @Column({ type: "varchar", length: 32 })
  kind: AgentEventKind;

  /** 事件体（**不含**正文/参数/结果，见类头注）。缺省 `{}`，永不为 NULL。 */
  @Column({ type: "jsonb", default: () => "'{}'" })
  payload: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}

/**
 * 事件类型闭集。
 *
 * **只列真实写入点**（每个 kind 都能在代码里找到唯一落点），不预留「将来可能
 * 有用」的类型——空类型等于假覆盖：查 `kind='x'` 一条都没有，会被读成「这类
 * 事从未发生」。新增 kind 时：① 在此登记；② 在写入点落一条；③ 在
 * `agent-events.spec.ts` 钉住 payload 形状。
 *
 * - `step_appended`：追加一步之后（`appendStep` 提交后）。只记 seq/角色/token/
 *   provider/model 与是否被折叠，不记正文；
 * - `tool_call_recorded`：工具台账**首次**插入（`recordToolCall`，开跑/待审批/
 *   被拒都在这里，`payload.status` 是初态）；
 * - `tool_call_status_changed`：台账**就地更新**（`updateToolCallByToolCallId`）
 *   —— 正是「历史状态不保留」那个缺口的补丁：从今以后状态变化有序列；
 * - `prompt_fingerprint`：**每轮真正调用 provider 之前**，本轮实际发送的
 *   messages+tools 的摘要（唯一直接回答「模型当时看到什么」的事件）；
 * - `session_finished`：会话收敛到终态（`finish` 的条件写命中之后）。
 */
export const AGENT_EVENT_KINDS = [
  "step_appended",
  "tool_call_recorded",
  "tool_call_status_changed",
  "prompt_fingerprint",
  "session_finished",
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** 待写入的事件（`seq`/`id`/`createdAt` 由 DB 或写入侧生成，不接受外部指定）。 */
export interface AgentEventInput {
  kind: AgentEventKind;
  payload?: Record<string, unknown> | null;
}
