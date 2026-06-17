import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

@Entity("execution_reports")
@Index(["triggerDay"], { unique: true })
export class ExecutionReport {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "date" })
  triggerDay: Date;

  @Column({ default: 0 })
  runningCount: number;

  @Column({ default: 0 })
  successCount: number;

  @Column({ default: 0 })
  failCount: number;

  @Column({ default: 0 })
  timeoutCount: number;

  @Column({ default: 0 })
  cancelledCount: number;

  @Column({ type: "float", default: 0 })
  avgDurationMs: number;

  @Column({ type: "float", default: 0 })
  maxDurationMs: number;

  @Column({ type: "float", default: 0 })
  minDurationMs: number;

  @UpdateDateColumn()
  updateTime: Date;

  @CreateDateColumn()
  createdAt: Date;
}
