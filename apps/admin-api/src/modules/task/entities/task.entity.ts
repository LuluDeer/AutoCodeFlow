import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum TaskStatus { ACTIVE = 'active', PAUSED = 'paused', DELETED = 'deleted' }
export enum BlockStrategy { SERIAL = 'serial', DISCARD = 'discard' }
export enum MisfireStrategy { IGNORE = 'ignore', FIRE_ONCE = 'fire_once' }
export enum TaskTriggerType { CRON = 'cron', FIXED_RATE = 'fixed_rate', API = 'api', MANUAL = 'manual' }
export enum TaskRuntime { PYTHON = 'python', NODE = 'node', SHELL = 'shell' }

@Entity('tasks')
export class Task {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() name: string;
  @Column({ nullable: true }) description: string;
  @Column({ type: 'enum', enum: TaskStatus, default: TaskStatus.ACTIVE }) status: TaskStatus;
  @Column({ type: 'enum', enum: TaskTriggerType }) triggerType: TaskTriggerType;
  @Column({ nullable: true }) cronExpression: string;
  @Column({ nullable: true }) fixedRate: number;
  @Column({ type: 'enum', enum: TaskRuntime, default: TaskRuntime.PYTHON }) runtime: TaskRuntime;
  @Column({ nullable: true }) runtimeVersion: string;
  @Column({ type: 'jsonb', nullable: true }) dependencies: Record<string, string>;
  @Column({ nullable: true }) entrypoint: string;
  @Column({ nullable: true }) gitRepo: string;
  @Column({ nullable: true }) gitBranch: string;
  @Column({ nullable: true }) gitCommit: string;
  @Column({ nullable: true }) currentVersion: string;
  @Column({ type: 'int', default: 0 }) timeout: number;
  @Column({ type: 'int', default: 3 }) maxRetry: number;
  @Column({ type: 'enum', enum: BlockStrategy, default: BlockStrategy.SERIAL }) blockStrategy: BlockStrategy;
  @Column({ type: 'enum', enum: MisfireStrategy, default: MisfireStrategy.IGNORE }) misfireStrategy: MisfireStrategy;
  @Column({ nullable: true }) lastTriggerTime: Date;
  @Column({ nullable: true }) alarmEmail: string;
  @Column({ type: 'simple-array', nullable: true }) alarmChannels: string[];
  @Column({ type: 'jsonb', nullable: true }) params: Record<string, any>;
  @Column({ nullable: true }) executorAppName: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
