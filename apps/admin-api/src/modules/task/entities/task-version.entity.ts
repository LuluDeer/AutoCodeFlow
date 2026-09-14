import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("task_versions")
// PK-11: (taskId, version) 唯一约束——并发 saveVersion 的 MAX+1 竞态可产生
// 重复版本行；由迁移 1790000000021 建唯一索引（并回收旧非唯一索引
// idx_task_versions_taskId_version），此处与迁移索引名同步。
@Index("ux_task_versions_taskId_version", ["taskId", "version"], {
  unique: true,
})
export class TaskVersion {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  taskId: string;

  @Column()
  version: string;

  @Column({ nullable: true })
  gitCommit: string;

  @Column({ type: "jsonb" })
  snapshot: Record<string, any>;

  @Column({ nullable: true })
  createdBy: string;

  @Column({ nullable: true })
  description: string;

  @CreateDateColumn()
  createdAt: Date;
}
