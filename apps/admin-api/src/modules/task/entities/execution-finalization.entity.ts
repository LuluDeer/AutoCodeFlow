import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * S3-C5（P0 · 数据丢失档）：**持久化收尾协调记录**（一次执行一行）。
 *
 * 表结构与选型理由写在迁移 `1790000000084-AddExecutionFinalizationGuard.ts`
 * 头注（可访问性、生命周期、竞争面、paperclip 对齐四点）。这里只补三件读代码
 * 时最需要知道的事：
 *
 * 1. **为什么 `executionId` 是主键**：一次执行对应一行（对齐 paperclip
 *    `native_run_finalizations` 的 `runId` 主键）。`attempt` 与 `recoveryHistory`
 *    都在这**同一行**上累加，不产生「一行一次尝试」的行数膨胀。
 * 2. **为什么写路径刻意用原始 SQL**：门禁（是否存在更新的执行 / 任务是否被别的
 *    在跑执行占用 / 是否有活跃租约）必须与状态写**在同一条语句的 WHERE 里**原子
 *    求值，且 `attempt` 自增与 `recoveryHistory` 追加必须由 DB 完成（不能
 *    `findOne → save`，那是 TOCTOU + 整列回写）。本实体存在的意义是
 *    **schema 的代码面声明**：让 `migration:generate` 不会把这张表当成「实体里
 *    没有的表」而生成 DROP，并让索引声明与 DDL 对齐（`check-index-drift`）。
 * 3. **`recoveryHistory` 里有什么**：`stale_finalization`（本次收尾赢下的证据）
 *    与 `finalization_deferred`（判据拒绝收尾、行仍 RUNNING 的证据）两类条目。
 */
@Entity("execution_finalizations")
// 运维排障：按任务列出有收尾协调记录的执行（与迁移 DDL 同名同列，见 check-index-drift）。
@Index("idx_execution_finalizations_task_id", ["taskId"])
export class ExecutionFinalization {
  /** 被收尾的执行 id（= `task_executions.id`，1:1；随执行级联删除）。 */
  @PrimaryColumn("uuid") executionId: string;

  /**
   * 冗余的任务 id（快照语义，**不加 FK**）：sweep 的门禁子查询只按执行维度走，
   * 本列服务运维查询「这个任务下哪些执行已留收尾记录」。
   */
  @Column({ type: "uuid" }) taskId: string;

  /**
   * 收尾尝试序号（0 起，upsert 时由 SQL `attempt + 1` 自增，无读改写）。
   * 与 `task_executions.retryCount`（业务重试预算）语义不同：它数的是「这条执行
   * 被收尾过几次」——FAILED 可被 processor 重新 claim（legacy 语义），一条执行
   * 可能经历多个「打开态 → 终态」回合，每回合恰好 +1。
   */
  @Column({ type: "int", default: 0 }) attempt: number;

  /**
   * 收尾租约持有者（`<hostname>:<pid>`）。多副本下证明「是本实例收的尾」，并作为
   * 门禁的比较对象（另一个持有未过期租约的收尾者会挡住本次）。
   */
  @Column({ type: "varchar", length: 255, nullable: true })
  leaseOwner: string | null;

  /**
   * 租约到期时刻（收尾那一刻取 now + 30s）。**刻意短于 stale 扫描最小阈值（60s）**：
   * 既能挡住并发的第二个收尾者，又不可能把同一条执行的下一回合挡在门外。
   */
  @Column({ type: "timestamptz", nullable: true })
  leaseExpiresAt: Date | null;

  /**
   * 控制面进程启动标识（每次 boot 一个随机值）。区分「同一实例重启后」与
   * 「同一进程内」，让陈旧租约/陈旧收尾记录可追溯到具体那次 boot
   * （对齐 paperclip 的 controllerBootId）。
   */
  @Column({ type: "varchar", length: 64, nullable: true })
  controllerBootId: string | null;

  /** 收尾历史（jsonb 数组，只追加不回改；条目类型见 ExecutionFinalizationHistoryEntry）。 */
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  recoveryHistory: ExecutionFinalizationHistoryEntry[];

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

/**
 * `recoveryHistory` 里的一条证据（`kind` 判别）：
 *
 * - `stale_finalization`：本次清扫**赢得**该行的收尾（与终态同一事务写入），
 *   因此「恰好一条」由终态门的 winner 语义保证，不靠应用层去重。
 * - `finalization_deferred`：门禁**拒绝**收尾时刻的记录（行状态保持 RUNNING
 *   不变，也不写租约）。同一（原因 + successor）的重复拒绝会被
 *   `recoveryHistory @> :deferralKey` 折叠成一条，避免每个 tick 追加。
 */
export interface ExecutionFinalizationHistoryEntry {
  kind: "stale_finalization" | "finalization_deferred";
  /** 收尾结果桶：timeout / stale_recovered（deferred 条目记录其所属桶）。 */
  outcome?: string;
  /** 拒绝原因：newer_execution_exists / task_occupied_by_another_run / lease_held。 */
  reason?: string;
  /** 拒绝时点名的「更新工作」执行 id（门禁里 createdAt >= 本行的那条）。 */
  successorExecutionId?: string;
  /** 本条目写入时点的尝试序号（finalization 条目）。 */
  attempt?: number;
  leaseOwner?: string;
  controllerBootId?: string;
  executionId?: string;
  /** ISO 时刻字符串（写进 jsonb，避免驱动对 Date 的序列化差异）。 */
  at: string;
}
