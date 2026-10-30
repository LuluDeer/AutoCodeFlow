import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from "typeorm";

// R-19（DEEP_REVIEW 0ef3bbe）: 原此处声明的
// @Index("idx_audit_log_detail_gin", ["detail"]) 是死声明——synchronize=false
// 下实体装饰器不物化，全部迁移（含 InitialSchema 裸 JSONB 列）均未创建该 GIN
// 索引，且查询面（audit.service）从未用 @> 包含操作符。保留死声明会误导后来者
// 以为存在覆盖索引。已移除（零迁移）；如未来确需 detail  containment 查询，
// 应经正式迁移 CREATE INDEX ... USING GIN 后再在此补回声明。
// PK-16: 管理台按 action 过滤 + createdAt DESC 排序的复合索引（迁移
// 1790000000022；单列 idx_audit_logs_action 由迁移 1717473142683 建）
@Index("idx_audit_logs_action_created_at", ["action", "createdAt"])
// db-2 残差：keyset/OFFSET 两条分页路径的排序是 `createdAt DESC, id DESC`，
// 复合索引与排序同形（迁移 1790000000082，CONCURRENTLY 建；先例
// idx_tasks_created_at_id / 迁移 1790000000075）。列序即 keyset 元组序：
// 反过来（id, createdAt）无法用同一个索引序满足 `(createdAt, id) < (…)`。
// 注意迁移里两列都带 DESC，此处 @Index 只声明列序（TypeORM 的规范不带方向）。
@Index("idx_audit_logs_created_at_id", ["createdAt", "id"])
@Entity("audit_logs")
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  @Index()
  userId: number;

  @Column({ nullable: true })
  username: string;

  @Column()
  action: string;

  @Column({ nullable: true })
  resource: string;

  @Column({ nullable: true })
  resourceId: string;

  @Column({ type: "jsonb", nullable: true })
  detail: Record<string, any>;

  @Column({ nullable: true })
  ip: string;

  @Column({ default: "success" })
  result: string;

  @CreateDateColumn()
  @Index()
  createdAt: Date;
}
