import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * R305 / TTFV opt-in 授权闸门：`telemetry_optin` 的 TypeORM 投影。
 *
 * ## 为什么一个 install 只有一行
 *
 * 授权是「安装实例」的属性，不是事件流：同一 install 反复 grant/revoke 改写的是
 * **当前状态**，而不是追加历史事实。物理层由迁移 0102 的唯一索引
 * `uq_telemetry_optin_install_id` 仲裁，写入侧走 upsert，多副本/重试收敛到一行。
 *
 * ## 为什么没有 updatedAt
 *
 * 状态变更的时点由 `optedAt` 承载（它记的是「最近一次授权/撤销的时刻」），
 * 再放一个 `updatedAt` 只是同一个事实的第二份真相。`createdAt` 只用于排障，
 * 不参与任何判定。
 *
 * ## 为什么 userIdHash 可空
 *
 * install 先有授权动作、后绑定登录主体是正常路径（匿名安装 → 登录绑定）；
 * 而且授权判定只认 install 维度，绝不因为缺用户维度就误判成已授权。
 *
 * 索引不在实体里声明：物理列名是 snake_case，TypeORM `@Index` 写的是属性路径，
 * 两套命名同时声明会给 index-drift 守卫制造假漂移。DDL 是索引事实源（同 FunnelEvent）。
 */
@Entity("telemetry_optin")
export class TelemetryOptin {
  /** 代理主键；业务身份是 `installId` 上的唯一索引。 */
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 安装维度身份；对应方案中的 `install_id`。 */
  @Column({ name: "install_id", type: "varchar", length: 128 })
  installId: string;

  /** 用户匿名 id 的哈希（R304 派生能力）；可空 = 尚未绑定登录主体。 */
  @Column({
    name: "user_id_hash",
    type: "varchar",
    length: 128,
    nullable: true,
  })
  userIdHash: string | null;

  /** 当前授权状态；false 是显式撤销，不是「没登记」。 */
  @Column({ name: "opt_in", type: "boolean" })
  optIn: boolean;

  /** 最近一次授权/撤销时刻；状态变更的唯一时点事实。 */
  @Column({ name: "opted_at", type: "timestamptz" })
  optedAt: Date;

  /** 授权动作来源（安装向导 / 设置页 / revoke 等），用于追溯谁改的状态。 */
  @Column({ name: "source", type: "varchar", length: 64 })
  source: string;

  /** 入库时刻；只用于排障，与业务时点 `optedAt` 分离。 */
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
