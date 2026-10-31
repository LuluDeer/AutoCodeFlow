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
  /** 已批准——闸门据此放行**一次**，执行体在副作用之前原子领取（consume）。 */
  "granted",
  /** 已领取并执行过——一张批准单只能用一次；同一调用重放需重新申请。 */
  "consumed",
  /** 已拒绝——不自动恢复会话；重放同一调用按 denied 终局回给模型。 */
  "denied",
  /**
   * 已超时（`AGENT_APPROVAL_TTL_MS` 内无人工处置）——由维护扫描收口。
   *
   * 为什么需要它：pending 单没有 TTL 时，没人点的审批会让会话**永久**
   * waiting_input（既不会执行、也不会失败），运营看板上是一条永远挂着的
   * 「待审批」。expired 与 denied 语义不同：denied 是人的决定，expired 是
   * 系统因超时给出的结论——两者都不可执行，但排查时能区分「谁关的」。
   */
  "expired",
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
   * 申请幂等键（= agent_tool_calls.approvalId，`apr-<sessionId>-<指纹>`）。
   *
   * **确定性**（实施轮 #14 修）：指纹 = sha256(toolName + 规范化参数) 前 16 位。
   * 原实现用 `Date.now()`，同一调用的每次重试都得到新键 ⇒「唯一约束保证重试
   * 幂等」不成立（23505 分支是死代码），pending 行随重试线性堆积，且「管理员
   * 批准的那张单」与「模型正在等的调用」永远对不上。同参重试必须命中同一行：
   * 这是「批准 → 恢复 → 重放同一调用 → 真的执行」整条链能成立的前提。
   *
   * 与 tool_call 表的关联是**逻辑外键**（varchar 而非 uuid 列）：键由
   * requestApproval 生成，先落审批单后落调用行（「先落盘后发送」同款纪律），
   * 用 uuid 外键会把写入顺序锁死。唯一约束保证同参重试不产生第二张单。
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

  /**
   * 被批对象的参数摘要 = `sha256(canonicalJson(args))`（64 位 hex）。
   *
   * **与 `approvalKey` 同源的规范化口径**（`agent-approvals.service.ts` 的
   * `canonicalJson`）：键自身是 `apr-<sessionId>-<sha256(toolName|规范化参数) 前 16 位>`，
   * 这里存**完整** 64 位摘要，供事后对账「当时批准的那组参数」是否就是重放的那组
   * ——批准后会话恢复、模型重提同一调用必须命中同一 key，而 key 只留了 16 位
   * 前缀，不足以做等值校验以外的任何事。
   *
   * NULL 只有一种语义：**本列上线前创建的审批单**（S1-C3，迁移 1790000000085）。
   * 存量行不回填——申请时没有采集这个事实，回填等于伪造审批证据。新行必非空
   * （`args` 为 null 时 `canonicalJson(null) === "null"`，仍是确定值）。
   */
  @Column({ type: "varchar", length: 64, nullable: true })
  argsDigest: string | null;

  /**
   * 人类可读的参数预览（**已脱敏 + 已截断**，S1-C3）。
   *
   * 内容 = `{ truncated, omittedBytes?, args }` 的 JSON 文本，`args` 是
   * `sanitizeArgs` 脱敏后的规范化 JSON 字符串：审批卡片把它渲染成只读键值视图。
   * 两条硬约束（preview 是一条新泄密面）：
   *   · 脱敏走**既有** `sanitizeArgs`（键名命中 SECRET_KEYS_RE + env/Bearer/hex
   *     样式串），不新写第二套规则——否则两处规则迟早漂移；
   *   · 总长超过 2KB 必须截断并置 `truncated:true`（不静默丢），长字符串值只留
   *     字段名 + 长度 + 摘要，**不落可执行脚本全文**。
   *
   * NULL = 该单创建于本列上线前，或本次调用无参数（`args == null`）。前者读面
   * 显示「旧审批单无预览」，不得显示成「这次调用没有参数」。
   */
  @Column({ type: "text", nullable: true })
  preview: string | null;

  @Column({ type: "varchar", length: 16, default: "pending" })
  status: AgentApprovalStatus;

  /** 处置人（JWT sub）。NULL = 尚未处置。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  decidedBy: string | null;

  @Column({ type: "timestamptz", nullable: true })
  decidedAt: Date | null;

  /**
   * 领取（= 副作用真的开始执行）时刻。NULL 有两种语义，且都重要：
   *   · 还没被领取（pending / granted 卡住 / denied）——**「批准了但从未执行」
   *     正是审计要能看见的那一类**；
   *   · 迁移 1790000000068 之前的 consumed 行（当时无此列，不臆造回填）。
   *
   * 与 decidedAt 分开记的理由：批准人与执行者不是同一个主体，批准到执行之间
   * 可能隔几分钟也可能隔一天，合并成一列就再也算不出这段时延。
   */
  @Column({ type: "timestamptz", nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
