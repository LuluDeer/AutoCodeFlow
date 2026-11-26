import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** N15 / GCO §11：一次能力激活的落证结果。 */
export const ACTIVATION_RESULTS = ["success", "failure", "blocked"] as const;
export type ActivationResult = (typeof ACTIVATION_RESULTS)[number];

/**
 * N5：业务结果归因状态（查询侧 `outcome` 过滤的取值）。
 *
 * 与 `result`（success/failure/blocked，描述**调用是否达成**）正交：outcome
 * 描述**这次调用是否产生了被确认的业务改进**。confirmed → 命中间接列
 * confirmed=true；unconfirmed → confirmed=false。显式取值，不用裸 boolean，
 * 让查询契约在 OpenAPI / DTO 上自解释。
 */
export const ACTIVATION_OUTCOMES = ["confirmed", "unconfirmed"] as const;
export type ActivationOutcome = (typeof ACTIVATION_OUTCOMES)[number];

/**
 * N15「运行时能力审计」：`capability_activation_log` 表。
 *
 * 一行 = 一次 capability 的运行时激活。回答「本月哪个会话用了财务导出」这类
 * 企业必问问题。与 `audit_logs` 的分工：
 *
 * - `audit_logs` 记「谁在管理面做了什么配置变更」（低频、强审计）；
 * - 本表记「某个 capability 在运行时被调用了多少次、谁/哪个会话/哪个项目触发」
 *   （高频、专表）。**不写 AuditService**，否则高频激活会淹没写审计。
 *
 * 关键设计：
 * - `capabilityKey` **不设 FK**：能力可能被删除，但历史激活事实必须留存；
 * - `capabilityVersion` 钉死版本，供 N16 归责；
 * - `parametersDigest` 只存确定性摘要，**不落明文参数**（参数可能含敏感数据）；
 * - `userId`/`username` 与 `imPlatform`/`imSenderId` 两组身份来源并存，后者与
 *   `im_identities` 的双字段口径呼应（但同样不设 FK）；
 * - **append-only**：无 UpdateDateColumn，服务层只暴露 append + 只读查询，
 *   不提供 update/delete 端点（见 service 头注与迁移 1790000000105）。
 *
 * 索引（迁移 1790000000105）：
 * - (capabilityKey, createdAt)：按能力 + 时间倒查（看板主路径）；
 * - (userId, createdAt)：按平台用户倒查；
 * - (projectId, createdAt)：按项目 showback；
 * - (sessionId)：定位某个 Workbench/SOP 会话的全部激活。
 */
@Entity("capability_activation_log")
@Index("idx_cap_activation_key_created_at", ["capabilityKey", "createdAt"])
@Index("idx_cap_activation_user_created_at", ["userId", "createdAt"])
@Index("idx_cap_activation_project_created_at", ["projectId", "createdAt"])
@Index("idx_cap_activation_session", ["sessionId"])
export class CapabilityActivationLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 用了哪个能力（稳定 key；不 FK——能力删除后日志仍留存）。 */
  @Column({ type: "varchar", length: 128 })
  capabilityKey: string;

  /** 激活时的能力版本（钉死；N16 归责基础）。 */
  @Column({ type: "varchar", length: 32, nullable: true })
  capabilityVersion: string | null;

  /** 哪个 Workbench/SOP 会话触发。 */
  @Column({ type: "varchar", length: 128, nullable: true })
  sessionId: string | null;

  /** 参数摘要 sha256 hex；**明文参数永不落库**。 */
  @Column({ type: "varchar", length: 64 })
  parametersDigest: string;

  @Column({ type: "int", nullable: true })
  userId: number | null;

  @Column({ type: "varchar", nullable: true })
  username: string | null;

  /** IM 来源；与 im_identities 的 (platform, imSenderId) 双字段口径呼应。 */
  @Column({ type: "varchar", length: 16, nullable: true })
  imPlatform: string | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  imSenderId: string | null;

  /** 归属项目（可空 = 未分配），供按项目 showback。 */
  @Column({ type: "varchar", nullable: true })
  projectId: string | null;

  @Column({ type: "varchar", length: 16, default: "success" })
  result: ActivationResult;

  /** N5：基线指标名（业务结果归因）；NULL 表示未采集基线。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  baselineMetric: string | null;

  /** N5：相对基线的改进量 numeric(12,2)；NULL 表示未量化。 */
  @Column({ type: "numeric", precision: 12, scale: 2, nullable: true })
  improvement: number | null;

  /** N5：业务结果是否已确认；schema default false，service 缺省也落 false。 */
  @Column({ type: "boolean", nullable: true, default: false })
  confirmed: boolean | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}
