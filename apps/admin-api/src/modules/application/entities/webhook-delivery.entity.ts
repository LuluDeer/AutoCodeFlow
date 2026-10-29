import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * SEC-3：应用发布 webhook 的**投递幂等账本**。
 *
 * 现状缺口（application.controller 的 webhook handler）：`x-autoflow-delivery`
 * 幂等键只被接收、从不参与判定，于是调用方按 GitHub 惯例用同一 delivery id
 * 重试时，每次都会重写应用版本并（`triggerDeploy`）对所有 RUNNING 部署**再发起
 * 一轮滚动升级**——一次网络抖动 = 一次重复发布。
 *
 * ## 为什么落库而不是内存/Redis
 * 需要跨实例、跨进程重启去重，且窗口是**天级**（调用方重试可能隔几小时）；
 * 进程内 Map 在多副本下退化为「N 副本各放行一次」，Redis TTL 窗在重启/主从切换
 * 时也可能丢失。本表用**唯一约束**做仲裁：数据库是唯一能对并发 INSERT 给出
 * 「谁赢」确定答案的地方。
 *
 * ## 键的语义
 * `(scope, deliveryKey)` 唯一。`scope` 本期固定 `app_release`（见
 * `WEBHOOK_DELIVERY_SCOPE_APP_RELEASE`），为将来其它 webhook 面复用同一张表
 * 留出命名空间——不同 scope 的相同 key 必须互不干扰。
 *
 * `expiresAt` 是**保留期**（默认 7 天，`WEBHOOK_DELIVERY_TTL_DAYS` 可配）：
 * 过期行由 retention sweep 分批删除；同时 claim 语句把「过期行」视为可重新占用
 * （`ON CONFLICT ... WHERE expiresAt < now()`），所以清理滞后不会把某个 key
 * 永久锁死——过期后同键可再次 claim。
 *
 * `appId` 刻意**不带外键**：账本是历史事实，应用删除后仍需保留到期满（与
 * `app_deployment_events.deploymentId` 同款「事件比行活得久」的取舍）。
 */
export const WEBHOOK_DELIVERY_SCOPE_APP_RELEASE = "app_release";

@Entity("webhook_deliveries")
@Index("uq_webhook_deliveries_scope_delivery_key", ["scope", "deliveryKey"], {
  unique: true,
})
@Index("idx_webhook_deliveries_expires_at", ["expiresAt"])
export class WebhookDelivery {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 投递面命名空间：本期固定 `app_release`。 */
  @Column({ type: "varchar", length: 32 })
  scope: string;

  /** 调用方投递 id（`x-autoflow-delivery`，trim 后非空才落账本）。 */
  @Column({ type: "varchar", length: 128 })
  deliveryKey: string;

  /** 关联应用（不加外键，见类注释）；调用方未绑定应用时为 null。 */
  @Column({ type: "uuid", nullable: true })
  appId: string | null;

  /** 首次接收时间（过期后同键再次 claim 会刷新为新的接收时刻）。 */
  @CreateDateColumn({ type: "timestamptz" })
  receivedAt: Date;

  /** 该键的去重窗口终点；`< now()` 即过期，可被重新占用并被 retention 删除。 */
  @Column({ type: "timestamptz" })
  expiresAt: Date;
}
