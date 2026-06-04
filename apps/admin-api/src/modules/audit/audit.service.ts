import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditLogPayload {
  userId?: number;
  username?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  detail?: Record<string, any>;
  ip?: string;
  result?: 'success' | 'failure';
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async log(payload: AuditLogPayload): Promise<void> {
    const entry = this.repo.create({ ...payload, result: payload.result ?? 'success' });
    await this.repo.save(entry);
  }

  /** Q7: 每天凌晨 2:05 清理 180 天前的审计日志 */
  @Cron('0 5 2 * * *')
  async cleanupOldAuditLogs(): Promise<void> {
    const oneEightyDaysAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const result = await this.repo.delete({ createdAt: LessThan(oneEightyDaysAgo) });
    if (result.affected && result.affected > 0) {
      // Log the cleanup itself — but don't create an audit log entry to avoid recursion
      console.log(`[AuditService] Q7 Cleanup: removed ${result.affected} audit logs older than 180 days`);
    }
  }

  async findAll(options: {
    page?: number;
    pageSize?: number;
    action?: string;
    resource?: string;
    userId?: number;
  }): Promise<{ data: AuditLog[]; total: number }> {
    const { page = 1, pageSize = 20, action, resource, userId } = options;
    const qb = this.repo.createQueryBuilder('log').orderBy('log.createdAt', 'DESC');
    if (action) qb.andWhere('log.action ILIKE :action', { action: `%${action}%` });
    if (resource) qb.andWhere('log.resource = :resource', { resource });
    if (userId) qb.andWhere('log.userId = :userId', { userId });
    // Q12: cap pageSize to prevent full-table scans regardless of caller input
    const safePageSize = Math.min(pageSize, 100);
    const [data, total] = await qb
      .skip((page - 1) * safePageSize)
      .take(safePageSize)
      .getManyAndCount();
    return { data, total };
  }
}
