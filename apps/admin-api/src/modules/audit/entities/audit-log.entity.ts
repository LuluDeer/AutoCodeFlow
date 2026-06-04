import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

@Entity('audit_logs')
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

  @Column({ type: 'jsonb', nullable: true })
  detail: Record<string, any>;

  @Column({ nullable: true })
  ip: string;

  @Column({ default: 'success' })
  result: string;

  @CreateDateColumn()
  @Index()
  createdAt: Date;
}
