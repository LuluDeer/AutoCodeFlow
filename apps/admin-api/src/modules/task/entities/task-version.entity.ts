import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

@Entity("task_versions")
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
