import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * R302 / TTFV 阶段2：`funnel_events` 的 TypeORM 投影。
 *
 * 物理列名保持方案 §4.2 / §4.3 的 snake_case（`install_id` / `event_name` / ...），
 * TS 属性用 camelCase，与同域实体的代码风格一致。表是 append-only：只有 `ts` 与
 * `createdAt`，没有 `updatedAt`；事实行落库后不再改写。
 *
 * 复合索引 `(install_id, event_name)` 与唯一索引 `dedupe_key` 由迁移
 * `1790000000101` 建立（`synchronize=false`）。这里不再声明 `@Index`：TypeORM 的
 * `@Index` 列写的是属性路径（`installId`），迁移 DDL 用的是物理列名（`install_id`），
 * 两套命名同时声明会给 index-drift 守卫制造假漂移。实体只负责列投影，DDL 是索引事实源。
 */
@Entity("funnel_events")
export class FunnelEvent {
  /** 代理主键；事实身份由 `dedupeKey` 承担，uuid 只给单条事件一个引用句柄。 */
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 安装维度身份；对应方案中的 `install_id`。 */
  @Column({ name: "install_id", type: "varchar", length: 128 })
  installId: string;

  /** 事件名闭集由写入侧收口；TTFV 读取 `install_completed` / `task_first_attempted`（激活，R318）/ `task_first_success`（TTFV 中位数）。 */
  @Column({ name: "event_name", type: "varchar", length: 64 })
  eventName: string;

  /** 任务 id 的哈希；可空 = 该事件没有任务维度。 */
  @Column({
    name: "task_id_hash",
    type: "varchar",
    length: 128,
    nullable: true,
  })
  taskIdHash: string | null;

  /** 执行 id 的哈希；可空 = 该事件没有执行维度。 */
  @Column({
    name: "execution_id_hash",
    type: "varchar",
    length: 128,
    nullable: true,
  })
  executionIdHash: string | null;

  /** 事件发生时刻；TTFV 的分子由 `ts` 差直接导出。 */
  @Column({ name: "ts", type: "timestamptz" })
  ts: Date;

  /** 幂等身份；唯一索引在 DB 层把重复投递收敛成一行。 */
  @Column({ name: "dedupe_key", type: "varchar", length: 255 })
  dedupeKey: string;

  /** 入库时刻；只用于排障与清理窗口，与业务事件时刻 `ts` 分离。 */
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
