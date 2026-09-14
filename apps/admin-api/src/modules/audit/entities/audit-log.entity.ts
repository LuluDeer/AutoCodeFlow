import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from "typeorm";

// D-04: GIN index on the jsonb `detail` column for fast containment queries (@> operator)
@Index("idx_audit_log_detail_gin", ["detail"])
// PK-16: 管理台按 action 过滤 + createdAt DESC 排序的复合索引（迁移
// 1790000000022；单列 idx_audit_logs_action 由迁移 1717473142683 建）
@Index("idx_audit_logs_action_created_at", ["action", "createdAt"])
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
