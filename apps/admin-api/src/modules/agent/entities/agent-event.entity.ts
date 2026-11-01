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
 * ## payload 里**放**正文（S7-G1 第五阶段：从「索引」改成「载体」）
 *
 * 此前 payload **只放元数据 + 引用 + 指纹**（`errorMessage: "present"`、
 * `hasResult: true`、`content` 只记有没有），理由是「正文在 `agent_steps` /
 * `agent_tool_calls` 上，按 `stepId`/`toolCallId` 回读即可」。这条理由**当年就不
 * 成立**，现在更不成立：
 *
 *   · 那两张表的正文是**就地覆盖**的——`updateToolCallByToolCallId` 会把同一行
 *     的 `status`/`resultJson`/`errorMessage` 反复改写（`in_flight` → `ok`/`error`），
 *     `appendStep` 也允许对同一步补 `summary`。**引用是稳定的，被引用的东西不是**：
 *     今天按 `toolCallId` 回读到的是「最后一次写入」，而不是「第 N 轮那一刻模型
 *     看到的」。
 *   · 于是「第 N 轮模型看到什么」这个缺口只被**索引**掉了，没被关闭：事件流能
 *     告诉你「有一份结果」，却答不出「那份结果的内容」。取证表答不出取证问题，
 *     就等于没有。
 *   · Temporal 也是这么做的：`Input`/`Result` **直接进事件属性**
 *     （`common/persistence/history_manager.go:316-333` / `:358-374`），而不是
 *     只在事件里留一个指向可变状态的引用。
 *
 * 代价必须写清（这是本条改动的三根硬约束）：
 *   ① **脱敏**：正文进长期保留的审计面 = 一个新的泄密面。所有正文一律先过既有
 *      脱敏（见 `AgentSessionService.redactEventBodyText`）再进 payload；
 *   ② **有界**：单条正文超过 `AGENT_EVENT_BODY_MAX_BYTES` 即**截断并标记**
 *      （`truncated` + `originalBytes`），既不是丢弃也不是静默——否则事件表会
 *      被一条几 MB 的工具输出撑爆，而裁剪掉的部分必须**看得出来**；
 *   ③ **整批有界**：`appendEvents` 另加字节上限（`AGENT_EVENT_BATCH_MAX_BYTES`），
 *      超限**整批拒**（一行不写），与条数上限同形态。
 *
 * 形状统一收在一个槽位 `payload.body` 里（`AgentEventBodyBag`）：三种正文各自
 * 有名字（`content` / `result` / `error`），截断语义只有一处定义，读者不必为每个
 * kind 记一套。**不是**要替代既有元数据：`hasResult` / `errorMessage:"present"` /
 * `folded` 这些「有没有」的判据原样保留（投影与守卫脚本在吃它们）。
 *
 * 存量不可回填（如实）：本次改动**之前**写入的事件没有 `body`——那时确实没记，
 * 不补、不伪造。可读性判据是 `payload.body` 是否存在，而不是「这条事件有没有正文」。
 *
 * ## 因果边：`causedBySeq`（A2，迁移 1790000000093）
 *
 * 上面所有内容把事件流做成了**忠实的时间序列**，但它仍然只是「扁平日志」：
 * 能查到「先发生了什么、后发生了什么」，查不到「后那条是被**哪条**引起的」。
 * 要回答「这条 `tool_call_status_changed` 是谁引起的」，今天只能打开 `payload`
 * 去猜（`toolCallId` 相同 ⇒ 同一条调用），而那是**推断**不是**事实**：
 *   · 一次调用有多条状态迁移，「第 3 条是被第 2 条还是被 `approval_decided`
 *     引起的」按 `toolCallId` 根本分不出来（Temporal 用 `ScheduledEventId`
 *     把这个指针**写在数据里**，见 `mutable_state_impl.go:4777-4783`）；
 *   · payload 可以缺字段（迁移 069 之前的 `tool_call_recorded` 没有
 *     `toolCallId`），指针一旦依赖正文写全就不是结构；
 *   · 推断永远能给一个「看起来对」的答案 ⇒ **配错了在数据层不可见**。
 * 所以因果**落列**：`causedBySeq` 指向同一会话内引起本事件的那条事件的 `seq`。
 *
 * 可空 = 「不知道」：本列上线前写入的事件没有因果，**不回填、不猜**（用启发式
 * 填进去就是把推断固化成事实，之后再也分不清哪条是真指针）。读侧因此分档：
 * 有值走因果配对（`resolvedBy: "causation"`），NULL 走既有启发式
 * （`resolvedBy: "heuristic"`）——存量会话逐字节不变。
 *
 * 非法值只有两种，都由投影记成**缺口**而不是静默接受：
 *   · `causedBySeq >= seq`：因果必须先于结果（时序倒挂 = 写入侧 bug）；
 *   · 指向本会话事件流里不存在的前驱：跨会话引用，或前驱已被保留期清掉。
 *
 * ## 保留期
 * 本表是**新表**，必须有清理路径，否则就是一张永不清理的表（会话行永不删除，
 * `ON DELETE CASCADE` 等于没有）。清理在
 * `agent-session-retention.service.ts` 的 `cleanupExpiredEvents`（B-10 的同一
 * 条 cron），判据与 steps 同款：只清**终态会话**的超期事件。
 *
 * ⚠ 因果列**故意不加 FK**：自引用 FK 会与「整批一条 SQL 插入」的原子性纠缠，
 * 且会在保留期删除「起因先过期、结果还在」时把清理 cron 拖死（NO ACTION）或
 * 改写历史（SET NULL）。三条否决理由写在迁移 1790000000093 的类头注里。
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
   * **因果边**：引起本条事件的那条事件的 `seq`（同一会话内，且必然更小）。
   *
   * `null` 的语义**只有一个**：写入时没有记录因果。三种情形都归到这里，读侧
   * 不区分也不需要区分（因为区分不了就是「不知道」）：
   *   · 本列上线（迁移 1790000000093）之前写入的存量事件；
   *   · 规则本身要求「没有单一前驱」的 kind（`step_appended` / `session_finished`，
   *     它们由用户/系统/整轮运行触发，不是某一条事件的直接结果）；
   *   · 规则要求的那个前驱**当时无法被精确确定**（引用解析不到唯一一行 /
   *     解析失败）——此时宁可不写，也不猜（`AgentEventInput.causedBySeq` 的注释）。
   *
   * 为什么是 `int` 而不是 uuid 外键：事件的真身份是 `(sessionId, seq)`，用 seq
   * 指向它最紧凑，也和「按 seq 翻页」这一唯一读模式同序。跨会话引用**不应存在**，
   * 但 DDL 层没有 FK 拦它（理由见类头注与迁移 1790000000093）⇒ 由投影的运行期
   * 断言把它记成缺口（`causation_missing`），由
   * `scripts/check-agent-event-causation.mjs` 从写入侧静态拦住漏传。
   */
  @Column({ type: "int", nullable: true })
  causedBySeq: number | null;

  /**
   * 事件类型（闭集，见 `AGENT_EVENT_KINDS`）。
   *
   * 为什么 DB 侧**不加** CHECK 约束：闭集在代码侧（写入口只有 `appendEvents`
   * 一处）已经收敛，而取证表的价值恰恰包含「后来补记一种新事实」——每次新增
   * kind 都要一张迁移，会让「补记」这件事被结构性劝退。varchar(32) 留够长度。
   */
  @Column({ type: "varchar", length: 32 })
  kind: AgentEventKind;

  /**
   * 事件体。**含正文**（`payload.body`，见类头注与 `AgentEventBodyBag`）：
   * 五种正文槽位各自有界、已脱敏、超限带截断标记。缺省 `{}`，永不为 NULL。
   *
   * 注意：`body` 是**新增**字段，本次改动之前的事件没有它——那时确实没记正文，
   * 不补、不伪造。读侧判据是「有没有 `body`」，不是「这条事件该不该有正文」。
   */
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
 * `agent-events.spec.ts` 钉住 payload 形状；④ 在 `AGENT_EVENT_CAUSATION_RULES`
 * 登记因果规则（守卫 `check-agent-event-causation` 按它判「该传的传了没有」）。
 *
 * - `step_appended`：追加一步之后（`appendStep` 提交后）。记 seq/角色/token/
 *   provider/model、是否被折叠，**以及该步正文**（`payload.body.content`）——
 *   正文必须以事件为载体，理由见类头注「payload 里**放**正文」；
 * - `tool_call_recorded`：工具台账**首次**插入（`recordToolCall`，开跑/待审批/
 *   被拒都在这里，`payload.status` 是初态）。带 `payload.body.result` /
 *   `payload.body.error`（脱敏后的结果与错误文案）；
 * - `tool_call_status_changed`：台账**就地更新**（`updateToolCallByToolCallId`）
 *   —— 正是「历史状态不保留」那个缺口的补丁：从今以后状态变化有序列。带
 *   `payload.body.result` / `payload.body.error`：这一条事件记的**就是本次
 *   更新的那份正文**，所以「第 N 次状态迁移时模型/审计看到什么」不再依赖回读
 *   那行（那行会被下一次更新覆盖）；
 * - `prompt_fingerprint`：**每轮真正调用 provider 之前**，本轮实际发送的
 *   messages+tools 的摘要（唯一直接回答「模型当时看到什么」的事件）；
 * - `session_finished`：会话收敛到终态（`finish` 的条件写命中之后）；
 * - `approval_decided`：**审批单状态变化**（`AgentApprovalsService.decide` /
 *   `consume` 的条件 UPDATE 命中之后）。payload 见
 *   `AgentApprovalsService.buildApprovalDecidedPayload`：
 *   `{ approvalKey, status: granted|denied|consumed, decidedBy, decidedAt }`。
 *
 * ## 为什么 `approval_decided` 是「审批路径等价」的唯一前提（S7-G1 第四阶段）
 *
 * `rebuildMessages` 重放一条 `awaiting_approval` 调用时，正文由**审批单状态**
 * 决定（`replayedToolResult`）：granted ⇒「请立即用完全相同的参数重新提交」、
 * denied ⇒「不得重试」、consumed ⇒「已执行过，勿重复提交」。这三句话直接改变
 * 模型下一步**动作**。
 *
 * 而在这条事件之前，审批状态的每一次翻转（`agent_approvals` 的 UPDATE）都
 * **不产生任何 `agent_events`**：事件流里根本没有「批了 / 拒了 / 用掉了」这个
 * 事实。于是事件投影只能退回「【等待人工审批】」，而快照侧在同一行上说
 * 「【已获批准】请立即重提」——**语义相反**（一个叫停、一个催执行）。这不是
 * 投影的实现缺陷，是**事实缺一种事件**；补上它，审批路径才有与快照同源的输入。
 *
 * 故意**不**在这条事件里放 `preview` / `argsDigest` / 参数 / 审批理由：投影
 * 重建文案不需要它们（文案只吃 `approvalKey` + `status` + `decidedBy`），而
 * 本表是长期保留的审计面，`approvalKey` 本身就是回到 `agent_approvals` 的
 * 引用键（要预览就按 key 回读那一行）。
 */
