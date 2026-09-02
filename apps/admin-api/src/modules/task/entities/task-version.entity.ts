import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("task_versions")
@Index("idx_task_versions_taskId_version", ["taskId", "version"])
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
