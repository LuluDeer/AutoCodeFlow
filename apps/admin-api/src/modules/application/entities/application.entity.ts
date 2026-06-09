import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Task } from '../../task/entities/task.entity';

export enum ApplicationStatus {
  ACTIVE = 'active',
  DEPLOYING = 'deploying',
  FAILED = 'failed',
}

@Entity('applications')
export class Application {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ unique: true }) name: string;

  @Column({ nullable: true }) description: string;

  @Column() version: string;

  @Column() runtime: string;

  @Column({ type: 'enum', enum: ApplicationStatus, default: ApplicationStatus.ACTIVE })
  status: ApplicationStatus;

  @Column({ nullable: true }) gitRepo: string;

  @Column({ nullable: true }) gitBranch: string;

  @Column({ nullable: true }) gitCommit: string;

  @Column({ type: 'jsonb', nullable: true }) manifest: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true }) env: Record<string, string>;

  @Column({ nullable: true }) entrypoint: string;

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;

  @OneToMany('Task', 'application')
  tasks: any[];
}