export const AGENT_EVENT_KINDS = [
  "step_appended",
  "tool_call_recorded",
  "tool_call_status_changed",
  "prompt_fingerprint",
  "session_finished",
  "approval_decided",
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/**
 * 每种事件的**因果规则**（A2）：因果来源 + 违反时会怎样。
 *
 * 这不是文档，是**判据表**：`scripts/check-agent-event-causation.mjs` 按
 * `required: true` 的条目逐个检查写入点有没有传 `causedBySeq`（漏传即红），
 * 所以「新增一种 kind」必须同时在这里登记一条规则——否则守卫报「kind 没有规则」。
 *
 * 三条纪律（读这张表前先记住）：
 *   ① `cause` 写的是**哪一种事件**；具体到「哪一条」由写入点精确解析（见
 *      `AgentSessionService` 的 `resolveCausationSeq`），**不靠时间邻近猜**；
 *   ② `required: false` 只允许两种理由：**没有单一前驱**（规则本身如此），或
 *      写入点当前拿不到（标注 `pending:`，由接线方补）；
 *   ③ `ifViolated` 必须写「不成立会怎样」——一条说不出后果的规则，等于没规则。
 */
export interface AgentEventCausationRule {
  /** 因果来源（人类的说法）。 */
  cause: string;
  /** 是否要求每个写入点都必须给出 `causedBySeq`（守卫判据①）。 */
  required: boolean;
  /** 因果缺失/错误时会怎样（**必填**，这是这条规则的验收面）。 */
  ifViolated: string;
}

export const AGENT_EVENT_CAUSATION_RULES: Record<
  AgentEventKind,
  AgentEventCausationRule
> = {
  step_appended: {
    cause: "无（用户/scheduler 触发整轮运行，不是某一条事件的结果）⇒ 恒为 NULL",
    required: false,
    ifViolated:
      "若硬塞一个前驱（比如上一条事件），事件流会声称「这一步是被上一条事件引起的」——`rebuildMessages` 靠 steps 顺序而非因果，语义无害，但因果图会多出 N 条**假边**，把「一条因果链」画成「一条链式假链」，取证时无法区分。",
  },
  tool_call_recorded: {
    cause: "请求这次调用的那个 step 的 `step_appended`",
    required: true,
    ifViolated:
      "缺这条边，『模型在哪一步决定调这个工具』只能靠 `agent_tool_calls.stepId` 回读台账行（而那列可空、且台账行会被就地更新）；模型若在同一批里调了多个工具，投影分不出它们属于同一步，因果图退化成 N 个孤立节点。",
  },
  tool_call_status_changed: {
    cause:
      "该调用的 `tool_call_recorded`（Temporal `ScheduledEventId` 口径：结果事件指向**发起事件**）；**当且仅当**本次迁移由审批决定直接触发（deny settle）时指向那条 `approval_decided`",
    required: true,
    ifViolated:
      "一次调用有多条状态迁移，缺边就只能按 `toolCallId` 归堆——『第 3 条是被第 2 条还是被审批引起的』分不出来，而这正是本案要回答的那个问题；配错边（指向别的调用）则会让投影把 A 的结果渲染成 B 的结果。",
  },
  prompt_fingerprint: {
    cause: "触发这次 LLM 调用的 `step_appended`（该轮请求的输入步）",
    required: true,
    ifViolated:
      "缺这条边，『第 N 轮的指纹喂给了哪一步』只能按 seq 邻近猜（同一进程里并发会话、旁路丢事件时都会猜错）⇒ 对账时『模型当时看到什么』与『事件说它看到了什么』无法对齐。",
  },
  session_finished: {
    cause:
      "无（终态是整轮运行的结论，或人工 abort；没有任何一条**事件**是它的单一前驱）⇒ 恒为 NULL",
    required: false,
    ifViolated:
      "若指向最后一条事件，会谎称「会话是因为那条事件结束的」——而真实原因可能是一条**没有事件**的外部动作（管理员 abort / 预算闸门）。这类假边比 NULL 坏：它把一个不可归因的结论伪装成可归因的。",
  },
  approval_decided: {
    cause:
      "需要审批的那个调用的 `tool_call_recorded`（`decide`）；`consume` 则是同一 `approvalKey` 上更早的那条 `approval_decided(granted)`",
    required: true,
    ifViolated:
      "缺这条边，审批决定与它对应的调用只能靠 `approvalKey` ↔ `agent_tool_calls.approvalId` 两跳反查（`approvalId` 可空、且同一张单可能被多行引用）⇒ 『这张单是为哪个调用开的』在多调用会话里不可判定，审批链（调用 → 申请 → 决定 → 执行）断成两段。",
  },
};

/** 待写入的事件（`seq`/`id`/`createdAt` 由 DB 或写入侧生成，不接受外部指定）。 */
export interface AgentEventInput {
  kind: AgentEventKind;
  payload?: Record<string, unknown> | null;
  /**
   * 因果边：引起本条事件的那条事件的 `seq`（同一会话内、且更小）。
   *
   * 三条写法纪律：
   *   · **规则要求有时必须传**（见 `AGENT_EVENT_CAUSATION_RULES`），值必须来自
   *     **精确引用解析**（`stepId` / `toolCallId` / `approvalKey` 这类唯一键），
   *     **不许**用「上一条事件的 seq」「最近的某条」这种时间邻近推断；
   *   · **解析不到唯一前驱时传 `null`**（或整体省略）——宁可承认不知道，也不写
   *     一条猜出来的边，否则库里再也分不清真指针与推断；
   *   · 省略与 `null` 在库里是同一件事（列可空），写 `null` 只是把「这条规则
   *     本来就没有前驱」写在调用点上，便于人读。
   */
  causedBySeq?: number | null;
}

/**
 * 事件正文的**单条** UTF-8 字节上限（2 KiB）。
 *
 * 为什么是 2 KiB：`agent_steps.content` / `agent_tool_calls.resultJson` 都是
 * `text`/`jsonb`，一条长工具输出可以到兆级；而事件表是**长期保留**的取证面，
 * 单行无界会让「按会话翻页取证」变成「把日志仓库整段搬出来」。2 KiB 覆盖绝大
 * 多数「模型当时看到的那句话」（工具结果回给模型的那份本身另经
 * `TOOL_RESULT_MAX_CHARS=2000` 裁剪），也与审批预览的 2 KiB 预算同量级。
 *
 * ## 为什么必须**小于 4000**（不是随手取的数）
 * 脱敏实现（`tools/agent-sanitize.util.ts` 的 `sanitizeString`）自己带一条
 * 「单字段 4000 字符」上限——它在我们之前就已经会裁文本。若本上限 ≥ 4000，
 * 一条 10 MB 的 ASCII 正文会被脱敏器先裁到 4000 字符（= 4000 字节），**恰好
 * 落进**本上限之内，于是 `truncated` 永远是 false：裁剪发生了，标记却没有。
 * 「字符数 ≤ 字节数」是 UTF-8 的恒等式，所以只要本上限 < 4000，被脱敏器裁过
 * 的文本必然 ≥ 4000 字节 > 本上限 ⇒ 必然走截断分支、必然带标记。这条不变式
 * 是「不许静默截断」的机制保证，不是注释里的承诺。
 */
export const AGENT_EVENT_BODY_MAX_BYTES = 2048;

/**
 * 单条正文的**信封**形状（`payload.body.<slot>` 的唯一载体）。
 *
 * 四个字段缺一不可，理由逐个写清（这是「可断言」的全部依据）：
 *   · `text`：脱敏 + 截断后的正文。这是唯一可读副本。
 *   · `bytes`：`text` 的 UTF-8 字节数。有它才不必在断言/读侧重算编码。
 *   · `originalBytes`：**截断前**的 UTF-8 字节数（脱敏前的原文；见
 *     `toAgentEventBody` 的 max 说明）。没有它，「截掉了多少」只能靠猜——而取证时
 *     「原文有多长」本身是事实（一条 2 MB 的日志被截到 2 KiB，与一条本来就只有
 *     1.5 KiB 的日志，是两个不同的世界）。
 *   · `truncated`：是否截断。**唯一的标记位**：不写进正文里（不追加
 *     `…[truncated]` 这类尾缀），因为尾缀会污染 `text` 的字节可比性，让「正文
 *     等于原文」在未截断时也不成立。标记放在信封上，机器可断言、人也能看见。
 */
export interface AgentEventBody {
  text: string;
  bytes: number;
  originalBytes: number;
  truncated: boolean;
}

/**
 * 事件的正文槽位（`payload.body`）。
 *
 * 为什么按「槽位」而不是每个 kind 一套形状：三种正文（步正文 / 工具结果 /
 * 错误文案）的**截断与脱敏语义必须完全一致**，只有名字不同。放在同一个包里，
 * 定义只有一处，读侧不必猜「这个 kind 的正文字段叫什么」。
 */
export interface AgentEventBodyBag {
  /** `step_appended`：该步 `agent_steps.content`。 */
  content?: AgentEventBody | null;
  /** `tool_call_recorded` / `tool_call_status_changed`：`agent_tool_calls.resultJson`。 */
  result?: AgentEventBody | null;
  /** `tool_call_recorded` / `tool_call_status_changed`：`agent_tool_calls.errorMessage`。 */
  error?: AgentEventBody | null;
}

/**
 * 按字节截断（保证不切在多字节字符中间）。
 *
 * `Buffer.subarray` 是**字节**操作：直接 `subarray(0, max).toString("utf8")` 在
 * 汉字/emoji 边界上会留下 U+FFFD（`�`），让「截断后的正文」本身变成一条不可信
 * 文本。所以先退到字符起始字节（UTF-8 续字节形如 `10xxxxxx`），再解码。
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * 把**已脱敏**的正文包成事件正文（超 `AGENT_EVENT_BODY_MAX_BYTES` 即截断 + 标记）。
 *
 * 为什么入参要求「已脱敏」而不是在这里脱敏：脱敏是**规则**（有单一实现，见
 * `tools/agent-sanitize.util.ts`），本文件是**形状**定义。形状不该 import 规则，
 * 否则 entity ↔ tools 又是一条无谓的依赖边；也让本函数可以纯粹按字节断言。
 *
 * `rawText` 是**脱敏前**的原文（可省略）：`originalBytes` 取「原文与脱敏后
 * 的较大者」。为什么取 max 而不是直接取脱敏后长度——两种偏差都要挡住：
 *   · 脱敏器自带的 4000 字符上限会先把 10 MB 原文裁成 4000 字符，若 `originalBytes`
 *     只算脱敏后的长度，报文就会谎称「原文 4 KB」（真实是 10 MB）；
 *   · 打码串（`[REDACTED]`）可能比被替换的秘密**更长**，此时脱敏后反而更长，
 *     取原文长度会得出 `originalBytes < bytes` 这种自相矛盾的形状。
 * 取 max 后不变式恒成立：`originalBytes >= bytes`，且 `bytes === text 的字节数`。
 */
export function toAgentEventBody(
  sanitizedText: string,
  rawText?: string,
): AgentEventBody {
  const sanitizedBytes = Buffer.byteLength(sanitizedText, "utf8");
  const originalBytes = Math.max(
    sanitizedBytes,
    Buffer.byteLength(rawText ?? sanitizedText, "utf8"),
  );
  if (sanitizedBytes <= AGENT_EVENT_BODY_MAX_BYTES) {
    return {
      text: sanitizedText,
      bytes: sanitizedBytes,
      originalBytes,
      truncated: false,
    };
  }
  const text = truncateUtf8(sanitizedText, AGENT_EVENT_BODY_MAX_BYTES);
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    originalBytes,
    truncated: true,
  };
}
