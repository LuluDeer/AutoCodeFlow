import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum ExecutorStatus { ONLINE = 'online', OFFLINE = 'offline' }
export enum ExecutorType { PYTHON = 'python', NODE = 'node', UNIVERSAL = 'universal' }

@Entity('executors')
export class Executor {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() appName: string;
  @Column() address: string;
  @Column({ type: 'enum', enum: ExecutorStatus, default: ExecutorStatus.OFFLINE }) status: ExecutorStatus;
  @Column({ type: 'enum', enum: ExecutorType, default: ExecutorType.PYTHON }) type: ExecutorType;
  @Column({ nullable: true }) version: string;
  @Column({ type: 'simple-array', nullable: true }) capabilities: string[];
  @Column({ nullable: true }) lastHeartbeat: Date;
  @Column({ type: 'int', default: 0 }) runningTaskCount: number;
  @Column({ type: 'float', nullable: true }) cpuUsage: number;
  @Column({ type: 'float', nullable: true }) memUsage: number;
  /** Max concurrent tasks this executor may run simultaneously (null = unlimited). */
  @Column({ type: 'int', nullable: true }) maxConcurrentTasks: number | null;
  /**
   * SEC-03: per-executor token stored as bcrypt hash.
   * Rotated via POST /api/executors/:id/rotate-token.
   */
  @Column({ nullable: true, select: false }) tokenHash: string | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
