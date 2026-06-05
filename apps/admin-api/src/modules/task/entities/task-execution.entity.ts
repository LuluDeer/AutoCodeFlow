import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum ExecutionStatus {
  PENDING = 'pending', RUNNING = 'running', SUCCESS = 'success',
  FAILED = 'failed', TIMEOUT = 'timeout', KILLED = 'killed',
  CANCELLED = 'cancelled',
}

@Entity('task_executions')
@Index(['taskId'])
@Index(['status'])
@Index(['taskId', 'status'])
export class TaskExecution {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() taskId: string;
  @Column() taskName: string;
  @Column({ type: 'enum', enum: ExecutionStatus, default: ExecutionStatus.PENDING }) status: ExecutionStatus;
  @Column({ nullable: true }) executorAddress: string;
  @Column({ type: 'text', nullable: true }) logs: string;
  @Column({ type: 'jsonb', nullable: true }) result: Record<string, any>;
  @Column({ type: 'jsonb', nullable: true }) params: Record<string, any>;
  @Column({ nullable: true }) startTime: Date;
  @Column({ nullable: true }) endTime: Date;
  @Column({ nullable: true }) duration: number;
  @Column({ type: 'int', default: 0 }) retryCount: number;
  @Column({ nullable: true }) errorMessage: string;
  @Column({ type: 'text', nullable: true }) aiAnalysis: string;
  @Column({ nullable: true }) triggerType: string;
  @Column({ nullable: true }) taskVersion: string;
  @CreateDateColumn() createdAt: Date;
}
